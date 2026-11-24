import test from 'node:test';
import assert from 'node:assert/strict';
import {runGenerated} from './generated.mjs';
import {readFile} from 'node:fs/promises';

test('fixed-seed generated live histories exercise every action and failure class',()=>{
  const report=runGenerated({seed:0x51eed,runs:40,maxSteps:80});
  assert.equal(report.status,'sampled_pass');
  assert.ok(report.actionsExecuted>0);
  for(const count of Object.values(report.coverage.actions)) assert.ok(count>0);
  for(const count of Object.values(report.coverage.acceptedActions)) assert.ok(count>0);
  assert.ok(report.coverage.denials>0);
  assert.ok(report.coverage.rejections>0);
  assert.ok(report.coverage.ruleEdits>0);
  assert.ok(report.coverage.invalidReferences>0);
  for(const count of Object.values(report.coverage.notificationPaths)) assert.ok(count>0);
});

test('snapshot oracle detects nested corruption when deep freeze is deliberately removed',async()=>{
  const source = await readFile(new URL('./core.mjs',import.meta.url),'utf8');
  const weakened=source.replace('Object.values(value).forEach(freeze);','');
  assert.notEqual(weakened,source);
  const coreURL='data:text/javascript;base64,'+Buffer.from(weakened).toString('base64');
  const runner=(await readFile(new URL('./generated.mjs',import.meta.url),'utf8')).replace("'./core.mjs'",JSON.stringify(coreURL));
  const {runGenerated:run}=await import('data:text/javascript;base64,'+Buffer.from(runner).toString('base64'));
  const report=run({runs:2,maxSteps:30,wrapper:{dispatch(action,args,actor){
    const old=this.state;const result=this.dispatch(action,args,actor);
    old.users[0].name='Corrupted old snapshot';
    return result;
  }}});
  assert.equal(report.status,'counterexample');
  assert.match(report.counterexample.why,/snapshot lost immutability/);
});

test('independent checker detects deliberate wrong-route mutator',()=>{
  const report=runGenerated({seed:47,runs:40,maxSteps:80,wrapper:{dispatch(action,args,actor){
    const result=this.dispatch(action,args,actor);
    return result.ok ? {...result,event:{...result.event,recipients:[...result.event.recipients,{recipient:'u3',reasons:['watchers'],paths:[]}]}} : result;
  }}});
  assert.equal(report.status,'counterexample');
  assert.match(report.counterexample.why,/route/);
  assert.ok(report.counterexample.history.length>0);
});

test('independent checker detects policy decision mutator',()=>{
  const report=runGenerated({seed:19,runs:2,maxSteps:25,wrapper:{dispatch(action,args,actor){
    const result=this.dispatch(action,args,actor);
    return result.ok===false && /not allowed/.test(result.reason) ? {ok:true} : result;
  }}});
  assert.equal(report.status,'counterexample');
  assert.match(report.counterexample.why,/expected ok/);
});
