// Demonstration/test tooling only. No application code imports this scenario.
import type {Locator,Page} from 'playwright';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {createLeaveServer} from './server.ts';

export async function runLeaveBrowser({explain=false,record=false}={}){
  const directory=await mkdtemp('/tmp/opencode/derived-leave-browser-'),recordings=record?await mkdtemp('/tmp/opencode/derived-leave-recording-'):null;
  const artifacts=new URL('../artifacts/',import.meta.url);await mkdir(artifacts,{recursive:true});
  let server=await createLeaveServer({directory});const browser=await chromium.launch({headless:true});
  const a=await browser.newContext({viewport:{width:explain?1920:1280,height:1080},...(recordings?{recordVideo:{dir:recordings,size:{width:explain?1920:1280,height:1080}}}:{})}),b=await browser.newContext({viewport:{width:1280,height:1000}});
  const maya=await a.newPage(),sam=await b.newPage(),errors:string[]=[],checks:string[]=[];
  for(const page of [maya,sam])page.on('pageerror',e=>errors.push(e.message));
  const form=(page:Page)=>page.locator('[data-action="leave.request"]');
  const balance=async(page:Page,n:number)=>page.locator('[data-resource="employee"] [data-field="balance"]').filter({hasText:new RegExp(`^${n}$`)}).waitFor();
  const preview=async(page:Page,text:string)=>form(page).locator('[data-preview]').filter({hasText:text}).waitFor();
  async function dates(page:Page,start:string,end:string){await form(page).locator('[name="start"]').fill(start);await form(page).locator('[name="end"]').fill(end);}
  async function clickCommand(page:Page,path:string,button:Locator){const pending=page.waitForResponse(r=>r.url().endsWith(`/api/${path}`)&&r.request().method()==='POST');await button.click();return(await pending).json();}
  const send=(page:Page)=>clickCommand(page,'actions/execute',form(page).locator('button[type="submit"]'));
  async function approval(page:Page){let r=await clickCommand(page,'approvals/grant',page.locator('[data-grant]').first());assert.equal(r.status,'approved');r=await clickCommand(page,'approvals/resume',page.locator('[data-resume]').first());return r;}
  const post=async(path:string,body:object)=>{const res=await fetch(`${server.url}/api/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {http:res.status,...await res.json()};};
  const rule=(threshold:number)=>post('actions/execute',{actor:'sam',action:'settings.change',args:{threshold}});
  try{
    await Promise.all([maya.goto(`${server.url}/${explain?'?explain=1':''}`),sam.goto(`${server.url}/?actor=sam`)]);
    await balance(maya,5);await preview(maya,'Automatically approved');
    assert.equal(await maya.locator('[name="employeeId"], [name="leaveId"], [name="days"]').count(),0);
    assert.equal(await maya.locator('[data-action="settings.change"]').count(),0);
    assert.equal(await sam.locator('[data-action="leave.request"]').count(),0);
    const served=await(await fetch(`${server.url}/api/contract`)).json();
    assert.deepEqual(await maya.evaluate(async()=>{const r=await(await fetch('/api/contract')).json();return r;}),served);
    await maya.screenshot({path:new URL(`derived-time-off-${explain?'companion-':''}start.png`,artifacts).pathname,fullPage:true});
    // Two immediate programmatic submits still execute only one command.
    const firstResponse=maya.waitForResponse(r=>r.url().endsWith('/api/actions/execute')&&r.request().method()==='POST');
    await form(maya).evaluate(f=>{if(!(f instanceof HTMLFormElement))throw Error('Expected leave form.');f.requestSubmit();f.requestSubmit();});
    assert.equal((await(await firstResponse).json()).status,'committed');await balance(maya,4);
    assert.equal(Object.keys((await(await fetch(`${server.url}/api/snapshot`)).json()).state.records.leave).length,1);
    if(explain){await maya.locator('#evidence').filter({hasText:'"status": "committed"'}).waitFor();assert.match(await maya.locator('#evidence').innerText(),/leave.deduct-days/);}
    await dates(maya,'2026-11-23','2026-11-25');await preview(maya,'Needs Sam');
    const trip=await send(maya);assert.equal(trip.status,'pending');await balance(maya,4);
    await sam.locator('[data-grant]').waitFor();assert.match(await sam.locator('#inbox').innerText(),/Maya Chen[\s\S]*2026-11-23[\s\S]*2026-11-25[\s\S]*3/);
    await sam.screenshot({path:new URL('derived-time-off-manager.png',artifacts).pathname,fullPage:true});
    await dates(maya,'2026-11-26','2026-11-27');
    assert.equal((await approval(sam)).status,'committed');await balance(maya,1);
    assert.equal(await form(maya).locator('[name="start"]').inputValue(),'2026-11-26');await preview(maya,'requirements');
    assert.equal(await form(maya).locator('button[type="submit"]').isDisabled(),true);
    if(explain){assert.match(await maya.locator('#evidence').innerText(),/"status": "pending"/);await maya.click('#current-evidence');await maya.locator('#evidence').filter({hasText:'"status": "rejected"'}).waitFor();}
    await dates(maya,'2026-11-27','2026-11-26');await preview(maya,'end date must be on or after');
    await dates(maya,'2026-11-21','2026-11-22');await preview(maya,'Choose at least one weekday');
    checks.push('Maya 5→4→pending 4→1; duplicate submit lock; derived hidden/visible inputs; separate grant/resume; two contexts SSE; drafts preserved; date/precondition failures');
    await maya.selectOption('#actor','leo');await balance(maya,5);await dates(maya,'2026-11-26','2026-11-27');await preview(maya,'Automatically approved');
    const edit=sam.locator('[data-action="settings.change"]');await edit.locator('[name="threshold"]').fill('2');
    assert.equal((await clickCommand(sam,'actions/execute',edit.locator('button[type="submit"]'))).status,'committed');
    await preview(maya,'Needs Sam');await balance(maya,5);
    const leo=await send(maya);assert.equal(leo.status,'pending');assert.equal((await approval(sam)).status,'committed');await balance(maya,3);
    if(explain){await maya.click('#saved-evidence');await maya.locator('#evidence').filter({hasText:'"status": "pending"'}).waitFor();await maya.selectOption('#actor','maya');await balance(maya,1);assert.match(await maya.locator('#evidence').innerText(),/"actor": "leo"/);await maya.selectOption('#actor','leo');await balance(maya,3);}
    checks.push('Leo two days before/after actual threshold 3→2; saved request then grant/resume 5→3'+(explain?'; saved evidence preserved across preview/SSE/actor switch':''));
    const stale=await post('actions/execute',{actor:'leo',action:'leave.request',args:{start:'2026-11-30',end:'2026-12-01'}}),p=stale.snapshot.pending.find((p:{status:string})=>p.status==='pending');
    assert.equal((await post('approvals/grant',{actor:'maya',requestId:p.id,policyId:p.requirements[0].policyId})).code,'unauthorized-approval');
    assert.equal((await post('actions/execute',{actor:'leo',action:'settings.change',args:{threshold:3}})).code,'denied');
    await rule(2);await sam.locator(`[data-request="${p.id}"]`).filter({hasText:'Needs a new request'}).waitFor();
    const failed=await approval(sam);assert.equal(failed.code,'stale');await balance(maya,3);await sam.locator('#notice').filter({hasText:'Approval is saved, but completion failed'}).waitFor();
    const url=server.url,port=Number(new URL(url).port);await server.close();await maya.locator('#connection').filter({hasText:'Reconnecting'}).waitFor();server=await createLeaveServer({directory,port});await maya.locator('#connection').filter({hasText:'Live'}).waitFor();await balance(maya,3);
    const snapshot=await(await fetch(`${url}/api/snapshot`)).json();assert.equal(snapshot.state.records.employee.maya.values.balance,1);assert.equal(snapshot.state.records.employee.leo.values.balance,3);assert.equal(snapshot.pending.find((r:{id:string})=>r.id===p.id).grants.length,1);
    checks.push('unauthorized edit/grant; stale grant persists and resume fails honestly; restart and SSE resync same DB and port');
    for(const width of [1440,1280,768,390]){await maya.setViewportSize({width,height:900});assert.equal(await maya.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    await maya.screenshot({path:new URL(`derived-time-off-${explain?'companion-':''}mobile.png`,artifacts).pathname,fullPage:true});
    assert.deepEqual(errors,[]);const video=maya.video();await a.close();const source=video?await video.path():null;
    const report={status:'passed',directory,contractId:served.contractId,checks,errors,final:{maya:1,leo:3,threshold:2},recording:source};
    await writeFile(new URL(`derived-time-off-${explain?'companion-':''}browser-report.json`,artifacts),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));return report;
  }finally{await browser.close();await server.close();}
}
