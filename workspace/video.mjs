import {chromium} from '/tmp/opencode/workbench-tooling/node_modules/playwright/index.mjs';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createWorkspaceServer} from './server.mjs';
import assert from 'node:assert/strict';

const artifacts=new URL('../artifacts/',import.meta.url);
await mkdir(artifacts,{recursive:true});
const directory=await mkdtemp('/tmp/opencode/workspace-video-');
const recordings=await mkdtemp('/tmp/opencode/workspace-recording-');
let server=await createWorkspaceServer({directory,port:0});
const port=Number(new URL(server.url).port);
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1060},recordVideo:{dir:recordings,size:{width:1440,height:1060}}});
const page=await context.newPage();
await page.addInitScript(()=>{
  addEventListener('DOMContentLoaded',()=>{
    const style=document.createElement('style');style.textContent='html{scroll-behavior:smooth}#demo-caption{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);padding:12px 20px;border:1px solid #b8cce0;border-radius:6px;background:#203346f5;color:white;z-index:99998;max-width:1120px;width:max-content;font:17px/1.4 Arial,sans-serif;box-shadow:0 3px 14px #20334644}#demo-cursor{position:fixed;left:30px;top:30px;width:18px;height:18px;border:3px solid #203346;border-radius:50%;background:#ffcb68;z-index:99999;pointer-events:none;transform:translate(-50%,-50%);box-shadow:0 0 0 3px #ffffffbb}';document.head.append(style);
    const cursor=document.createElement('div');cursor.id='demo-cursor';document.body.append(cursor);
    addEventListener('mousemove',e=>{cursor.style.left=`${e.clientX}px`;cursor.style.top=`${e.clientY}px`;});
    addEventListener('mousedown',()=>cursor.animate([{transform:'translate(-50%,-50%) scale(1)',background:'#ffcb68'},{transform:'translate(-50%,-50%) scale(2.7)',background:'#f08c4a',boxShadow:'0 0 0 12px #f08c4a55'},{transform:'translate(-50%,-50%) scale(1)',background:'#ffcb68'}],{duration:650}));
    const caption=document.createElement('div');caption.id='demo-caption';caption.setAttribute('role','status');document.body.append(caption);
  });
});
let scene=0,started;
const chapters=[];
async function caption(text){await page.locator('#demo-caption').evaluate((el,text)=>el.textContent=text,text);chapters.push({second:Math.round((Date.now()-started)/1000),text});}
async function pace(){scene++;const delay=scene*5900-(Date.now()-started);if(delay>0)await page.waitForTimeout(delay);}
async function click(selector){const el=page.locator(selector);await el.scrollIntoViewIfNeeded();const box=await el.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2,{steps:16});await page.waitForTimeout(180);await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await page.waitForTimeout(200);}
async function fill(selector,value){await click(selector);await page.locator(selector).fill(String(value));}
async function select(selector,value){await click(selector);await page.selectOption(selector,value);}
async function ready(profile){await page.waitForFunction(profile=>!document.querySelector('#action-form').inert&&document.querySelector('#revision').textContent.startsWith(profile),profile);}
async function execute(action,args={},clock=100){
  await select('#action',`reservation.${action}`);
  for(const [name,value] of Object.entries(args))await fill(`#input-${name}`,value);
  await fill('#clock',clock);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/execute')&&r.request().method()==='POST');
  await click('#action-form button[type=submit]');const result=await (await response).json();
  await page.locator('#result strong').filter({hasText:result.status}).waitFor(); return result;
}
async function operation(selector,endpoint){const response=page.waitForResponse(r=>r.url().endsWith(`/api/${endpoint}`)&&r.request().method()==='POST');await click(selector);const result=await(await response).json();await page.locator('#result strong').filter({hasText:result.status}).waitFor();return result;}
async function actor(value){await select('#actor',value);await ready(pageProfile);}
let pageProfile='v1';
try{
  await page.goto(server.url);await ready('v1');started=Date.now();
  await caption('v1: five cameras and three preallocated owner-bound slots. This UI executes real Effect / SQLite commands.');await pace();
  await caption('Reserve slotA as Alice. Grouped updates change stock and the existing slot together.');
  assert.equal((await execute('reserve',{slotId:'slotA',quantity:2,expiresAt:200})).status,'committed');await pace();
  await caption('Bob cannot cancel Alice’s slot. The policy rejection comes from the server, not a disabled UI.');
  await actor('bob');assert.equal((await execute('cancel',{slotId:'slotA'})).code,'denied');await pace();
  await caption('Alice cancels: stock returns to five. v1 retains the terminal slot; it does not insert or delete records.');
  await actor('alice');assert.equal((await execute('cancel',{slotId:'slotA'})).status,'committed');await pace();
  await caption('Switch to v2: a separate database, eight cameras, no preallocated reservations.');
  await select('#profile','v2');pageProfile='v2';await ready('v2');await pace();
  await caption('Request three with a caller-chosen ID. Policy requires the stock operator’s approval; stock stays eight.');
  const pending=await execute('reserve',{reservationId:'demo-stale',quantity:3,expiresAt:200});assert.equal(pending.status,'pending');
  const pendingId=pending.request.invocation.id;await pace();
  await caption('The warehouse actor sees Grant approval because the request’s requirements name that approver.');
  await actor('warehouse');await operation(`[data-pending="${pendingId}"] [data-grant]`,'approve');await pace();
  await caption('Stop the backend with the grant persisted. The browser reports reconnecting; no browser receipt authorizes anything.');
  await page.evaluate(()=>scrollTo(0,0));await server.close();await page.locator('#connection').filter({hasText:'Reconnecting'}).waitFor();await pace();
  await caption('Reopen the SAME SQLite directory and port. SSE reconnects and fetches the complete durable snapshot.');
  server=await createWorkspaceServer({directory,port});await page.locator('#connection').filter({hasText:'Connected'}).waitFor();
  await page.locator(`[data-pending="${pendingId}"]`).filter({hasText:'granted by warehouse'}).waitFor();await pace();
  await caption('A competing one-unit reservation changes stock to seven after the grant.');
  assert.equal((await execute('reserve',{reservationId:'demo-competing',quantity:1,expiresAt:200})).status,'committed');await pace();
  await caption('Resume at explicit clock 101: stale. Captured state changed, so the old grant cannot silently rebase.');
  await actor('alice');await fill('#resume-clock',101);assert.equal((await operation(`[data-pending="${pendingId}"] [data-resume]`,'resume')).code,'stale');
  await page.locator('#result').scrollIntoViewIfNeeded();await pace();
  await caption('Submit a fresh request against current stock. A new request needs a new approval.');
  const fresh=await execute('reserve',{reservationId:'demo-fresh',quantity:3,expiresAt:200});assert.equal(fresh.status,'pending');const freshId=fresh.request.invocation.id;await pace();
  await caption('Warehouse grants the fresh request. Resume uses only the server’s persisted grant ledger.');
  await actor('warehouse');await operation(`[data-pending="${freshId}"] [data-grant]`,'approve');await pace();
  await caption('Alice resumes at clock 102: one inserted reservation, stock four. A new resume attempt rejects as consumed.');
  await actor('alice');await fill('#resume-clock',102);assert.equal((await operation(`[data-pending="${freshId}"] [data-resume]`,'resume')).status,'committed');
  assert.equal((await operation(`[data-pending="${freshId}"] [data-resume]`,'resume')).code,'consumed');await page.locator('#result').scrollIntoViewIfNeeded();await pace();
  await caption('Cancel the new reservation as its owner. Availability returns to seven; the record becomes terminal.');
  assert.equal((await execute('cancel',{reservationId:'demo-fresh'})).status,'committed');await pace();
  await caption('Delete the terminal record explicitly. Why retains action/change/create/delete facts and relationship recipients.');
  assert.equal((await execute('delete-terminal',{reservationId:'demo-fresh'})).status,'committed');
  await page.locator('#relationship').scrollIntoViewIfNeeded();await click('#history details:first-child summary');await pace();
  await caption('Both profiles use the same execute API. Durable history is evidence of past commits, never the source of current stock.');
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:new URL('workspace-video-final.png',artifacts).pathname});await pace();
  const video=page.video();await context.close();const source=await video.path();
  const output=new URL('workspace-v1-v2-demo.mp4',artifacts).pathname;
  const conversion=spawnSync('ffmpeg',['-y','-i',source,'-c:v','libx264','-preset','fast','-crf','22','-pix_fmt','yuv420p','-movflags','+faststart',output],{encoding:'utf8'});
  if(conversion.status!==0)throw Error(conversion.stderr);
  const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',output],{encoding:'utf8'});
  const duration=Number(probe.stdout.trim());assert.ok(duration>=70&&duration<=120,`Recording duration ${duration} outside 70–120 seconds`);
  await writeFile(new URL('workspace-video.json',artifacts),JSON.stringify({status:'passed',output,source,directory,duration,continuous:true,cuts:false,speed:1,cursor:'Playwright mouse position with DOM cursor and mousedown pulse',backendRestart:'same Node process; listener and SQLite handles close/reopen on same directory and port',chapters},null,2));
  console.log(JSON.stringify({output,duration,continuous:true},null,2));
}finally{await context.close();await browser.close();await server.close();}
