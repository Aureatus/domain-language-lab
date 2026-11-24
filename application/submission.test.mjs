import test from 'node:test';
import assert from 'node:assert/strict';
import {submissionStep as step,submissionControls} from './submission.mjs';
import {createApplicationClient} from './client.mjs';
test('oversized UTF-8 payloads never dispatch; wrong receipt IDs never resolve the draft',async()=>{
  let calls=0;const client=createApplicationClient('http://localhost',{fetch:async()=>{calls++;return Response.json({contractId:'c',submissionId:'wrong',status:'committed'});}});
  await client.contract();const body={actor:'person',action:'reserve',args:{note:'❄'.repeat(6000)},submissionId:'expected'};
  await assert.rejects(client.execute(body),e=>e.notSubmitted===true);assert.equal(calls,1);
  body.args.note='ok';await assert.rejects(client.execute(body),/identity mismatch/);assert.equal(calls,2);
});
test('a lost response locks resubmission; absence permits replay only of the captured command',()=>{
  const body={actor:'person',action:'reserve',args:{units:2}};
  const sent=step({phase:'editing'},{type:'submit',id:'one',body});
  body.args.units=3;
  const unknown=step(sent,{type:'lost'});assert.deepEqual(submissionControls(unknown),{submit:false,check:true,retry:false});
  for(const type of ['submit','retry','missing','found'])assert.throws(()=>step(unknown,{type}));
  const checking=step(unknown,{type:'check'});
  assert.deepEqual(step(checking,{type:'lost'}),unknown);
  const retried=step(step(checking,{type:'missing'}),{type:'retry',id:'two',body});
  assert.deepEqual(retried,sent);assert.equal(retried.body.args.units,2);
  for(const status of ['pending','committed','rejected']){
    const receipt={status};assert.deepEqual(step(checking,{type:'found',result:receipt}),step(retried,{type:'found',result:receipt}));
  }
});
