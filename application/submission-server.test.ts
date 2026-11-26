import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {createApplicationServer} from './server.ts';
import {fixture} from './fixture.ts';

const actor='nora',action='supply.take',args={cabinetKey:'tools',quantity:1,reason:'Repair',tracked:true};
async function post(url:string,kind:string,body:object,status=200){
  const response=await fetch(`${url}/api/${kind.includes('/')?kind:`actions/${kind}`}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
}
async function setup(t:TestContext){
  const directory=await mkdtemp('/tmp/opencode/submissions-'),servers: Awaited<ReturnType<typeof createApplicationServer>>[]=[];
  t.after(async()=>{for(const s of servers)await s.close();await rm(directory,{recursive:true,force:true});});
  async function start(){const s=await createApplicationServer(fixture,{directory});servers.push(s);return s;}
  return {directory,start,server:await start()};
}

test('HTTP command validation cannot publish an update or change the durable snapshot',async t=>{
  await assert.rejects(createApplicationServer(fixture),/storage directory required/);
  const {server:{url}}=await setup(t);
  const snapshot=async()=>await (await fetch(url+'/api/snapshot')).json();
  const before=await snapshot();
  for(const [init,status,message] of [
    [{method:'POST',body:'{}'},415,/Expected JSON/],
    [{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(17000)},413,/Request too large/],
    [{method:'POST',headers:{origin:'http://localhost:2'}},403,/Cross-origin/],
    [{method:'POST',headers:{'sec-fetch-site':'cross-site'}},403,/Cross-site/],
  ] satisfies [RequestInit,number,RegExp][]){
    const response=await fetch(url+'/api/actions/execute',init);
    assert.equal(response.status,status);
    assert.match((await response.json()).error,message);
  }
  const invalid=await post(url,'execute',{actor,action,args:{...args,notAnInput:true}},400);
  assert.match(invalid.error,/Unsupported or missing configuration members/);
  const absent=await post(url,'approvals/resume',{actor,requestId:'missing'},404);
  assert.match(absent.error,/Request not found/);
  assert.deepEqual(await snapshot(),before);
});

test('application serves the built assets and ends its event stream on idempotent close',async t=>{
  const {server}=await setup(t);
  for(const [path,type] of [['/','text/html'],['/style.css','text/css'],['/app.js','text/javascript']] as const){
    const response=await fetch(server.url+path);
    assert.equal(response.status,200);
    assert.ok(response.headers.get('content-type')?.startsWith(type));
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.ok((await response.text()).length>0);
  }
  const response=await fetch(server.url+'/api/events');
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type')??'',/^text\/event-stream/);
  const reader=response.body?.getReader();
  assert.ok(reader);
  const first=await reader.read();
  assert.match(new TextDecoder().decode(first.value),/^event: update\ndata: /);
  await server.close();
  await server.close();
  const ended=await reader.read().then(result=>result.done,()=>true);
  assert.equal(ended,true);
});

test('pending and rejected submissions survive restart; reconcile returns original evidence with current snapshot',async t=>{
  const {start,server}=await setup(t),id={actor,submissionId:'pending'},body={...id,action,args:{...args,quantity:2}};
  const missing=await post(server.url,'reconcile',id);
  const invalid=await post(server.url,'execute',{...body,args:{...body.args,unrecognised:true}},400);
  assert.equal(invalid.disposition,'not-submitted');assert.equal(invalid.submissionId,id.submissionId);
  assert.deepEqual(await post(server.url,'reconcile',id),missing);
  const pending=await post(server.url,'execute',body);
  assert.deepEqual(missing,{status:'not-found',contractId:pending.contractId,submissionId:id.submissionId});
  await post(server.url,'execute',{...body,submissionId:'stale-contract',expectedContractId:'previous'},409);
  assert.equal((await post(server.url,'reconcile',{actor,submissionId:'stale-contract'})).status,'not-found');
  assert.equal(pending.status,'pending');
  const bad={...body,submissionId:'bad',args:{...args,cabinetKey:'absent'}};
  const rejection=await post(server.url,'execute',bad);
  assert.equal(rejection.status,'rejected');
  const requestId=pending.evidence.invocation.id;
  await post(server.url,'approvals/grant',{actor:'quinn',requestId,policyId:pending.requirements[0].policyId});
  const resumed=await post(server.url,'approvals/resume',{actor:'quinn',requestId});
  assert.equal(resumed.status,'committed');
  await server.close();
  const {url}=await start();
  assert.deepEqual(await post(url,'reconcile',id),{...pending,snapshot:resumed.snapshot});
  assert.deepEqual(await post(url,'execute',body),{...pending,snapshot:resumed.snapshot});
  assert.deepEqual(await post(url,'reconcile',{actor,submissionId:'bad'}),{...rejection,snapshot:resumed.snapshot});
  assert.deepEqual(await post(url,'execute',bad),{...rejection,snapshot:resumed.snapshot});
  await post(url,'execute',{...body,args},409);
  await post(url,'execute',{...body,action:'other'},409);
  for(const kind of ['execute','reconcile']){
    await post(url,kind,{...(kind==='execute'?body:id),actor:'quinn'},403);
    for(const submissionId of [null,{},'', 'x'.repeat(201)])await post(url,kind,{...(kind==='execute'?body:id),submissionId},400);
  }
  assert.deepEqual((await post(url,'reconcile',id)).snapshot,resumed.snapshot);
});

test('failure to record submission identity rolls back the invocation, outbox and mutation together',async t=>{
  const {server:{url},directory}=await setup(t),body={actor,action,args,submissionId:'rollback'};
  const db=new DatabaseSync(join(directory,'application.sqlite'));
  try{
    db.exec(`CREATE TRIGGER fail_binding BEFORE INSERT ON application_submissions BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
    await post(url,'execute',body,500);
    assert.equal((await post(url,'reconcile',{actor,submissionId:body.submissionId})).status,'not-found');
    assert.equal(db.prepare('SELECT count(*) n FROM durable_invocations').get()?.['n'],0);
    assert.equal(db.prepare('SELECT count(*) n FROM durable_outbox').get()?.['n'],0);
    db.exec('DROP TRIGGER fail_binding');
    const result=await post(url,'execute',body);
    assert.equal(result.snapshot.state.records.cabinet.tools.values.stock,7);
  }finally{db.close();}
});

