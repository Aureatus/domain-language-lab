import {test} from 'node:test';
import './submission.test.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplicationServer} from '../../application/server.mjs';
import declaration from '../../leave/model.mjs';
import {generate,writeAdapter} from './generate.mjs';
import {createClient} from './client.mjs';
import {renamedFixture} from '../../application/fixture.mjs';
import {deriveApplication} from '../../application/derive.mjs';
import loadingFixture from './loading-fixture.mjs';

async function scratch(t,prefix){
  const directory=await mkdtemp(join(tmpdir(),prefix));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return directory;
}

test('each Exact placeholder follows its view; waiting never suppresses another view',()=>{
  const contract=structuredClone(deriveApplication(loadingFixture).contract),render=()=>generate({contract,contractId:'fixture'}).contract;
  const output=render();
  assert.match(output,/progress .*aria-label="Loading Record group 0…" testId="loading:0:icon"/);
  assert.match(output,/text "Loading Record group 1…" role="status"/);
  assert.match(output,/column role="status" aria-label="Loading Record group 2…".*\n +box /);
  assert.doesNotMatch(output,/Loading Record group 3|loading:3:/);
  contract.views.forEach(v=>{v.loading='wait';});
  assert.doesNotMatch(render(),/testId="loading:/);
  assert.match(render(),/testId="screen-failed"/);
});

test('generated Exact mapping uses real durable HTTP pending, grants, resume and balance',async t=>{
  const directory=await scratch(t,'exact-mapping-');
  const server=await createApplicationServer(declaration,{directory});
  try{
    const envelope=await(await fetch(server.url+'/api/contract')).json();
    const c=createClient(envelope,server.url);await c.snapshot();
    const output=generate(envelope,{api:server.url});
    assert.ok(output.contract.includes('saveGrant(actor, id, policy)'));
    assert.ok(output.manifest.sourceMap.some(m=>m.semanticId==='action:leave.request'));
    assert.ok(!output.ts.includes('balance -'));
    assert.ok(!output.ts.includes('days >='));
    await writeAdapter(envelope,'artifacts/exact-app',{api:'http://127.0.0.1:4186'});
    const balance=()=>c.snapshot().then(s=>s.state.records.employee.maya.values.balance);
    const start=await balance();
    const request={actor:'maya',action:'leave.request',args:{start:'2026-11-23',end:'2026-11-25'}};
    const preview=await c.request('actions/preview',request);assert.equal(preview.status,'pending');
    const execute=await c.command('actions/execute',request);assert.equal(execute.ok,true);assert.equal(await balance(),start);
    let s=await c.snapshot();const p=s.pending.at(-1),r=p.requirements[0],approver=r.approvers[0];
    assert.equal(c.project(s,'maya').inbox[0].complete,false);
    assert.equal(c.project(s,approver).inbox[0].grants[0].eligible,true);
    const grant=await c.command('approvals/grant',{actor:approver,requestId:p.id,policyId:r.policyId});assert.equal(grant.ok,true);assert.equal(await balance(),start);
    assert.equal(c.project(await c.snapshot(),approver).inbox[0].complete,true);
    const resume=await c.command('approvals/resume',{actor:approver,requestId:p.id});assert.equal(resume.ok,true);assert.equal(await balance(),start-3);
    assert.equal(c.project(await c.snapshot(),approver).inbox.length,0);
    const duplicate=await c.command('approvals/resume',{actor:approver,requestId:p.id});assert.equal(duplicate.ok,false);assert.match(duplicate.message,/Approval is saved, but completion failed/);
    await c.request('actions/execute',{...request,actor:'leo'});
    const staleRequest=(await c.snapshot()).pending.at(-1);
    await c.request('approvals/grant',{actor:approver,requestId:staleRequest.id,policyId:r.policyId});
    await c.request('actions/execute',{actor:approver,action:'settings.change',args:{threshold:4}});
    const stale=await c.command('approvals/resume',{actor:approver,requestId:staleRequest.id});
    assert.equal(stale.ok,false);assert.match(stale.message,/Approval is saved, but completion failed/);
    const retained=(await c.snapshot()).pending.at(-1);assert.equal(retained.grants.length,1);assert.equal(retained.stale,true);
    assert.equal((await c.snapshot()).state.records.employee.leo.values.balance,5);
    const bad=structuredClone(envelope);bad.contract.actions['leave.request'].fields.find(f=>!f.hidden).schema.type='ids';assert.throws(()=>generate(bad,{api:server.url}),/Unsupported field/);
    const mismatch=createClient({...envelope,contractId:'wrong'},server.url);await assert.rejects(()=>mismatch.snapshot(),/Declaration changed/);
    const offline=createClient(envelope,server.url,async()=>{throw Error('offline');});const failure=await offline.command('approvals/resume',{});assert.equal(failure.ok,false);assert.match(failure.message,/ambiguous outcome/);
    await writeFile('artifacts/exact-http-report.json',JSON.stringify({format:'exact-http-mapping/v1',contractId:envelope.contractId,initialBalance:start,pendingBalance:start,grantBalance:start,resumedBalance:start-3,preview:preview.status,requestId:p.id,grant:grant.message,resume:resume.message,duplicate:duplicate.message,staleCompletion:stale.message,staleGrantRetained:retained.grants.length===1,staleBalance:5,scope:'Real HTTP/SQLite mapping test, not Exact UI or native execution.'},null,2));
  }finally{await server.close();}
});

test('renamed non-leave schemas generate references, enums, integers and booleans',async t=>{
  const server=await createApplicationServer(renamedFixture(),{directory:await scratch(t,'exact-fixture-')});
  try{
    const envelope=await(await fetch(server.url+'/api/contract')).json(),c=createClient(envelope,server.url);
    const generated=await writeAdapter(envelope,'artifacts/exact-fixture',{api:'http://127.0.0.1:4186'});
    assert.match(generated.contract,/type="checkbox"/);assert.match(generated.contract,/select value=/);assert.match(generated.ts,/Number\(v1\)/);
    assert.ok(!generated.ts.includes('leave.request'));
    const s=await c.snapshot(),args={...s.defaults.ari['kit.issue'],units:2};
    await c.request('actions/execute',{actor:'ari',action:'kit.issue',args});
    const p=(await c.snapshot()).pending[0];assert.equal(p.requirements[0].approvers[0],'devon');
    await c.request('approvals/grant',{actor:'devon',requestId:p.id,policyId:p.requirements.find(r=>r.approvers.includes('devon')).policyId});
    await c.request('approvals/resume',{actor:'devon',requestId:p.id});
    assert.equal((await c.snapshot()).state.records.rack.parts.values.remaining,6);
  }finally{await server.close();}
});

test('inbox coverage follows every captured server requirement, not a single manager assumption',async t=>{
  const model=renamedFixture(),policy=structuredClone(model.domain.actions['kit.issue'].policies[1]);
  policy.id='kit.second-review';policy.approvers={op:'literal',value:'ari'};policy.allowSelfApproval=true;model.domain.actions['kit.issue'].policies.push(policy);
  const server=await createApplicationServer(model,{directory:await scratch(t,'exact-multi-')});
  try{
    const envelope=await(await fetch(server.url+'/api/contract')).json(),c=createClient(envelope,server.url),s=await c.snapshot();
    await c.request('actions/execute',{actor:'ari',action:'kit.issue',args:{...s.defaults.ari['kit.issue'],units:2}});
    const p=(await c.snapshot()).pending[0];assert.equal(p.requirements.length,2);
    await c.request('approvals/grant',{actor:'devon',requestId:p.id,policyId:p.requirements[0].policyId});
    assert.equal(c.project(await c.snapshot(),'ari').inbox[0].complete,false);
    const incomplete=await c.command('approvals/resume',{actor:'ari',requestId:p.id});assert.equal(incomplete.ok,false);
    await c.request('approvals/grant',{actor:'ari',requestId:p.id,policyId:p.requirements.find(r=>r.approvers.includes('ari')).policyId});
    assert.equal(c.project(await c.snapshot(),'ari').inbox[0].complete,true);
    const complete=await c.command('approvals/resume',{actor:'ari',requestId:p.id});assert.equal(complete.ok,true);
    assert.equal((await c.snapshot()).state.records.rack.parts.values.remaining,6);
    await writeFile('artifacts/exact-multiple-requirements-report.json',JSON.stringify({requirements:p.requirements,oneGrantComplete:false,twoGrantsComplete:true,incompleteResume:incomplete,completeResume:complete,remaining:6,scope:'Real renamed fixture HTTP/SQLite run; self-approval explicitly declared in second test policy.'},null,2));
  }finally{await server.close();}
});

test('transport never overwrites a newer accepted snapshot with an older HTTP reply',async()=>{
  const contract={actors:[]},responses=[{contractId:'same',snapshotVersion:8,marker:'new'},{contractId:'same',snapshotVersion:7,marker:'old'},{contractId:'other',snapshotVersion:9}];
  const c=createClient({contract,contractId:'same'},'http://127.0.0.1:1',async()=>({ok:true,json:async()=>responses.shift()}));
  assert.equal((await c.snapshot()).marker,'new');assert.equal((await c.snapshot()).marker,'new');
  await assert.rejects(()=>c.snapshot(),/Declaration changed/);
});
