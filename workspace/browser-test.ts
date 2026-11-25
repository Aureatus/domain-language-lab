import {chromium} from 'playwright';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {createWorkspaceServer} from './server.ts';

const artifacts = new URL('../artifacts/',import.meta.url);
await mkdir(artifacts,{recursive:true});
const directory = await mkdtemp('/tmp/opencode/workspace-browser-');
let server = await createWorkspaceServer({directory,port:0});
const url = server.url, port = Number(new URL(url).port);
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1060}});
const a = await context.newPage(), b = await context.newPage(), errors = [], checks=[];
for(const page of [a,b]) page.on('pageerror', e=>errors.push(e.message));
export async function ready(page, profile='v1') { await page.locator('#revision').filter({hasText:`${profile} ·`}).waitFor(); await page.waitForFunction(()=>!document.querySelector('#action-form').inert); }
export async function choose(page, profile, actor='alice') { await page.selectOption('#profile',profile); await page.selectOption('#actor',actor); await ready(page,profile); }
export async function execute(page, action, args={}, clock=100) {
  await page.selectOption('#action',`reservation.${action}`);
  for(const [name,value] of Object.entries(args)) await page.fill(`#input-${name}`,String(value));
  await page.fill('#clock',String(clock));
  const response = page.waitForResponse(r=>r.url().endsWith('/api/execute') && r.request().method()==='POST');
  await page.locator('#action-form button[type=submit]').click(); const value=await (await response).json();
  await page.locator('#result strong').filter({hasText:value.status}).waitFor();
  return value;
}
async function stock(page, count) { await page.waitForFunction(count=>document.querySelector('#stock [data-field="available"]')?.textContent === String(count),count); }
async function operation(page, selector, endpoint) {
  const response=page.waitForResponse(r=>r.url().endsWith(`/api/${endpoint}`)&&r.request().method()==='POST');
  await page.locator(selector).click(); const value=await (await response).json();
  await page.locator('#result strong').filter({hasText:value.status}).waitFor(); return value;
}
async function grant(invocationId) { const selector=`[data-pending="${invocationId}"] [data-grant]`; await b.locator(selector).waitFor(); assert.equal((await operation(b,selector,'approve')).status,'approved'); }
async function resume(invocationId,clock=101) { await a.fill('#resume-clock',String(clock)); return operation(a,`[data-pending="${invocationId}"] [data-resume]`,'resume'); }
try {
  await Promise.all([a.goto(url),b.goto(url)]); await Promise.all([ready(a),ready(b)]);
  await stock(a,5); await a.screenshot({path:new URL('workspace-v1.png',artifacts).pathname,fullPage:true});
  assert.equal((await execute(a,'reserve',{slotId:'slotA',quantity:2,expiresAt:200})).status,'committed'); await stock(b,3);
  await b.selectOption('#actor','bob'); await ready(b);
  assert.equal((await execute(b,'cancel',{slotId:'slotA'})).code,'denied');
  assert.equal((await execute(a,'cancel',{slotId:'slotA'})).status,'committed'); await stock(b,5);
  await b.selectOption('#actor','alice'); await ready(b);
  assert.equal((await execute(b,'reserve',{slotId:'slotC',quantity:1,expiresAt:200})).status,'committed');
  await b.selectOption('#actor','warehouse'); await ready(b);
  assert.equal((await execute(b,'expire',{slotId:'slotC'},199)).code,'precondition');
  assert.equal((await execute(b,'expire',{slotId:'slotC'},200)).status,'committed'); await stock(a,5);
  checks.push('v1 SQLite reserve/cancel/expire; two-page stock sync; denied ownership; expiry boundary');

  await Promise.all([choose(a,'v2'),choose(b,'v2','warehouse')]); await stock(a,8);
  const pending=await execute(a,'reserve',{reservationId:'res-stale',quantity:3,expiresAt:200}); assert.equal(pending.status,'pending'); await stock(a,8);
  const pendingId=pending.request.invocation.id; await b.locator(`[data-pending="${pendingId}"] [data-grant]`).waitFor();
  assert.equal((await resume(pendingId)).code,'approval'); await stock(a,8);
  // Preserve a focused draft, selection and edited JSON through another session's grant push.
  await a.fill('#input-reservationId','draft-survives'); await a.locator('#input-reservationId').focus();
  await a.locator('#input-reservationId').evaluate(el=>el.setSelectionRange(2,7));
  await grant(pendingId);
  await a.waitForFunction(id=>document.querySelector(`[data-pending="${id}"]`).textContent.includes('granted by warehouse'),pendingId);
  assert.equal(await a.locator('#input-reservationId').inputValue(),'draft-survives');
  assert.deepEqual(await a.locator('#input-reservationId').evaluate(el=>[document.activeElement===el,el.selectionStart,el.selectionEnd]),[true,2,7]);
  const historyBefore=await a.locator('#history details').count();
  await server.close(); await a.locator('#connection').filter({hasText:'Reconnecting'}).waitFor();
  server=await createWorkspaceServer({directory,port});
  await Promise.all([a.locator('#connection').filter({hasText:'Connected'}).waitFor(),b.locator('#connection').filter({hasText:'Connected'}).waitFor()]);
  await a.waitForFunction(id=>document.querySelector(`[data-pending="${id}"]`).textContent.includes('granted by warehouse'),pendingId);
  assert.equal(await a.locator('#history details').count(),historyBefore);
  const competing=await execute(b,'reserve',{reservationId:'res-competing',quantity:1,expiresAt:200}); assert.equal(competing.status,'committed'); await stock(a,7);
  const stale=await resume(pendingId); assert.equal(stale.code,'stale'); await stock(b,7);
  const fresh=await execute(a,'reserve',{reservationId:'res-fresh',quantity:3,expiresAt:200}); assert.equal(fresh.status,'pending');
  const freshId=fresh.request.invocation.id; await grant(freshId);
  assert.equal((await resume(freshId,102)).status,'committed'); await stock(b,4);
  assert.equal((await resume(freshId,103)).code,'consumed');
  checks.push('v2 pending/grant two-page sync; missing approval rejected; focused draft/selection preserved; same-DB listener/SQLite restart and automatic SSE resync; competing commit makes captured request stale; fresh request grant/resume; consumed rejection');

  assert.equal((await execute(a,'delete-terminal',{reservationId:'res-fresh'})).code,'precondition');
  await a.selectOption('#actor','bob'); await ready(a,'v2');
  assert.equal((await execute(a,'cancel',{reservationId:'res-fresh'})).code,'denied');
  await a.selectOption('#actor','alice'); await ready(a,'v2');
  assert.equal((await execute(a,'cancel',{reservationId:'res-fresh'})).status,'committed'); await stock(b,7);
  assert.equal((await execute(a,'delete-terminal',{reservationId:'res-fresh'})).status,'committed');
  await b.waitForFunction(()=>!document.querySelector('#reservations [data-record="res-fresh"]'));
  const expiring=await execute(a,'reserve',{reservationId:'res-expired-request',quantity:3,expiresAt:110});
  await grant(expiring.request.invocation.id); assert.equal((await resume(expiring.request.invocation.id,110)).code,'precondition');
  assert.match(await a.locator('#result').innerText(),/expiry/);
  // JSON is editable, uses the exact execute API and retains the same command ID for retry.
  await a.locator('#tool-details').evaluate(el=>el.open=true);
  const tool={id:'tool-retry-1',action:'reservation.reserve',actor:'alice',clock:100,args:{stockId:'camera',reservationId:'res-json',quantity:1,expiresAt:200}};
  await a.fill('#tool-json',JSON.stringify(tool));
  assert.equal((await operation(a,'#execute-json','execute')).status,'committed'); await stock(b,6);
  assert.equal((await operation(a,'#execute-json','execute')).status,'duplicate'); await stock(b,6);
  await a.fill('#tool-json','{'); await a.click('#execute-json'); assert.match(await a.locator('#result').innerText(),/Invalid JSON/);
  await a.fill('#tool-json',JSON.stringify({...tool,id:'bad-clock',clock:-1})); await a.click('#execute-json');
  await a.locator('#result').filter({hasText:'Command not confirmed'}).waitFor();
  checks.push('v2 active delete rejection; denied owner; cancel/delete sync; expired approval with explicit fresh clock; editable tool JSON commits and duplicate delivery stays one-shot; malformed JSON and actual HTTP clock error');
  // Real expiry of a dynamically inserted record.
  assert.equal((await execute(b,'expire',{reservationId:'res-competing'},200)).status,'committed'); await stock(a,7);
  const historyCount=await a.locator('#history details').count(); assert.ok(historyCount>0);
  await server.close(); server=await createWorkspaceServer({directory,port});
  await a.locator('#connection').filter({hasText:'Connected'}).waitFor();
  await a.waitForFunction(count=>document.querySelectorAll('#history details').length===count,historyCount); await stock(a,7);
  checks.push('v2 expire restores stock; committed event history survives same-database restart');

  // Hold an old actor response and ensure it cannot repaint a newer context.
  let release; const held=new Promise(resolve=>release=resolve); let capturedResolve; const captured=new Promise(resolve=>capturedResolve=resolve);
  await a.route('**/api/snapshot?profile=v1&actor=alice',async route=>{const response=await route.fetch();capturedResolve();await held;await route.fulfill({response});});
  await a.selectOption('#profile','v1'); await captured; await a.selectOption('#profile','v2'); await ready(a,'v2'); release(); await a.unrouteAll({behavior:'wait'});
  assert.match(await a.locator('#revision').innerText(),/^v2/);
  let releaseActor, actorCapturedResolve;
  const actorHeld=new Promise(resolve=>releaseActor=resolve), actorCaptured=new Promise(resolve=>actorCapturedResolve=resolve);
  await a.route('**/api/snapshot?profile=v2&actor=bob',async route=>{const response=await route.fetch();actorCapturedResolve();await actorHeld;await route.fulfill({response});});
  await a.selectOption('#actor','bob'); await actorCaptured;
  await a.selectOption('#actor','alice'); await ready(a,'v2'); releaseActor(); await a.unrouteAll({behavior:'wait'});
  assert.equal(await a.locator('#input-reservationId').inputValue(),'res-expired-request');
  assert.match(await a.locator('#inbox-summary').innerText(),/awaiting alice/);
  checks.push('delayed old profile and actor responses ignored; actor-specific action drafts restored');
  await a.screenshot({path:new URL('workspace-v2.png',artifacts).pathname,fullPage:true});
  await a.setViewportSize({width:390,height:844});
  assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await a.locator('#profile').focus(); await a.keyboard.press('Tab'); assert.equal(await a.locator('#actor').evaluate(el=>document.activeElement===el),true);
  await a.screenshot({path:new URL('workspace-mobile.png',artifacts).pathname,fullPage:true});
  await a.addScriptTag({path:createRequire(import.meta.url).resolve('axe-core/axe.min.js')});
  const audit=await a.evaluate(()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
  assert.deepEqual(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
  checks.push('390px mobile no page overflow; keyboard actor navigation; axe WCAG A/AA automated scan');
  assert.deepEqual(errors,[]);
  await writeFile(new URL('workspace-browser-test.json',artifacts),JSON.stringify({status:'passed',directory,checks,pageErrors:errors,axeViolations:audit.violations.length,scope:'Two pages; server listener and SQLite handles reopened in the same Node process, not power-loss/process-crash evidence.'},null,2));
  console.log(JSON.stringify({status:'passed',checks,directory},null,2));
} catch(error) {
  console.error('UI diagnostic:',await a.locator('#connection').innerText(),await a.locator('#notice').innerText(),errors);
  await a.screenshot({path:new URL('workspace-failure.png',artifacts).pathname,fullPage:true}); throw error;
} finally {await context.close();await browser.close();await server.close();}