test('independent SQLite connections race a stable submission; only one invocation, mutation and event group',async t=>{
  const {server,directory}=await setup(t);
  // Separate event loops so the synchronous SQLite writers can actually contend.
  const code=`
    import {parentPort,workerData} from 'node:worker_threads';
    import {createApplicationServer} from ${JSON.stringify(new URL('./server.ts',import.meta.url).href)};
    import {fixture} from ${JSON.stringify(new URL('./fixture.ts',import.meta.url).href)};
    const server=await createApplicationServer(fixture,{directory:workerData});
    parentPort.postMessage(server.url);
    parentPort.once('message',async()=>{await server.close();parentPort.close();});
  `;
  const worker=new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`),{workerData:directory});
  const [peer]=await once(worker,'message');
  t.after(async()=>{const ended=once(worker,'exit');worker.postMessage('close');await ended;});
  const body={actor,action,args,submissionId:'race'};
  const [a,b]=await Promise.all([post(server.url,'execute',body),post(peer,'execute',body)]);
  assert.equal(a.status,'committed');assert.deepEqual(a,b);
  assert.equal(a.snapshot.state.records.cabinet.tools.values.stock,7);
  assert.deepEqual(await post(peer,'reconcile',{actor,submissionId:'race'}),a);
  const db=new DatabaseSync(join(directory,'application.sqlite'),{readOnly:true});
  try{
    assert.equal(db.prepare('SELECT count(*) n FROM durable_invocations').get()?.['n'],1);
    assert.equal(db.prepare('SELECT count(*) n FROM durable_outbox').get()?.['n'],a.evidence.outcome.events.length);
  }finally{db.close();}
  const legacy=await post(server.url,'execute',{actor,action,args});
  assert.notEqual(legacy.evidence.invocation.id,a.evidence.invocation.id);
  assert.equal(legacy.snapshot.state.records.cabinet.tools.values.stock,6);
});
