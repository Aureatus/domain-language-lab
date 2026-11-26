import {chromium} from 'playwright';
import {mkdtemp} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createApplicationServer} from './server.ts';
import type {ApplicationContract} from './derive.ts';
import {fixture,renamedFixture,extendedFixture} from './fixture.ts';
import leave from '../leave/model.ts';

const browser=await chromium.launch({headless:true});
const cases:[typeof fixture|ReturnType<typeof renamedFixture>,string,string,string,string,string,string][]=[[fixture,'supply.take','nora','quinn','quantity','stock','Quinn'],[renamedFixture(),'kit.issue','ari','devon','units','remaining','Quinn'],[extendedFixture(),'supply.take','nora','rory','quantity','stock','Rory']];
try{for(const [declaration,action,actor,reviewer,field,stock,expectedApprover] of cases){
  const server=await createApplicationServer(declaration,{directory:await mkdtemp('/tmp/opencode/fixture-browser-')});const page=await browser.newPage(),errors: string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(server.url);const form=page.locator(`[data-action="${action}"]`);await form.waitFor();
    assert.equal(await form.locator('select').count(),2);assert.equal(await form.locator('[type="checkbox"]').count(),1);
    const remote:{contract:ApplicationContract}=await(await fetch(`${server.url}/api/contract`)).json();
    const config=remote.contract.actions[action];assert.ok(config);
    const fields=config.fields.filter(f=>!f.hidden);assert.equal(await form.locator('input,select').count(),fields.length);
    if(declaration.domain.actions[action]?.inputs['memo']){await form.locator('[name="memo"]').fill('New declaration input');await page.locator('[data-action="supply.audit"] [name="note"]').waitFor();}
    await form.locator(`[name="${field}"]`).fill('2');await form.locator('[data-preview]').filter({hasText:`Needs ${expectedApprover}`}).waitFor();
    const response=page.waitForResponse(r=>r.url().endsWith('/api/actions/execute'));await form.locator('[type="submit"]').click();assert.equal((await(await response).json()).status,'pending');
    await page.selectOption('#actor',reviewer);await page.locator('[data-grant]').click();await page.locator('.saved-grant').waitFor();await page.locator('[data-resume]').click();
    await page.locator(`[data-field="${stock}"]`).filter({hasText:'6'}).waitFor();assert.deepEqual(errors,[]);
    console.log(`PASS ${action}: derived references, enum, checkbox, number, inbox and grant/resume (${actor} → ${reviewer})`);
  }finally{await page.close();await server.close();}
}
  const configured=structuredClone(leave);configured.application.loading='skeleton';
  const [,icon,wait]=configured.application.views;
  assert.ok(icon&&wait);icon.loading='icon';wait.loading='wait';
  const server=await createApplicationServer(configured,{directory:await mkdtemp('/tmp/opencode/configured-loading-')});
  const page=await browser.newPage();const {promise:gate,resolve:release}=Promise.withResolvers<void>();
  try{
    await page.route('**/api/contract',route=>route.abort('failed'),{times:1});
    await page.goto(server.url);await page.getByRole('button',{name:'Retry'}).waitFor();
    await page.route('**/api/snapshot',async route=>{await gate;await route.continue();});
    await page.getByRole('button',{name:'Retry'}).click({noWaitAfter:true});
    await page.locator('[data-loading="skeleton"]').waitFor();await page.locator('[data-loading="icon"]').waitFor();
    assert.equal(await page.locator('#lists').innerText(),'');assert.equal(await page.locator('[data-record]').count(),0);
    release();await page.locator('[data-record="maya"]').first().waitFor();assert.equal(await page.locator('[data-loading]').count(),0);
    console.log('PASS delayed initial snapshot: inherited skeleton, per-view icon and wait, then actual records');
  }finally{release();await page.close();await server.close();}
}finally{await browser.close();}
