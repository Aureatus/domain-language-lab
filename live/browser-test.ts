import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { runDerivedChecks } from './derive.ts';
import { createApp } from './core.ts';
import type { Result } from 'axe-core';

declare const axe: typeof import('axe-core');
declare global {
  interface Window {
    staleMutation: () => void;
    staleReset: () => void;
    heldResults: (() => void)[];
    holdWorkerResults: boolean;
    workerTerminations: number;
    runningFrames: number;
  }
}

const require=createRequire(import.meta.url);
const axePath=require.resolve('axe-core/axe.min.js');
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:940}});
const page=await context.newPage();
const errors: string[]=[];page.on('pageerror',e=>errors.push(e.message));
const networkRequests: string[]=[];
page.context().on('request',r=>{if(/^https?:/.test(r.url()))networkRequests.push(r.url())});
await page.context().setOffline(true);
const reports: {name: string; violations: Result[]}[]=[];
const state=()=>page.evaluate(()=>structuredClone(window.liveWorkspace.core.state));
const get=()=>page.evaluate(()=>({state:structuredClone(window.liveWorkspace.core.state),model:structuredClone(window.liveWorkspace.core.model)}));
async function audit(name){await page.addScriptTag({path:axePath});const result=await page.evaluate(async()=>await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));reports.push({name,violations:result.violations});assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[],name+' axe')}
async function tool(action,args){await page.locator('#tool-name').selectOption(action);await page.locator('#tool-args').fill(JSON.stringify(args));await page.locator('#tool-form button').click()}
const workspace=()=>page.evaluate(()=>window.liveWorkspace.core.exportWorkspace());
async function declarationChecks(){
  const before=await workspace();const snapshot=await get();const saved=await page.evaluate(()=>localStorage.getItem('relay.workspace.v1'));
  const expected=runDerivedChecks(before);
  await page.locator('#run-derived-checks').click();
  await page.waitForFunction(count=>document.querySelectorAll('#derived-output tbody tr').length===count,expected.cases.length);
  assert.equal(await page.locator('#derived-output tbody tr').count(),expected.cases.length);
  const rows=await page.locator('#derived-output tbody tr').allTextContents();
  expected.cases.forEach((c,i)=>{const row=rows[i];assert.ok(row);for(const value of [c.id,c.action,c.actorId,c.status])if(value!==undefined)assert.ok(row.includes(String(value)));const value=typeof c.expected==='string'?c.expected:JSON.stringify(c.expected);assert.ok(row.includes(value))});
  assert.match(await page.locator('#derived-output').innerText(),/\d+ unknown/);
  assert.deepEqual(await workspace(),before,'Generated checks cannot mutate live state, model or journal');
  assert.deepEqual(await get(),snapshot,'Generated checks preserve actual in-memory state/model');
  assert.equal(await page.evaluate(()=>localStorage.getItem('relay.workspace.v1')),saved,'Generated checks cannot write storage');
  return expected;
}
try {
  await mkdir(resolve('artifacts'),{recursive:true});
  await page.goto(pathToFileURL(resolve('artifacts/live-issues.html')).href);
  await page.evaluate(()=>localStorage.clear());await page.reload();
  await page.locator('.issue-row').first().waitFor();
  assert.equal((await state()).events.length,0,'No precomputed histories');
  await audit('initial desktop');
  // Keyboard-opened editor, real form submission, and focus restoration on close.
  await page.locator('#new-issue').focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('dialog').evaluate(e=>e.contains(document.activeElement)),true);
  await page.locator('dialog input[name=title]').fill('Keep keyboard focus after saving');
  await page.locator('dialog textarea[name=description]').fill('Return focus to the issue after a keyboard save.');
  await page.locator('dialog select[name=priority]').selectOption('high');
  await audit('create dialog');
  await page.locator('dialog form button').click();
  assert.equal(await page.locator('#new-issue').evaluate(e=>e===document.activeElement),true,'Focus restored after create');
  let s=await state();const id=s.issues.at(-1).id;
  assert.equal(s.issues.at(-1).title,'Keep keyboard focus after saving');
  assert.equal(s.events.at(-1).action,'create');
  await page.locator('[data-editor=assign]').click();
  await page.locator('dialog select[name=assignee]').selectOption('u2');
  await page.locator('dialog form button').click();
  assert.equal((await state()).issues.at(-1).assignee,'u2');
  await page.locator('form[data-action=comment] textarea').fill('Reproduced with Tab, Enter, then Escape.');
  await page.locator('form[data-action=comment] button').click();
  s=await state();const historical=JSON.stringify(s.events.at(-1));const historicalId=s.events.at(-1).id;
  assert.equal(s.issues.at(-1).comments.length,1);
  assert.equal(s.notifications.at(-1).recipient,'u2');
  await page.locator('#actor').selectOption('u2');
  assert.equal(await page.locator('[data-run=resolve]').isDisabled(),true);
  const beforeWhy=await workspace();
  await page.locator('[data-unavailable=resolve]').focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('dialog').evaluate(e=>e.contains(document.activeElement)),true);
  assert.match(await page.locator('dialog').innerText(),/not allowed for member/);
  await page.locator('dialog details > summary').click();
  assert.match(await page.locator('dialog pre').innerText(),/"category": "policy"/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-unavailable=resolve]').evaluate(e=>e===document.activeElement),true);
  assert.deepEqual(await workspace(),beforeWhy,'Availability dialog is a query, not a command');
  assert.match(await page.locator('.inbox').innerText(),/Keep keyboard focus/);
  await page.locator('.inbox [data-why]').first().click();
  assert.match(await page.locator('dialog').innerText(),/i3 → assignee → u2/);
  await page.locator('dialog details > summary').click();
  assert.match(await page.locator('#why-data').innerText(),/assignee/);
  await audit('notification explanation');
  await page.keyboard.press('Escape');
  await page.locator('.lab > summary').click();
  const baselineChecks=await declarationChecks();
  assert.match(await page.locator('[data-rule=resolve] .rule-impact').innerText(),/No declaration changes \(no-op\)/);
  const untouched=await workspace();
  const memberToggle=page.locator('[data-rule=resolve] [name=allowedRoles][value=member]');
  await memberToggle.check();await memberToggle.uncheck();
  assert.match(await page.locator('[data-rule=resolve] .rule-impact').innerText(),/No declaration changes \(no-op\)/);
  assert.deepEqual(await workspace(),untouched,'Checkbox preview/no-op does not mutate the workspace');
  // A direct generated-tool invocation must fail the same role check as UI.
  const before=(await state()).events.length;
  await tool('resolve',{issueId:id});
  assert.match(await page.locator('#tool-output').innerText(),/not allowed for member/);
  assert.match(await page.locator('#tool-form .availability').innerText(),/not allowed for member/);
  assert.equal((await state()).events.length,before);
  // Let members resolve, but turn off all resolve notification routes.
  const resolveRule=page.locator('[data-rule=resolve]');
  await resolveRule.locator('[name=allowedRoles][value=member]').check();
  for(const p of ['opener','assignee','watchers'])await resolveRule.locator(`[name=notify][value=${p}]`).uncheck();
  const beforeApply=await workspace();
  assert.match(await resolveRule.locator('.rule-impact').innerText(),/Added role: member/);
  assert.match(await resolveRule.locator('.rule-impact').innerText(),/Removed route: opener/);
  assert.equal(await page.locator('[data-run=resolve]').isDisabled(),true,'Preview is not application');
  assert.deepEqual(await workspace(),beforeApply);
  await resolveRule.locator('button').click();
  assert.match(await page.locator('#derived-output').innerText(),/Not run/,'Model changes invalidate checks');
  const changedChecks=await declarationChecks();
  const roleCases=result=>result.cases.filter(c=>c.action==='resolve' && c.actorId==='u2').map(c=>c.expected);
  assert.notDeepEqual(roleCases(changedChecks),roleCases(baselineChecks),'Member expectations derive from toggled roles');
  await page.screenshot({path:resolve('artifacts/live-declaration-checks.png'),fullPage:true});
  assert.equal(await page.locator('[data-run=resolve]').isEnabled(),true);
  assert.equal(await page.locator('[data-unavailable=resolve]').count(),0,'Applied declaration updates explanation affordance');
  assert.match(await page.locator('#tool-form .availability').innerText(),/Available for current inputs/);
  const tools=await page.locator('#tool-descriptors').textContent();
  assert.ok(tools);
  assert.equal(JSON.parse(tools).find(t=>t.name==='resolve').allowedRoles.includes('member'),true);
  await tool('resolve',{issueId:id});
  s=await state();assert.equal(s.issues.at(-1).status,'resolved');assert.equal(s.events.at(-1).recipients.length,0);
  assert.match(await page.locator('#derived-output').innerText(),/Not run/,'State changes invalidate checks');
  // Restrict comments and reroute future comments through opener alone.
  let rule=page.locator('[data-rule=comment]');
  await rule.locator('[name=allowedRoles][value=member]').uncheck();
  await rule.locator('[name=notify][value=assignee]').uncheck();
  await rule.locator('[name=notify][value=watchers]').uncheck();
  await rule.locator('button').click();
  assert.equal(await page.locator('form[data-action=comment] button').isDisabled(),true);
  await tool('comment',{issueId:id,body:'This must be denied.'});
  assert.match(await page.locator('#tool-output').innerText(),/not allowed for member/);
  rule=page.locator('[data-rule=comment]');await rule.locator('[name=allowedRoles][value=member]').check();await rule.locator('button').click();
  await tool('comment',{issueId:id,body:'Verified the fix; opener-only routing now.'});
  s=await state();assert.deepEqual(s.events.at(-1).recipients.map(r=>r.recipient),['u1']);
  assert.deepEqual(s.events.at(-1).recipients[0].reasons,['opener']);
  assert.equal(JSON.stringify(s.events.find(e=>e.id===historicalId)),historical,'Past explanations unchanged');
  await page.locator('#actor').selectOption('u1');
  await page.locator('.inbox [data-why]').first().click();assert.match(await page.locator('dialog').innerText(),/i3 → opener → u1/);await page.locator('dialog details > summary').click();assert.match(await page.locator('#why-data').innerText(),/opener/);await page.keyboard.press('Escape');
  await page.locator('#run-checks').click();
  const checks=JSON.parse(await page.locator('#check-output').innerText());assert.ok(checks.length>=7 && checks.every(c=>c.ok));
  // Editable JSON is validated; invalid JSON is not a dispatch.
  const count=(await state()).events.length;await page.locator('#tool-args').fill('{ broken');await page.locator('#tool-form button').click();
  assert.match(await page.locator('#tool-output').innerText(),/Invalid JSON/);assert.equal((await state()).events.length,count);
  await audit('edited declarations and tools');
  await page.locator('#actor').selectOption('u2');
  await page.locator('#actor').selectOption('u1');
  await page.locator('.lab > summary').click();
  await page.screenshot({path:resolve('artifacts/live-issues-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No mobile horizontal overflow');
  await audit('mobile workspace');
  await page.locator('#new-issue').click();await audit('mobile editor');await page.keyboard.press('Escape');
  await page.screenshot({path:resolve('artifacts/live-issues-mobile.png'),fullPage:true});
  // Watch and reopen use ordinary controls, including related views.
  await page.locator('[data-run=reopen]').click();assert.equal((await state()).issues.at(-1).status,'open');
  await page.locator('[data-run=watch]').click();assert.ok((await state()).issues.at(-1).watchers.includes('u1'));
  // Nullable schema input round-trips through the editor, with correct historical diff.
  await page.locator('[data-editor=assign]').click();
  assert.equal(await page.locator('dialog select[name=assignee]').inputValue(),'u2');
  assert.equal(await page.locator('dialog form button').isDisabled(),true);
  assert.match(await page.locator('dialog .availability').innerText(),/Assignee is unchanged/);
  await page.locator('dialog select[name=assignee]').selectOption('');
  assert.equal(await page.locator('dialog form button').isEnabled(),true,'Null assignment is a valid changed value');
  await page.locator('dialog form button').click();
  assert.equal((await state()).issues.at(-1).assignee,null);
  assert.deepEqual((await state()).events.at(-1).changes.find(c=>c.field==='assignee'),{field:'assignee',before:'u2',after:null});
  await page.locator('.lab > summary').click();
  assert.match(await page.locator('#check-output').innerText(),/Not run/,'State audit invalidated after mutations');
  await declarationChecks();
  await page.locator('#reset').click();await page.locator('#confirm-reset').click();await page.locator('.issue-row').first().waitFor();assert.equal((await state()).events.length,0);
  assert.match(await page.locator('#derived-output').innerText(),/Not run/,'Reset invalidates checks');
  await page.setViewportSize({width:1440,height:940});
  // Drafts belong to actor/issue pairs; editable tool JSON is never regenerated on render.
  const comment=()=>page.locator('form[data-action=comment] textarea');
  await comment().fill('Unsent Maya draft');
  await page.locator('[data-issue=i2]').click();await comment().fill('Different issue draft');
  await page.locator('[data-issue=i1]').click();assert.equal(await comment().inputValue(),'Unsent Maya draft');
  await page.locator('#actor').selectOption('u2');assert.equal(await comment().inputValue(),'');
  await comment().fill('Unsent Jonah draft');await page.locator('#actor').selectOption('u1');
  assert.equal(await comment().inputValue(),'Unsent Maya draft');
  if (!await page.locator('.lab').evaluate(e=>e instanceof HTMLDetailsElement && e.open)) await page.locator('.lab > summary').click();
  await page.locator('#tool-args').fill('{ draft JSON');
  assert.match(await page.locator('#tool-form .availability').innerText(),/enter valid JSON/);
  const beforeQuery=await workspace();
  await page.locator('#tool-args').fill(JSON.stringify({issueId:'i1'}));
  assert.match(await page.locator('#tool-form .availability').innerText(),/Missing args.body/);
  await page.locator('#tool-args').fill(JSON.stringify({issueId:'i1',body:'   '}));
  assert.match(await page.locator('#tool-form .availability').innerText(),/must not be blank/);
  assert.deepEqual(await workspace(),beforeQuery,'Editing tool arguments only queries availability');
  await page.locator('#tool-args').fill('{ draft JSON');
  await page.locator('#actor').selectOption('u2');await page.locator('#actor').selectOption('u1');
  assert.equal(await page.locator('#tool-args').inputValue(),'{ draft JSON');
  await page.locator('#tool-name').selectOption('assign');await page.locator('#tool-name').selectOption('comment');
  assert.equal(await page.locator('#tool-args').inputValue(),'{ draft JSON');
  // Compact filters preserve search focus and caret; queue supports arrow navigation and Enter.
  const title=(await state()).issues[0].title;
  await page.locator('#issue-search').fill('no such issue');assert.equal(await page.locator('.issue-row').count(),0);
  assert.equal(await page.locator('#issue-search').evaluate(e=>e===document.activeElement),true);
  await page.locator('#issue-search').fill(title);assert.equal(await page.locator('.issue-row').count(),1);
  await page.locator('#issue-search').fill('');
  await page.locator('#unresolved').check();await page.locator('#assigned').check();
  assert.equal(await page.locator('.issue-row').count(),(await state()).issues.filter(i=>i.status!=='resolved'&&i.assignee==='u1').length);
  await page.locator('#assigned').uncheck();await page.locator('#unresolved').uncheck();
  await page.locator('.issue-row').first().focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>window.liveWorkspace.selected),'i2');
  await page.locator('[data-issue=i1]').click();
  await page.locator('form[data-action=comment] button').click();assert.equal(await comment().inputValue(),'');
  const persisted=await get();
  assert.match(await page.locator('#save-status').innerText(),/Saved in this browser/);
  await page.reload();assert.deepEqual(await get(),persisted,'Reload reconstructs saved state and declaration');
  assert.match(await page.locator('#save-status').innerText(),/Recovered/);
  // Export is a live document, not a preview; rejected imports are atomic.
  const downloadPromise=page.waitForEvent('download');await page.locator('#export-workspace').click();
  const download=await downloadPromise;const exported=await readFile(await download.path(),'utf8');
  const importJSON=async text=>page.locator('#import-workspace').setInputFiles({name:'workspace.json',mimeType:'application/json',buffer:Buffer.from(text)});
  const corruptJournal=JSON.parse(exported);corruptJournal.journal[0]={kind:'unsupported'};
  for (const invalid of ['{ broken',JSON.stringify({format:'unknown',seedVersion:999,journal:[]}),JSON.stringify(corruptJournal)]) {
    await importJSON(invalid);await page.getByText(/Import rejected; workspace unchanged/).waitFor();
    assert.deepEqual(await get(),persisted);
  }
  await comment().fill('Draft held during history');
  await page.locator('.lab > summary').click();await page.locator('#tool-args').fill('{ history draft');
  await page.evaluate(()=>{
    const button=document.querySelector<HTMLButtonElement>('[data-run=watch]');
    const handler=button?.onclick;
    if(!button || !handler) throw Error('Missing watch handler');
    window.staleMutation=()=>handler.call(button,new PointerEvent('click'));
  });
  await page.locator('#reset').click();
  await page.evaluate(()=>{
    const button=document.querySelector<HTMLButtonElement>('#confirm-reset');
    const handler=button?.onclick;
    if(!button || !handler) throw Error('Missing reset handler');
    window.staleReset=()=>handler.call(button,new PointerEvent('click'));
  });
  await page.keyboard.press('Escape');
  await page.locator('#history > summary').click();await page.locator('#history-step').fill('0');
  const savedBeforePreview=await page.evaluate(()=>localStorage.getItem('relay.workspace.v1'));
  await page.locator('#preview').click();assert.equal(await page.locator('#new-issue').isDisabled(),true);
  assert.equal(await page.locator('[data-run=resolve]').isDisabled(),true);
  assert.equal(await page.locator('#reset').isDisabled(),true);
  assert.equal(await page.locator('#import-workspace').isDisabled(),true);
  assert.equal(await page.locator('#tool-form').count(),0);assert.equal(await page.locator('form[data-action]').count(),0);
  assert.equal(await page.locator('.comment').count(),0,'Preview renders seed conversation, not live comments');
  assert.match(await page.locator('.detail').innerText(),/Current availability explanations are disabled here/);
  assert.equal(await page.locator('[data-unavailable]').count(),0,'No live-model availability query in history');
  await page.evaluate(()=>window.staleMutation());
  await page.evaluate(()=>window.staleReset());
  assert.deepEqual(await get(),persisted,'Preview never mutates live runtime');
  assert.equal(await page.evaluate(()=>localStorage.getItem('relay.workspace.v1')),savedBeforePreview);
  await audit('read-only history');
  await page.locator('#return-live').click();assert.equal(await page.locator('form[data-action=comment]').count(),1);
  assert.equal(await comment().inputValue(),'Draft held during history');
  assert.equal(await page.locator('#tool-args').inputValue(),'{ history draft');
  await page.locator('#reset').click();await page.locator('#confirm-reset').click();
  await declarationChecks();
  await importJSON(exported);await page.getByText('Imported workspace after core validation.').waitFor();
  assert.match(await page.locator('#derived-output').innerText(),/Not run/,'Import invalidates checks');
  assert.deepEqual(await get(),persisted,'Export/import round trip');
  // An unreadable saved document is retained even if the user continues in memory.
  await page.evaluate(()=>localStorage.setItem('relay.workspace.v1','{ damaged original'));
  await page.reload();assert.match(await page.locator('#save-status').innerText(),/Original retained/);
  const originalDownloadPromise=page.waitForEvent('download');await page.locator('#export-original').click();
  assert.equal(await readFile(await (await originalDownloadPromise).path(),'utf8'),'{ damaged original');
  await comment().fill('In-memory work during recovery');await page.locator('form[data-action=comment] button').click();
  assert.equal(await page.evaluate(()=>localStorage.getItem('relay.workspace.v1')),'{ damaged original');
  await importJSON('{ broken');await page.getByText(/Import rejected/).waitFor();
  assert.equal((await state()).events.length,1);
  await comment().fill('Recovery remains blocked');await page.locator('form[data-action=comment] button').click();
  assert.equal(await page.evaluate(()=>localStorage.getItem('relay.workspace.v1')),'{ damaged original');
  await importJSON(exported);await page.getByText('Imported workspace after core validation.').waitFor();
  assert.deepEqual(await get(),persisted);
  // Quota/disabled-storage writes must never be described as saved.
  const failure=await browser.newPage();
  await failure.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('Storage quota reached','QuotaExceededError')}});
  await failure.goto(pathToFileURL(resolve('artifacts/live-issues.html')).href);
  await failure.locator('form[data-action=comment] textarea').fill('Memory only');
  await failure.locator('form[data-action=comment] button').click();
  assert.match(await failure.locator('#save-status').innerText(),/Not saved:.*Storage quota reached/);
  assert.equal(await failure.evaluate(()=>window.liveWorkspace.core.state.events.length),1);
  await failure.close();
  const unavailable=await browser.newPage();
  await unavailable.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw Error('Storage denied')}}));
  await unavailable.goto(pathToFileURL(resolve('artifacts/live-issues.html')).href);
  assert.match(await unavailable.locator('#save-status').innerText(),/Storage unavailable/);
  await unavailable.locator('form[data-action=comment] textarea').fill('Still usable');await unavailable.locator('form[data-action=comment] button').click();
  assert.match(await unavailable.locator('#save-status').innerText(),/Not saved:.*Storage denied/);await unavailable.close();
   // A real 100-comment workload executes off-thread while controls and frames
   // continue. Hold only delivery of real worker results for deterministic races.
   const workerPage=await page.context().newPage();
   workerPage.on('pageerror',e=>errors.push(e.message));
   await workerPage.addInitScript(()=>{
     window.heldResults=[];window.holdWorkerResults=false;window.workerTerminations=0;
     const NativeWorker=Worker;
     window.Worker=class extends NativeWorker {
       override set onmessage(handler: Worker['onmessage']) {
         super.onmessage=handler && (event=>{if(window.holdWorkerResults)window.heldResults.push(()=>handler.call(this,event));else handler.call(this,event)});
       }
       override terminate(){window.workerTerminations++;super.terminate()}
     };
   });
   await workerPage.goto(pathToFileURL(resolve('artifacts/live-issues.html')).href);
   const history=createApp({clock:()=>123});
   for(let index=0;index<100;index++)assert.equal(history.dispatch('comment',{issueId:'i1',body:'Existing history'},'u2').ok,true);
   const historyJSON=JSON.stringify(history.exportWorkspace());
   const importWorker=async()=>{
     await workerPage.locator('#import-workspace').setInputFiles({name:'history.json',mimeType:'application/json',buffer:Buffer.from(historyJSON)});
     await workerPage.getByText('Imported workspace after core validation.').waitFor();
     if(!await workerPage.locator('.lab').evaluate(e=>e instanceof HTMLDetailsElement && e.open))await workerPage.locator('.lab > summary').click();
   };
   await importWorker();
   await workerPage.evaluate(()=>{
     window.runningFrames=0;
     const frame=()=>{if(document.querySelector('#cancel-derived-checks')){window.runningFrames++;requestAnimationFrame(frame)}};
     const start=document.querySelector<HTMLButtonElement>('#run-derived-checks');
     if(!start)throw Error('Missing declaration check control');
     start.click();requestAnimationFrame(frame);
   });
   await workerPage.waitForFunction(()=>window.runningFrames>=3);
   await workerPage.locator('#issue-search').fill('CSV');
   assert.equal(await workerPage.locator('.issue-row').count(),1,'Search remains interactive during actual worker computation');
   await workerPage.waitForFunction(()=>document.querySelectorAll('#derived-output tbody tr').length===280);
   assert.match(await workerPage.locator('#derived-output').innerText(),/passed · r1/);
   const expectedHistory=runDerivedChecks(history.exportWorkspace());
   const actualRows=await workerPage.locator('#derived-output tbody tr').evaluateAll(rows=>rows.map(row=>[...row.querySelectorAll('td')].map(cell=>cell.textContent)));
   assert.deepEqual(actualRows,expectedHistory.cases.map(c=>[c.id,c.action,c.actorId,JSON.stringify(c.expected),JSON.stringify(c.actual),c.status]));
   await workerPage.locator('#issue-search').fill('');
   // Cancellation terminates the actual worker, never runs a synchronous fallback.
   await workerPage.evaluate(()=>{
     const start=document.querySelector<HTMLButtonElement>('#run-derived-checks');
     if(!start)throw Error('Missing declaration check control');
     start.click();
     const cancel=document.querySelector<HTMLButtonElement>('#cancel-derived-checks');
     if(!cancel)throw Error('Missing declaration check cancellation control');
     cancel.click();
   });
   assert.match(await workerPage.locator('#derived-output').innerText(),/unknown.*r1/s);
   assert.match(await workerPage.locator('#derived-output').innerText(),/Cancelled/);
   assert.ok(await workerPage.evaluate(()=>window.workerTerminations)>=2);
   const holdResult=async()=>{
     await workerPage.evaluate(()=>{
       window.heldResults=[];window.holdWorkerResults=true;
       const start=document.querySelector<HTMLButtonElement>('#run-derived-checks');
       if(!start)throw Error('Missing declaration check control');
       start.click();
     });
     await workerPage.waitForFunction(()=>window.heldResults.length===1);
     assert.match(await workerPage.locator('#derived-output').innerText(),/Running/);
   };
   const deliverStale=async()=>{
     await workerPage.evaluate(()=>{window.heldResults.splice(0).forEach(deliver=>deliver());window.holdWorkerResults=false});
     assert.equal(await workerPage.locator('#derived-output tbody tr').count(),0,'Obsolete worker response cannot publish evidence');
   };
   await holdResult();
   await workerPage.locator('form[data-action=comment] textarea').fill('Invalidate running state');
   await workerPage.locator('form[data-action=comment] button').click();await deliverStale();
   await holdResult();await workerPage.locator('[data-rule=comment] button').click();await deliverStale();
   await holdResult();
   await workerPage.evaluate(()=>window.liveWorkspace.core.setRule('comment',{notify:[]}));
   await deliverStale();
   await holdResult();await importWorker();await deliverStale();
   await holdResult();await workerPage.locator('#reset').click();await workerPage.locator('#confirm-reset').click();await deliverStale();
   await importWorker();await holdResult();
   await workerPage.locator('#history > summary').click();await workerPage.locator('#history-step').fill('0');await workerPage.locator('#preview').click();
   await workerPage.locator('#return-live').click();await deliverStale();
   // A cancelled request followed by a new one cannot overwrite its replacement.
   await holdResult();
   await workerPage.evaluate(()=>{
     const oldDelivery=window.heldResults.shift();
     const cancel=document.querySelector<HTMLButtonElement>('#cancel-derived-checks');
     if(!cancel || !oldDelivery)throw Error('Missing cancellation control or held result');
     cancel.click();window.holdWorkerResults=false;
     const start=document.querySelector<HTMLButtonElement>('#run-derived-checks');
     if(!start)throw Error('Missing declaration check control');
     start.click();oldDelivery();
   });
   assert.match(await workerPage.locator('#derived-output').innerText(),/Running/);
   await workerPage.waitForFunction(()=>document.querySelectorAll('#derived-output tbody tr').length===280);
   const budget=createApp();for(let i=0;i<500;i++)assert.equal(budget.setRule('watch',{notify:[]}).ok,true);
   await workerPage.locator('#import-workspace').setInputFiles({name:'budget.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(budget.exportWorkspace()))});
   await workerPage.getByText('Imported workspace after core validation.').waitFor();
   await workerPage.locator('#run-derived-checks').click();
   await workerPage.waitForFunction(()=>document.querySelector('#derived-output')?.textContent.includes('Resource-bound witness'));
   assert.match(await workerPage.locator('#derived-output').innerText(),/unknown · r501/);
   await workerPage.close();
   for(const mode of ['unavailable','startup-error','runtime-error','message-error','time-budget']) {
     const failure=await page.context().newPage();
     await failure.addInitScript(mode=>{
       if(mode==='unavailable')Object.defineProperty(window,'Worker',{value:undefined});
       else if(mode==='startup-error')Object.defineProperty(window,'Worker',{value:class{constructor(){throw Error('Worker resource allocation denied')}}});
       else {
         Object.defineProperty(window,'Worker',{value:class{
           onerror?: (event: ErrorEvent) => void;
           onmessageerror?: (event: MessageEvent) => void;
           postMessage(){
             if(mode==='runtime-error')queueMicrotask(()=>this.onerror?.(new ErrorEvent('error',{message:'Worker resource failure'})));
             if(mode==='message-error')queueMicrotask(()=>this.onmessageerror?.(new MessageEvent('messageerror')));
           }
           terminate(){}
         }});
         if(mode==='time-budget'){
           const nativeTimeout: Window['setTimeout']=window.setTimeout;
           Object.defineProperty(window,'setTimeout',{value:(callback: TimerHandler,ms?: number,...args: unknown[])=>nativeTimeout(callback,ms===60000?0:ms,...args)});
         }
       }
     },mode);
     await failure.goto(pathToFileURL(resolve('artifacts/live-issues.html')).href);
     await failure.locator('.lab > summary').click();await failure.locator('#run-derived-checks').click();
     await failure.waitForFunction(()=>document.querySelector('#derived-output')?.textContent.includes('unknown'));
     assert.match(await failure.locator('#derived-output').innerText(),/Worker/);
     if(mode==='time-budget')assert.match(await failure.locator('#derived-output').innerText(),/time budget exceeded/);
     assert.equal(await failure.locator('#derived-output tbody tr').count(),1);
     await failure.close();
   }
   assert.deepEqual(networkRequests,[],'Offline artifact and Blob workers issue zero HTTP(S) requests');
   assert.deepEqual(errors,[]);
   await writeFile(resolve('artifacts/live-declaration-browser-results.json'),JSON.stringify({status:'passed',flows:['pre-Apply declaration preview and no-op','preview does not mutate','actual per-case table','checks do not mutate live workspace or storage','role toggles regenerate expectations','state/model/import/reset invalidate results','100-comment real worker exact result table','animation frames and search during computation','worker cancellation and termination','delayed stale responses after commit/rule/import/reset/history/replacement','out-of-band model identity guard','unavailable/startup/runtime/message failures unknown','time budget unknown (accelerated test timer)','history resource limit unknown','offline zero HTTP(S) requests'],responsiveFramesMinimum:3,networkRequests,baseline:baselineChecks,changed:changedChecks},null,2));
  await writeFile(resolve('artifacts/live-browser-results.json'),JSON.stringify({status:'passed',browser:'Chromium',flows:['create','assign','comment','resolve','reopen','watch','recipient inbox','notification Why','role denial via tool','comment and resolve rule changes','historical explanation unchanged','generated descriptor updates','editable JSON tool dispatch','current-state invariants','keyboard editor and Escape','390px responsive','explicit persisted reset','reload recovery','JSON export/import round trip','atomic rejected imports','corrupt save retained and downloadable','failed storage writes','storage unavailable','read-only preview and return','preview stale mutation guard','actor/issue comment drafts','tool JSON drafts','search focus and filters','queue keyboard navigation'],axe:reports,checks,consoleErrors:errors},null,2));
  console.log(`PASS live browser flows · ${reports.length} axe scans · ${checks.length} current-state checks`);
} finally {await browser.close()}
