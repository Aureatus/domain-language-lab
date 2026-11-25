import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClient,submissionDriver} from './client.ts';

test('only a bound 400 no-write disposition unlocks an Exact submission',async()=>{
  for(const fault of ['none','http','contract','id','disposition','json']){
    let calls=0;
    const client=createClient({contract:{},contractId:'c'},'http://127.0.0.1:1',async(_,options)=>{
      calls++;
      const {submissionId}=JSON.parse(options.body);
      return {ok:false,status:fault==='http'?500:400,json:async()=>{
        if(fault==='json')throw Error('invalid JSON');
        return {error:'Fix the input.',disposition:fault==='disposition'?'other':'not-submitted',
          contractId:fault==='contract'?'other':'c',submissionId:fault==='id'?'other':submissionId};
      }};
    });
    const driver=submissionDriver(client,'a','x');
    const result=await driver.run('submit',{n:7});
    assert.equal(result.phase,fault==='none'?'editing':'unknown',fault);
    if(fault==='none')assert.equal(result.message,'Fix the input.');
    await driver.run('submit',{n:8});assert.equal(calls,fault==='none'?2:1,fault);
  }
});
