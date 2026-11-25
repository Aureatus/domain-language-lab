// Replay: node application/submission-browser-test.ts (same local tooling as cli-browser-test).
// One observed schedule on loopback/SQLite; not a proof of network delivery or crash durability.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {promisify} from 'node:util';
import {chromium} from '/tmp/opencode/workbench-tooling/node_modules/playwright/index.mjs';
import {createApplicationServer} from './server.ts';
import declaration from '../leave/model.ts';

const exec=promisify(execFile);
const directory=await mkdtemp('/tmp/opencode/submission-browser-');
let server,browser;
try {
  server=await createApplicationServer(declaration,{directory});
  const cli=async(...args)=>JSON.parse((await exec(process.execPath,[
    'application/cli.ts','--view','leave/cli.domain',...args,'--url',server.url,'--json'
  ],{timeout:15000})).stdout);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage(), errors=[];
  page.setDefaultTimeout(10000);
  page.on('pageerror',e=>errors.push(e.message));
  const execute='/api/actions/execute',reconcile='/api/actions/reconcile';
  let executeCount=0;
  page.on('request',req=>{if(new URL(req.url()).pathname===execute)executeCount++;});
  await page.goto(server.url);
  const balance=page.locator('[data-record="maya"] [data-field="balance"]');
  await balance.filter({hasText:/^5$/}).waitFor();
  const form=page.locator('[data-action="leave.request"]');
  const start=form.locator('[name=start]'),end=form.locator('[name=end]');
  const dates={start:'2026-11-23',end:'2026-11-25'};
  await start.fill(dates.start);
  await end.fill(dates.end);
  await form.locator('[data-preview]').filter({hasText:/Needs Sam/}).waitFor();

  // Deliver the actual POST once; only Chromium loses the reply, after the
  // real server has persisted and returned the pending result.
  let posted,recorded;
  await page.route(`**${execute}`,async route=>{
    posted=route.request().postData();
    const response=await route.fetch({maxRetries:0});
    try { recorded=await response.json(); }
    finally { await route.abort('failed');await response.dispose(); }
  },{times:1});
  await form.locator('[type=submit]').click();
  const check=page.getByRole('button',{name:'Check submission',exact:true});
  await check.waitFor();
  assert.equal(recorded.status,'pending');
  assert.equal(await start.inputValue(),dates.start);
  assert.equal(await end.inputValue(),dates.end);
  const original=recorded.snapshot.pending[0];
  assert.equal(recorded.snapshot.pending.length,1);
  assert.equal(original.invocation.args.days,3);
  await page.reload();await check.waitFor();
  assert.equal(await end.inputValue(),dates.end);
  assert.equal(await form.locator('[type=submit]').isDisabled(),true);

  const [lookup]=await Promise.all([
    page.waitForResponse(r=>new URL(r.url()).pathname===reconcile&&r.request().method()==='POST'),
    check.click()
  ]);
  assert.equal(lookup.ok(),true);
  const recovered=await lookup.json();
  assert.equal(recovered.status,'pending');
  assert.equal(recovered.submissionId,JSON.parse(posted).submissionId);
  assert.deepEqual(recovered.evidence.invocation,original.invocation);
  await check.waitFor({state:'hidden'});
  assert.equal(await page.getByRole('button',{name:'Retry same submission',exact:true}).count(),0);
  const row=page.locator('[data-request]');
  assert.equal(await row.getAttribute('data-request'),original.id);
  const inbox=await cli('inbox','--actor','sam');
  assert.deepEqual(inbox.map(p=>p.id),[original.id]);
  assert.equal(await balance.textContent(),'5');
  assert.equal((await cli('grant',original.id,'--actor','sam','--policy','leave.manager-approval')).status,'approved');
  assert.equal((await cli('list','employee')).maya.values.balance,5);
  assert.equal((await cli('resume',original.id,'--actor','sam')).status,'committed');
  // No navigation, actor switch or manual snapshot refresh.
  await balance.filter({hasText:/^2$/}).waitFor();
  const saved=page.locator('[data-resource="leave"] [data-record]');
  await saved.waitFor();
  assert.equal(await saved.getAttribute('data-record'),original.invocation.args.leaveId);
  assert.equal(executeCount,1,'only the original browser submit may dispatch execute');

  const snapshot=async()=>await(await fetch(server.url+'/api/snapshot')).json();
  const before=await snapshot();
  const replay=await fetch(server.url+execute,{method:'POST',headers:{'content-type':'application/json'},body:posted});
  assert.equal(replay.ok,true,`same submission replay returned ${replay.status}`);
  const receipt=await replay.json();
  assert.equal(receipt.status,recorded.status);
  assert.deepEqual(receipt.evidence.invocation,original.invocation);
  assert.equal((await cli('resume',original.id,'--actor','sam')).code,'consumed');
  const after=await snapshot();
  assert.deepEqual(after.pending,before.pending);
  assert.deepEqual(after.state,before.state);
  assert.deepEqual(Object.keys(after.state.records.leave),[original.invocation.args.leaveId]);
  assert.equal(after.state.records.employee.maya.values.balance,2);
  assert.equal((await cli('reconcile',JSON.parse(posted).submissionId,'--actor','maya')).status,'pending','Original execute receipt survives completion');
  // The other ambiguity: a POST that never reached the backend.
  await start.fill('2026-11-27');await end.fill('2026-11-27');
  let intercepted;
  await page.route(`**${execute}`,route=>{intercepted=route.request().postDataJSON();return route.abort('failed');},{times:1});
  await form.locator('[type=submit]').click();await check.click();
  const retry=page.getByRole('button',{name:'Retry same submission',exact:true});
  await retry.waitFor();
  const [redelivery]=await Promise.all([page.waitForRequest(r=>new URL(r.url()).pathname===execute),retry.click()]);
  assert.deepEqual(redelivery.postDataJSON(),intercepted);
  await balance.filter({hasText:/^1$/}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('sampled_pass: one lost execute response → retained draft → browser check → original CLI grant/resume → live 5→2; one leave after replay.');
} finally {
  try { await browser?.close(); } finally {
    try { await server?.close(); } finally { await rm(directory,{recursive:true,force:true}); }
  }
}
