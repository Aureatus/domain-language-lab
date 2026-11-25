import test from 'node:test';
import assert from 'node:assert/strict';
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
