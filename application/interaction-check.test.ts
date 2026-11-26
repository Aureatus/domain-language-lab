import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

test('interaction-check CLI rejects an explicitly empty mutant name',()=>{
  const result=spawnSync(process.execPath,['application/check-interactions.ts','leave/browser.domain','leave.request','--actor','maya','--mutant',''],{encoding:'utf8'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/Error: Unknown test mutant\./);
  assert.equal(result.stdout,'');
});

test('interaction-check CLI resolves defaults and writes a standalone counterexample only on failure',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'premise-interaction-cli-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const trace=join(directory,'trace.json'),entry='leave/browser.domain',action='leave.request';
  const run=(...args:string[])=>spawnSync(process.execPath,['application/check-interactions.ts',...args],{encoding:'utf8'});
  const missing=run(entry);
  assert.equal(missing.status,1);
  assert.match(missing.stderr,/Usage:/);
  const unknown=run(entry,action,'--actor','unknown');
  assert.equal(unknown.status,1);
  assert.match(unknown.stderr,/Unknown action or actor/);
  const pass=run(entry,action,'--out',trace);
  assert.equal(pass.status,0,pass.stderr);
  assert.equal(JSON.parse(pass.stdout).status,'bounded-pass');
  await assert.rejects(readFile(trace),{code:'ENOENT'});
  const args={start:'2026-11-23',end:'2026-11-25'};
  const failed=run(entry,action,'--args',JSON.stringify(args),'--mutant','snapshot-unlocks','--out',trace);
  assert.equal(failed.status,1,failed.stderr);
  const summary=JSON.parse(failed.stdout),replay=JSON.parse(await readFile(trace,'utf8'));
  assert.equal(summary.rule,'submission.no-fresh-submit-before-receipt');
  assert.equal(summary.trace,trace);
  assert.equal(replay.actor,'maya');
  assert.deepEqual(replay.args,args);
  assert.deepEqual(replay.events.map((event:{type:string})=>event.type),summary.sequence);
});
