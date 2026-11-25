import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodeJson,ActionEventsTraceSchema} from '../adapters/effect/json.ts';
import declaration from '../leave/model.ts';
import {buildInvocation,deriveApplication} from './derive.ts';
import {actionReview,exampleArgs} from './action-review.ts';
import {walkthrough} from './action-walkthrough.ts';
import {fixture} from './fixture.ts';

test('new inbox evidence cannot unlock a captured submission; original receipt remains historical after completion',async()=>{
  const actor='nora',action='supply.take';
  const fold=actionReview(deriveApplication(fixture).contract,actor,action),steps: ReturnType<typeof fold>[]=[];
  for await(const event of walkthrough(fixture,{actor,action,args:{cabinetKey:'tools',quantity:2,reason:'Repair',tracked:true}}))steps.push(fold(event));
  const beforeLoss=steps.find(s=>s.event==='snapshot'&&s.inbox.length);
  assert.ok(beforeLoss);
  assert.equal(beforeLoss.submission,'submitting');assert.equal(beforeLoss.receipt,null);
  const visible=steps.find(s=>s.event==='snapshot'&&s.inbox.length&&s.submission==='unknown');
  assert.ok(visible);
  assert.equal(visible.submission,'unknown');assert.equal(visible.controls.submit,false);
  assert.equal(visible.controls.check,true);assert.equal(visible.receipt,null);
  const last=steps.at(-1);
  assert.ok(last?.receipt&&last.evidence);
  assert.deepEqual(last.draft,visible.draft);assert.equal(last.receipt.status,'pending');
  assert.equal(last.evidence.status,'committed');assert.equal(last.inbox.length,0);
  const [pending]=visible.inbox;
  assert.ok(pending);
  assert.equal(last.receipt.invocationId,pending.id);
});

test('inspector records and replays a durable rejection when a reference has no default',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'action-review-empty-reference-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const entry=join(directory,'empty.domain'),record=join(directory,'trace.json');
  const source=await readFile(new URL('../syntax/fixtures/schema-groups.domain',import.meta.url),'utf8');
  await writeFile(entry,source.replace('key string','key reference supply as item')
    .replace('  bindings\n    item from supply key input.key\n  end\n','')
    .replace(/    record depot version 0\n[\s\S]*?    end\n/,''));
  const inspect=(...args:string[])=>spawnSync(process.execPath,['application/inspect-action.ts',entry,'supply.adjust','--actor','sam',...args],{encoding:'utf8'});
  const live=inspect('--record',record);
  assert.equal(live.status,0,live.stderr);
  const trace=decodeJson(ActionEventsTraceSchema,await readFile(record,'utf8'));
  assert.deepEqual(trace.args,{balance:0,status:'ready'});
  assert.deepEqual(trace.events.find(event=>event['type']==='draft')?.['body'],{
    actor:'sam',action:'supply.adjust',args:{balance:0,status:'ready'},
  });
  const receipt=trace.events.find(event=>event['type']==='receipt')?.['result'];
  assert.ok(receipt&&typeof receipt==='object'&&'status' in receipt&&'code' in receipt);
  assert.equal(receipt['status'],'rejected');
  assert.equal(receipt['code'],'invalid');
  const replay=inspect('--replay',record);
  assert.equal(replay.status,0,replay.stderr);
  assert.match(replay.stdout,/rejected/);
});

test('approval examples are derived from visible inputs without changing the initial state',()=>{
  const derived=deriveApplication(declaration),action='leave.request',actor='maya';
  const before=structuredClone(derived.initialState);
  const example=exampleArgs(derived,action,actor);
  assert.match(example.selection,/found approval-required inputs/);
  assert.deepEqual(Object.keys(example.args).sort(),['end','start']);
  const invocation=buildInvocation(derived.contract,{action,actor,args:example.args,id:'test-review',clock:0});
  const result=derived.runtime.prepare(derived.initialState,invocation);
  assert.equal(result.status,'pending');
  assert.deepEqual(derived.initialState,before);
});

test('bounded search can find an approval controlled by a checkbox or enum',()=>{
  const action='supply.take',actor='nora';
  for(const [name,value] of [['tracked',true],['reason','Repair']] as const){
    const model=structuredClone(fixture);
    const [direct,approval]=model.domain.actions[action].policies;
    direct.when={op:'literal',value:false};
    approval.when={op:'eq',left:{op:'input',name},right:{op:'literal',value}};
    const selected=exampleArgs(deriveApplication(model),action,actor);
    assert.match(selected.selection,/found approval-required inputs/);
    assert.deepEqual(selected.args,{cabinetKey:'tools',quantity:1,reason:'Workshop',tracked:false,[name]:value});
  }
});

test('no candidate found is reported as a bounded search, not as unreachable approval',()=>{
  const model=structuredClone(fixture),action='supply.take';
  model.domain.actions[action].policies.pop();
  const {args,selection}=exampleArgs(deriveApplication(model),action,'nora');
  assert.match(selection,/bounded preview did not find an approval example/);
  assert.deepEqual(args,{cabinetKey:'tools',quantity:1,reason:'Workshop',tracked:false});
});

test('walkthrough unlocks an invalid draft without creating an execution receipt',async()=>{
  const action='leave.request',actor='maya',args={start:'2026-11-21',end:'2026-11-22'};
  const fold=actionReview(deriveApplication(declaration).contract,actor,action),steps=[];
  for await(const event of walkthrough(declaration,{action,actor,args}))steps.push(fold(event));
  assert.deepEqual(steps.map(s=>s.event),['snapshot','draft','submit','invalid']);
  const last=steps.at(-1);
  assert.match(last.message,/at least one weekday/);
  assert.equal(last.submission,'editing');
  assert.equal(last.controls.submit,true);
  assert.equal(last.receipt,null);
  assert.equal(last.snapshotVersion,steps[0].snapshotVersion);
});

test('walkthrough stops at the original pending receipt when no approver is selectable',async()=>{
  const model=structuredClone(fixture);
  model.application.actors=model.application.actors.filter(actor=>actor.id==='nora');
  const action='supply.take',actor='nora',args={cabinetKey:'tools',quantity:2,reason:'Repair',tracked:true};
  const fold=actionReview(deriveApplication(model).contract,actor,action),steps=[];
  for await(const event of walkthrough(model,{action,actor,args}))steps.push(fold(event));
  const last=steps.at(-1);
  assert.equal(last.event,'blocked');
  assert.match(last.message,/No selectable approver for supply\.review/);
  assert.equal(last.receipt.status,'pending');
  assert.equal(last.inbox[0].id,last.receipt.invocationId);
  assert.deepEqual(last.inbox[0].grants,[]);
  assert.equal(last.views[0].records[0].fields.stock,8);
});
