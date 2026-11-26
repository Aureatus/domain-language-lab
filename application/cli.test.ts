import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplicationServer} from './server.ts';
import {createApplicationClient} from './client.ts';
import {deriveApplication} from './derive.ts';
import declaration from '../leave/model.ts';
import {present} from '../semantic/test-support.ts';
import {runCLI} from './cli.ts';
const exec=promisify(execFile);
async function cli(url:string,...args:string[]){
  const {stdout}=await exec(process.execPath,['application/cli.ts','--view','leave/cli.domain',...args,'--url',url,'--json']);return JSON.parse(stdout);
}
test('spawned CLI advances the same durable HTTP backend; grant/resume, duplicates, stale and reopen',async()=>{
  const directory=await mkdtemp('/tmp/opencode/cli-');let server=await createApplicationServer(declaration,{directory});
  const args=JSON.stringify({start:'2026-11-23',end:'2026-11-25'});
  try{
    const list=await cli(server.url,'list');assert.ok(list.some((a:{id:string})=>a.id==='leave.request'));
    assert.deepEqual(list.find((a:{id:string})=>a.id==='leave.request').arguments.map((a:{name:string})=>a.name),['start','end']);
    const action=await cli(server.url,'inspect','leave.request');assert.equal(action.fields.find((f:{name:string})=>f.name==='days').hidden,true);
    const sources=await mkdtemp('/tmp/opencode/cli-views-');
    for(const name of ['time-away','demo','cli'])await copyFile(`leave/${name}.domain`,`${sources}/${name}.domain`);
    const domain=await readFile(`${sources}/time-away.domain`,'utf8');
    await writeFile(`${sources}/time-away.domain`,domain.replace('employee.balance - days','employee.balance + days'));
    await assert.rejects(exec(process.execPath,['application/cli.ts','execute','leave.request','--actor','maya','--args',args,'--url',server.url,'--view',`${sources}/cli.domain`]),/domain differs from the backend/);
    assert.equal((await cli(server.url,'inbox')).length,0);
    await assert.rejects(cli(server.url,'execute','leave.request','--args',args),/explicit --actor/);
    assert.equal((await cli(server.url,'preview','leave.request','--actor','maya','--args',args)).status,'pending');
    assert.equal((await cli(server.url,'execute','leave.request','--actor','maya','--args',args)).status,'pending');
    let [p]=await cli(server.url,'inbox','--actor','sam');assert.equal(p.invocation.actor,'maya');
    assert.equal((await cli(server.url,'grant',p.id,'--actor','sam','--policy',p.requirements[0].policyId)).status,'approved');
    const client=createApplicationClient(server.url);await client.contract();
    const balance=async()=>present(present((await client.snapshot()).state.records['employee'])['maya']).values['balance'];
    assert.equal(await balance(),5);
    assert.equal((await cli(server.url,'resume',p.id,'--actor','sam')).status,'committed');
    assert.equal(await balance(),2);
    assert.equal((await cli(server.url,'resume',p.id,'--actor','sam')).code,'consumed');
    await cli(server.url,'execute','leave.request','--actor','leo','--args',args);
    p=(await cli(server.url,'inbox','--actor','leo')).find((p:{status:string})=>p.status==='pending');
    await cli(server.url,'grant',p.id,'--actor','sam','--policy',p.requirements[0].policyId);
    assert.equal((await cli(server.url,'execute','settings.change','--actor','sam','--args','{"threshold":2}')).status,'committed');
    assert.equal((await cli(server.url,'resume',p.id,'--actor','sam')).code,'stale');
    assert.equal((await cli(server.url,'list','employee')).leo.values.balance,5);
    await server.close();server=await createApplicationServer(declaration,{directory});
    assert.equal((await cli(server.url,'list','employee')).maya.values.balance,2);
    assert.equal((await cli(server.url,'inbox','--actor','leo')).find((x:{id:string})=>x.id===p.id).grants.length,1);
  }finally{await server.close();}
});
test('shared client fails closed on contract mismatch',async()=>{
  const {contract}=deriveApplication(declaration);
  let calls=0;const client=createApplicationClient('http://127.0.0.1:1',{fetch:async()=>Response.json({contractId:++calls===1?'a':'b',contract})});
  await client.contract();await assert.rejects(client.snapshot(),/contract changed/);
});

