import test from 'node:test';
import assert from 'node:assert/strict';
import {submissionStep as step,submissionControls} from './submission.ts';
import type {SubmissionEvent} from './submission.ts';
import {createApplicationClient} from './client.ts';
test('oversized UTF-8 payloads never dispatch; wrong receipt IDs never resolve the draft',async()=>{
  let calls=0;const client=createApplicationClient('http://localhost',{fetch:async()=>Response.json(++calls===1?{contractId:'c',contract:{}}:{contractId:'c',submissionId:'wrong',status:'committed'})});
  await client.contract();const body={actor:'person',action:'reserve',args:{note:'❄'.repeat(6000)},submissionId:'expected'};
  await assert.rejects(client.execute(body),e=>e instanceof Error&&'notSubmitted' in e&&e.notSubmitted===true);assert.equal(calls,1);
  body.args.note='ok';await assert.rejects(client.execute(body),/identity mismatch/);assert.equal(calls,2);
});
test('a lost response locks resubmission; absence permits replay only of the captured command',()=>{
  const body={actor:'person',action:'reserve',args:{units:2}};
  const sent=step({phase:'editing'},{type:'submit',id:'one',body});
  body.args.units=3;
  const unknown=step(sent,{type:'lost'});assert.deepEqual(submissionControls(unknown),{submit:false,check:true,retry:false});
  const invalid: SubmissionEvent[]=[{type:'submit',id:'two',body},{type:'retry'},{type:'missing'},{type:'found',result:{status:'committed'}}];
  for(const event of invalid)assert.throws(()=>step(unknown,event));
  const checking=step(unknown,{type:'check'});
  assert.deepEqual(step(checking,{type:'lost'}),unknown);
  const retry={type:'retry',id:'two',body} as const;
  const retried=step(step(checking,{type:'missing'}),retry);
  assert.deepEqual(retried,sent);assert.equal(retried.body?.args.units,2);
  for(const status of ['pending','committed','rejected']){
    const receipt={status};assert.deepEqual(step(checking,{type:'found',result:receipt}),step(retried,{type:'found',result:receipt}));
  }
});
