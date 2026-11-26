import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodeJson,ActionEventsTraceSchema} from '../adapters/effect/json.ts';
import {deriveApplication} from './derive.ts';
import {actionReview} from './action-review.ts';
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
