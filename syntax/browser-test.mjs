// Execute text-only edits through the real generic server/browser, no app code.
import {chromium} from '/tmp/opencode/workbench-tooling/node_modules/playwright/index.mjs';
import {mkdtemp,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {parseSource} from './frontend.mjs';
import {createApplicationServer} from '../application/server.mjs';
import text from './fixtures/legacy-source.mjs';
const edited=text.replace('threshold = 3','threshold = 2').replace('days like leave.days','days like leave.days\n    reason string enum "rest" "travel"');
const {declaration}=parseSource(edited,{filename:'edited.domain'});
const server=await createApplicationServer(declaration,{directory:await mkdtemp('/tmp/opencode/syntax-browser-')});
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url);
  const form=page.locator('[data-action="leave.request"]');await form.waitFor();
  assert.equal(await form.locator('select[name="reason"]').count(),1);
  assert.deepEqual(await form.locator('[name="reason"] option').allTextContents(),['rest','travel']);
  await form.locator('[name="reason"]').selectOption('travel');
  await form.locator('[name="start"]').fill('2026-11-23');await form.locator('[name="end"]').fill('2026-11-24');
  await form.locator('[data-preview]').filter({hasText:'Needs Sam'}).waitFor();
  const response=page.waitForResponse(r=>r.url().endsWith('/api/actions/execute'));
  await form.locator('[type="submit"]').click();const saved=await(await response).json();
  assert.equal(saved.status,'pending');assert.equal(saved.snapshot.pending[0].invocation.args.reason,'travel');
  assert.equal(saved.snapshot.state.records.employee.maya.values.balance,5);
  await page.selectOption('#actor','sam');await page.locator('[data-grant]').click();await page.locator('.saved-grant').waitFor();await page.locator('[data-resume]').click();
  await page.selectOption('#actor','maya');await page.locator('[data-field="balance"]').filter({hasText:'3'}).waitFor();
  assert.deepEqual(errors,[]);await page.close();
  console.log('PASS text-only threshold/input edits: generated enum form, real pending args, grant/resume and balance 5→3');
}finally{await browser.close();await server.close();}
