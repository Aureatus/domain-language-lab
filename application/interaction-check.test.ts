import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveApplication} from './derive.ts';
import {checkInteractions} from './interaction-check.ts';
import {fixture} from './fixture.ts';
import {actionReview} from './action-review.ts';
const {contract}=deriveApplication(fixture);
const command={action:'supply.take',actor:'nora',submissionId:'verify',args:{cabinetKey:'tools',quantity:2,reason:'Repair',tracked:true}};
test('interaction laws distinguish a fresh snapshot from a receipt across ordered deliveries',async()=>{
  const baseline=await checkInteractions(fixture,contract,command);
  assert.equal(baseline.status,'bounded-pass');assert.equal(baseline.approval,true);
  assert.deepEqual(baseline.families,['recorded','snapshot / recovery','refresh / reconciliation','late owner receipt']);
  const mutant={mutant:'snapshot-unlocks'},bad=await checkInteractions(fixture,contract,command,mutant);
  assert.equal(bad.status,'failed');assert.ok(bad.counterexample);assert.equal(bad.counterexample.rule,'submission.no-fresh-submit-before-receipt');
  const {events}=bad.counterexample;
  assert.deepEqual(events.map(e=>e.type),['snapshot','draft','submit','lost','snapshot']);
  const replay=(opts:Parameters<typeof actionReview>[3])=>{const fold=actionReview(contract,command.actor,command.action,opts);return events.map(fold).at(-1);};
  assert.equal(replay(mutant)?.controls.submit,true);assert.equal(replay({})?.controls.submit,false);
});
