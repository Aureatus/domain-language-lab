import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const root=new URL('../',import.meta.url), directory=new URL('artifacts/inventory-recording/',root);
await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1100},recordVideo:{dir:directory.pathname,size:{width:1440,height:1100}}});
const page=await context.newPage();
await page.addInitScript(()=>{
  addEventListener('DOMContentLoaded',()=>{
    const cursor=document.createElement('div');cursor.id='demo-cursor';cursor.style.cssText='position:fixed;left:30px;top:30px;width:18px;height:18px;border:3px solid #16334c;border-radius:50%;background:#ffdc68;z-index:100000;pointer-events:none;transform:translate(-50%,-50%);box-shadow:0 0 0 4px #ffffff99';document.body.append(cursor);
     addEventListener('mousemove',event=>{cursor.style.left=`${event.clientX}px`;cursor.style.top=`${event.clientY}px`;});
     addEventListener('mousedown',()=>cursor.animate([
       {transform:'translate(-50%,-50%) scale(1)',background:'#ffdc68'},
       {transform:'translate(-50%,-50%) scale(2.4)',background:'#ef765a',boxShadow:'0 0 0 10px #ef765a55'},
       {transform:'translate(-50%,-50%) scale(1)',background:'#ffdc68'}
     ],{duration:650}));
    const caption=document.createElement('div');caption.id='demo-caption';caption.style.cssText='position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:12px 22px;border-radius:8px;background:#16334cf5;color:white;z-index:99999;max-width:1000px;width:max-content;font:18px/1.4 Trebuchet MS,sans-serif;box-shadow:0 3px 15px #16334c44';document.body.append(caption);
  });
});
await page.goto(new URL('artifacts/inventory.html',root).href);await page.waitForLoadState('networkidle');
const pause=ms=>page.waitForTimeout(ms);
async function caption(text){await page.locator('#demo-caption').evaluate((el,text)=>el.textContent=text,text);}
async function click(selector){const box=await page.locator(selector).boundingBox();if(!box)throw Error(`Invisible ${selector}`);await page.mouse.move(box.x+box.width/2,box.y+box.height/2,{steps:24});await pause(350);await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await pause(600);}
await caption('Five cameras. Two clients each request three. All commands use the shared interpreter.');await pause(3500);
await caption('Deliberate mutant: the host commits against old snapshots and overwrites the latest state.');await click('#broken');await pause(4500);
await caption('Actual failure: six units accepted from five; slotA was overwritten. The independent ledger catches it.');await pause(4500);
await click('[data-step="1"]');await caption('Both preparations saw the same five units. Preparation publishes no state or events.');await pause(3500);
await click('[data-step="3"]');await caption('The second mutant commit publishes a stale branch. Revision stays at 1; the first promise is lost.');await pause(4500);
await click('#live');await click('#replay');await caption('Replay re-executes these exact operations and matches every event, outcome and record — including failure.');await pause(4500);
await click('#correct');await caption('Correct host: commit uses the latest snapshot. One reservation wins; the competing token is stale.');await pause(4000);
await click('[data-step="3"]');await caption('Stale rejection is atomic: no reservation, stock write or committed event leaks.');await pause(4000);
await click('[data-step="4"]');await caption('Retry three against the latest snapshot: insufficient capacity. The declaration rejects it.');await pause(3500);
await click('[data-step="5"]');await caption('Retry two: accepted. Five units reserved, zero available. The independent ledger agrees.');await pause(4500);
await click('#live');await click('#replay');await caption('The correct schedule replays exactly too. Export JSON to retain declarations, inputs, clock and schedule.');await pause(4000);
await page.screenshot({path:new URL('artifacts/inventory-video-final.png',root).pathname});
const video=page.video();await context.close();await browser.close();if(!video)throw Error('Browser video was not recorded');const source=await video.path();
const output=new URL('artifacts/inventory-demo.mp4',root).pathname;
const result=spawnSync('ffmpeg',['-y','-i',source,'-c:v','libx264','-preset','fast','-crf','22','-pix_fmt','yuv420p','-movflags','+faststart',output],{encoding:'utf8'});
if(result.status!==0)throw new Error(result.stderr);
await writeFile(new URL('artifacts/inventory-video.json',root),JSON.stringify({format:'inventory-recording/v1',source,output,continuous:true,cursor:'actual Playwright mouse moves, visible DOM pointer',cuts:false,speed:1},null,2));
console.log(`Continuous cursor-visible recording: ${output}`);
