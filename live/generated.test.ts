import test from 'node:test';
import assert from 'node:assert/strict';
import {runGenerated} from './generated.ts';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {createApp} from './core.ts';

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
  const source = await readFile(new URL('./core.ts',import.meta.url),'utf8');
  const weakened=source.replace('Object.values(value).forEach(freeze);','');
  assert.notEqual(weakened,source);
  const coreURL='data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(weakened)).toString('base64');
  const generated=await readFile(new URL('./generated.ts',import.meta.url),'utf8');
  const runner=generated.replace(/(['"])\.\/core\.ts\1/,JSON.stringify(coreURL));
  assert.notEqual(runner,generated);
  const {runGenerated:run}: {runGenerated:typeof runGenerated}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(runner)).toString('base64'));
  const report=run({runs:2,maxSteps:30,wrapper:{dispatch(this: ReturnType<typeof createApp>,action,args,actor){
    const old=this.state;const result=this.dispatch(action,args,actor);
    const user=old.users[0];assert.ok(user);user.name='Corrupted old snapshot';
    return result;
  }}});
  assert.equal(report.status,'counterexample');
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

test('live generator CLI reports seeded coverage within its requested bounds',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'premise-live-generator-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const entry=fileURLToPath(new URL('./generated.ts',import.meta.url));
  const run=(runs:string)=>spawnSync(process.execPath,[entry],{cwd,encoding:'utf8',
    env:{...process.env,SEED:'47',RUNS:runs,MAX_STEPS:'13'}});
  const path=join(cwd,'artifacts/live-generated-report.json');
  const invalid=run('0');
  assert.equal(invalid.status,1);
  assert.match(invalid.stderr,/seed, runs and maxSteps must be valid integers/);
  await assert.rejects(readFile(path),{code:'ENOENT'});
  const valid=run('2');
  assert.equal(valid.status,0,valid.stderr);
  const result=JSON.parse(valid.stdout);
  assert.equal(result.status,'sampled_pass');
  assert.ok(result.actionsExecuted<=26);
  assert.deepEqual(result,JSON.parse(await readFile(path,'utf8')));
  assert.deepEqual(result,runGenerated({seed:47,runs:2,maxSteps:13}));
});

test('generated live checks distinguish false rule application from false event provenance',()=>{
  const wrongRule=runGenerated({seed:47,runs:2,maxSteps:25,wrapper:{setRule(this:ReturnType<typeof createApp>,action,patch){
    const result=this.setRule(action,patch);
    return result.ok?{ok:false,reason:'Pretended a successful edit failed'}:result;
  }}});
  assert.equal(wrongRule.status,'counterexample');
  assert.match(wrongRule.counterexample.why,/setRule outcome\/revision mismatch/);
  assert.equal(wrongRule.counterexample.history.at(-1)?.kind,'setRule');
  const wrongActor=runGenerated({seed:47,runs:2,maxSteps:25,wrapper:{dispatch(action,args,actor){
    const result=this.dispatch(action,args,actor);
    return result.ok?{...result,event:{...result.event,actorId:'different-person'}}:result;
  }}});
  assert.equal(wrongActor.status,'counterexample');
  assert.match(wrongActor.counterexample.why,/event policy snapshot mismatch/);
});
