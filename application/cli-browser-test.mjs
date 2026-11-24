// One server/database, independent browser and spawned CLI processes.
import {chromium} from '/tmp/opencode/workbench-tooling/node_modules/playwright/index.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createApplicationServer} from './server.mjs';
import declaration from '../leave/model.mjs';
const exec=promisify(execFile);
const server=await createApplicationServer(declaration,{directory:await mkdtemp('/tmp/opencode/cross-view-')});
const browser=await chromium.launch({headless:true});
const cli=async(...args)=>JSON.parse((await exec(process.execPath,['application/cli.mjs','--view','leave/cli.domain',...args,'--url',server.url,'--json'])).stdout);
try{
  const page=await browser.newPage();await page.goto(server.url);
  await page.locator('[data-field="balance"]').filter({hasText:'5'}).waitFor();
  await cli('execute','leave.request','--actor','maya','--args','{"start":"2026-11-23","end":"2026-11-25"}');
  await page.selectOption('#actor','sam');await page.locator('[data-grant]').waitFor();
  const [p]=await cli('inbox','--actor','sam');
  await page.locator('[data-grant]').click();await page.locator('.saved-grant').waitFor();
  assert.equal((await cli('resume',p.id,'--actor','sam')).status,'committed');
  await page.selectOption('#actor','maya');await page.locator('[data-field="balance"]').filter({hasText:'2'}).waitFor();
  assert.equal((await cli('resume',p.id,'--actor','sam')).code,'consumed');
  await cli('execute','leave.request','--actor','leo','--args','{"start":"2026-11-23","end":"2026-11-25"}');
  await page.selectOption('#actor','sam');await page.locator('[data-grant]').waitFor();
  await page.locator('[data-grant]').click();await page.locator('.saved-grant').waitFor();
  const pending=(await cli('inbox','--actor','leo')).find(x=>x.status==='pending');
  const form=page.locator('[data-action="settings.change"]');await form.locator('[name="threshold"]').fill('2');await form.locator('[type="submit"]').click();
  await page.locator('[data-field="threshold"]').filter({hasText:'2'}).waitFor();
  assert.equal((await cli('resume',pending.id,'--actor','sam')).code,'stale');
  assert.equal((await cli('list','employee')).leo.values.balance,5);
  console.log('PASS browser/CLI on one durable backend: CLI request → browser grant → CLI resume → browser SSE balance; duplicate/stale rejection');
}finally{await browser.close();await server.close();}