test('shared client rejects malformed contracts, snapshots and receipts at the transport boundary',async()=>{
  const {contract}=deriveApplication(declaration);
  let body:object={contractId:'c',contract:{...contract,actors:[{id:'maya'}]}};
  const client=createApplicationClient('http://127.0.0.1:1',{fetch:async()=>Response.json(body)});
  await assert.rejects(client.contract(),/Invalid application contract/);
  body={contract};
  await assert.rejects(client.contract(),/Invalid application contract/);
  body={contractId:'c',contract};
  assert.deepEqual(await client.contract(),body);
  body={contractId:'c',snapshotVersion:'0',state:{revision:0,records:{}},pending:[],defaults:{},availability:{}};
  await assert.rejects(client.snapshot(),/snapshotVersion/);
  const preview={actor:'maya',action:'leave.request',args:{start:'2026-11-23',end:'2026-11-23'}};
  body={contractId:'c'};
  await assert.rejects(client.preview(preview),/Invalid application receipt/);
  body={contractId:'c',status:'pending',requirements:[{policyId:'approval',approvers:[7],allowSelfApproval:false}]};
  await assert.rejects(client.preview(preview),/approvers/);
});

test('CLI rejects ambiguous arguments before connecting',async()=>{
  const output:string[]=[];
  const run=(...args:string[])=>runCLI(args,{stdout:(line:string)=>output.push(line)});
  await run();
  await run('list','--help');
  assert.equal(output.length,2);
  assert.ok(output.every(line=>line.startsWith('Usage:')));
  for(const [argv,message] of [
    [['list','--not-an-option','value'],/Unknown or missing option/],
    [['list','--url'],/Unknown or missing option/],
    [['list','--url','--json'],/Unknown or missing option/],
    [['list','--url','http://localhost','--url','http://localhost'],/Duplicate option/],
    [['list','employee','leave'],/Usage:/],
    [['unknown'],/Usage:/],
    [['execute','--actor','maya'],/requires an ID/],
    [['inspect','--submission-id','one'],/applies only to execute/],
    [['grant','one','--actor','sam'],/requires --policy/],
  ] satisfies [string[],RegExp][]){
    await assert.rejects(run(...argv),message);
  }
  assert.equal(output.length,2);
});

test('CLI distinguishes an input rejection from an ambiguous write and reconciles the original ID',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'premise-cli-recovery-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const server=await createApplicationServer(declaration,{directory});
  t.after(()=>server.close());
  const output:string[]=[];
  const run=(...args:string[])=>runCLI([...args,'--url',server.url],{stdout:(line:string)=>output.push(line)});
  await run('list');
  assert.match(present(output.pop()),/leave\.request.*\n  arguments: start: string, end: string/);
  await run('inspect');
  assert.equal(JSON.parse(present(output.pop())).format,'derived-application/v1');
  await assert.rejects(run('list','missing'),/Unknown resource/);
  await assert.rejects(run('inspect','missing'),/Unknown action/);
  await assert.rejects(run('list','--view','leave/time-away.domain'),/must select a view module/);
  await assert.rejects(run('preview','missing','--actor','maya'),/Use list or inspect/);
  await assert.rejects(run('preview','leave.request','--actor','maya','--args','[]'),/--args must be a JSON object/);
  const execute=(args?:object)=>run('execute','leave.request','--actor','maya','--submission-id','original',
    ...(args===undefined?[]:['--args',JSON.stringify(args)]));
  await assert.rejects(execute(),error=>{
    assert.match(String(error),/Choose valid dates/);
    assert.doesNotMatch(String(error),/with reconcile/);
    return true;
  });
  await run('reconcile','original','--actor','maya');
  assert.equal(JSON.parse(present(output.pop())).status,'not-found');
  await execute({start:'2026-11-23',end:'2026-11-23'});
  assert.match(present(output.pop()),/Status: committed\nSubmission: original\nRevision: 1/);
  await assert.rejects(execute({start:'2026-11-24',end:'2026-11-24'}),/Check submission original with reconcile before retrying/);
  await run('reconcile','original','--actor','maya');
  assert.match(present(output.pop()),/Original submission outcome: Saved[\s\S]*Revision: 1/);
});
