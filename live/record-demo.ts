import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const dir=resolve('artifacts/live-video-v4');await mkdir(dir,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:940},deviceScaleFactor:1,recordVideo:{dir,size:{width:1440,height:940}}});
const page=await context.newPage();const video=page.video();const marks: {selector: string; caption: string; seconds: number}[]=[];let started=Date.now();
try {
  await page.goto(pathToFileURL(resolve('artifacts/live-issues.html')).href);
  await page.locator('#new-issue').waitFor();
  const installOverlays=()=>page.evaluate(()=>{
    const style=document.createElement('style');style.textContent=`#demo-pointer{position:fixed;left:0;top:0;width:28px;height:36px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 2px 2px #0006)}#demo-pulse{position:fixed;width:18px;height:18px;border:3px solid #245cc0;border-radius:50%;z-index:2147483646;pointer-events:none;opacity:0;transform:translate(-50%,-50%)}#demo-pulse.active{animation:demo-pulse .65s ease-out}@keyframes demo-pulse{0%{opacity:1;scale:.5;background:#245cc055}75%{opacity:1;scale:2.8}100%{opacity:0;scale:3.4}}#demo-caption{position:fixed;bottom:0;left:0;right:0;padding:15px 26px;background:#202e3d;color:white;font:16px/1.4 'Segoe UI',Arial,sans-serif;z-index:2147483645;pointer-events:none;border-top:2px solid #83a9e7}`;
    document.head.append(style);
    const pointer=document.createElement('div');pointer.id='demo-pointer';pointer.innerHTML='<svg viewBox="0 0 30 38"><path d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 20 L26 19 Z" fill="white" stroke="#202e3d" stroke-width="2.5" stroke-linejoin="round"/></svg>';
    const pulse=document.createElement('div');pulse.id='demo-pulse';const caption=document.createElement('div');caption.id='demo-caption';document.body.append(pointer,pulse,caption);
    // A modal lives in the top layer. Move the recording overlays into it while open.
    const dialog=document.querySelector('dialog');
    if(!dialog)throw Error('Recording dialog is missing');
    new MutationObserver(()=>{const parent=dialog.open ? dialog : document.body;for(const el of [pointer,pulse,caption])if(el.parentElement!==parent)parent.append(el)}).observe(dialog,{attributes:true,attributeFilter:['open']});
    document.addEventListener('mousemove',e=>pointer.style.transform=`translate(${e.clientX}px,${e.clientY}px)`);
    document.addEventListener('pointerdown',e=>{pulse.style.left=e.clientX+'px';pulse.style.top=e.clientY+'px';pulse.classList.remove('active');void pulse.offsetWidth;pulse.classList.add('active')});
  });
  await installOverlays();
  started=Date.now();let cursor={x:1050,y:100};await page.mouse.move(cursor.x,cursor.y);
  const wait=(ms:number)=>page.waitForTimeout(ms); // Deliberate editorial pacing within continuous recording.
  const caption=(text:string)=>page.locator('#demo-caption').evaluate((el,text)=>el.textContent=text,text);
  async function click(selector:string,text:string,hold=900){
    await caption(text);const target=page.locator(selector).first();await target.scrollIntoViewIfNeeded();const box=await target.boundingBox();if(!box)throw Error('Invisible '+selector);
    const end={x:box.x+box.width/2,y:box.y+box.height/2};
    for(let i=1;i<=22;i++){const t=i/22;await page.mouse.move(cursor.x+(end.x-cursor.x)*t,cursor.y+(end.y-cursor.y)*t);await wait(14)}cursor=end;
    await wait(180);await page.mouse.down();await wait(100);await page.mouse.up();marks.push({selector,caption:text,seconds:(Date.now()-started)/1000});await wait(hold);
  }
  async function type(selector:string,text:string,captionText:string){await click(selector,captionText,150);await page.locator(selector).press('ControlOrMeta+A');await page.locator(selector).pressSequentially(text,{delay:16})}
  async function choose(selector:string,value:string,text:string){await click(selector,text,100);await page.locator(selector).selectOption(value);await page.keyboard.press('Escape');await wait(600)}
  await caption('A real local issue workspace. Every change executes the shared core now.');await wait(2200);
  await click('#new-issue','Create an issue, not a precomputed scenario.');
  await type('dialog input[name=title]','Keep focus after saving','Describe the work. Fields and requirements come from the declaration.');
  await type('dialog textarea[name=description]','Keyboard users lose their place after save.','Add the context the assignee will need.');
  await click('dialog form button','Create issue → the queue and detail update together.',1200);
  await click('[data-editor=assign]','Give Jonah the next step.');
  await choose('dialog select[name=assignee]','u2','Select a real related user.');
  await click('dialog form button','Assignment updates the issue and recipient inbox.',1200);
  await type('form[data-action=comment] textarea','Reproduced. Restore focus to the saved issue.','Add a useful comment.');
  await click('form[data-action=comment] button','Comment commits with a captured rule and relationship paths.',1300);
  await choose('#actor','u2','Switch to Jonah: the related inbox is live.');
  await click('.inbox [data-why]','Why did Jonah receive this? Inspect the actual captured event.',2200);
  await click('dialog [data-close]','The explanation records assignee routing under declaration r1.');
  await click('[data-unavailable=resolve]','Why unavailable? The same action preparation explains the current role restriction.',1800);
  await click('dialog [data-close]','This query changes no state and records no action.');
  await click('.lab > summary','Development lab: the declarations behind this same workspace.',1100);
  await choose('#tool-name','resolve','Generated tools use the same action schema and policy.');
  await click('#tool-form button','A member cannot resolve: direct tool invocation is denied too.',1800);
   await click('[data-rule=resolve] [value=member]','Preview first: Added role: member. Nothing has been applied yet.',1800);
  await click('[data-rule=resolve] [name=notify][value=opener]','Change future routing: do not notify the opener.');
  await click('[data-rule=resolve] [name=notify][value=assignee]','Remove assignee routing for future resolutions.',400);
   await click('[data-rule=resolve] [name=notify][value=watchers]','Preview: removed routes affect future recipients, not old inbox items.',1600);
  await click('[data-rule=resolve] button','Apply r2. Availability and generated descriptors change immediately.',1500);
  await click('#tool-form button','Invoke the same tool again: now it resolves, with no new recipients.',1800);
   await click('#run-derived-checks','Generate cases from today’s declaration; dispatch only in isolated copies.',2500);
    await page.locator('#derived-output tbody tr').first().waitFor({timeout:60000});
    assert.ok(await page.locator('#derived-output tbody tr').count()>0);
   await page.locator('#derived-output').scrollIntoViewIfNeeded();await wait(1800);
   await click('#run-checks','Separate current-state audit. Neither check view is historic Lean proof.',900);
   await click('.lab > summary','Resolved, saved locally. Existing inbox items remain; no resolve notification was added.',1300);
   await caption('Reload the actual saved workspace: state and rule edits reconstruct from the local journal.');
   const saved=await page.evaluate(()=>JSON.stringify({state:window.liveWorkspace.core.state,model:window.liveWorkspace.core.model}));
   await page.reload();await page.locator('#save-status').waitFor();await installOverlays();
   assert.match(await page.locator('#save-status').innerText(),/Recovered/);
   assert.equal(await page.evaluate(()=>JSON.stringify({state:window.liveWorkspace.core.state,model:window.liveWorkspace.core.model})),saved);
   await caption('Recovered saved workspace. Select the created issue again.');await wait(1000);
   await click('[data-issue=i3]','The created issue and live comment survived reload.',1300);
   await click('#history > summary','Workspace history reconstructs prior journal steps, read-only.',800);
   await type('#history-step','0','Inspect the seed before any of these changes.');
   await click('#preview','Read-only history: live mutations and development tools are unavailable.',2000);
   assert.equal(await page.locator('#new-issue').isDisabled(),true);
   assert.equal(await page.locator('#tool-form').count(),0);
   await click('#return-live','Return to the saved live workspace; history never rewrote it.',1500);
   const remaining=64000-(Date.now()-started);if(remaining>0){await caption('Local shared core: live work, declaration previews, generated checks, recovery, read-only history.');await wait(remaining)}
  await writeFile(resolve(dir,'interactions.json'),JSON.stringify({kind:'continuous-browser-recording',cursor:'DOM pointer follows actual mouse movement; pointerdown pulses',timing:'editorial pacing, not latency measurements',durationBeforeClose:(Date.now()-started)/1000,marks},null,2));
} finally {await context.close();await browser.close()}
if(!video)throw Error('Browser video was not recorded');
const source=await video.path();const output=resolve('artifacts/live-issues-demo-v4.mp4');
const result=spawnSync('ffmpeg',['-y','-i',source,'-vf','fps=30,format=yuv420p','-c:v','libx264','-crf','19','-preset','medium','-movflags','+faststart',output],{encoding:'utf8'});
if(result.status!==0)throw Error(result.stderr);console.log(`Created ${output} from ${source}`);
