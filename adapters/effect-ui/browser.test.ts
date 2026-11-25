import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chromium} from 'playwright';
import declaration from '../../leave/model.ts';
import {start} from './serve.ts';
import {present} from '../../semantic/test-support.ts';

const execute='**/api/actions/execute',reconcile='**/api/actions/reconcile';

test('Effect UI keeps Submit locked until the original receipt is recovered',{timeout:30000},async t=>{
  const model=structuredClone(declaration);
  const presentation=present(model.application.actions['leave.request']);
  presentation.label='Request leave';
  present(presentation.fields['start']).label='From';
  const app=await start({model});
  t.after(()=>app.close());
  const browser=await chromium.launch();
  t.after(()=>browser.close());
  const page=await browser.newPage(),errors: string[]=[],executes: {actor:string; submissionId:string; expectedContractId:string; args:Record<string,unknown>}[]=[];
  page.setDefaultTimeout(5000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',req=>{
    if(new URL(req.url()).pathname==='/api/actions/execute')executes.push(req.postDataJSON());
  });

  await page.goto(app.url);
  const form=page.locator('form[data-action="leave.request"]');
  const submit=form.getByRole('button',{name:'Request leave'});
  const first=form.getByLabel('From'),last=form.getByLabel('Last day');
  const snapshotVersion=version=>page.getByText(`Snapshot version: ${version}`,{exact:true});
  await snapshotVersion(0).waitFor();
  assert.deepEqual(await form.locator('input').evaluateAll(inputs=>inputs.map(input=>input.getAttribute('name'))),['start','end']);
  await first.fill('2026-11-23');
  await last.fill('2026-11-25');

  let original;
  // Persist the request on the real backend; drop only Chromium's response.
  await page.route(execute,async route=>{
    const response=await route.fetch({maxRetries:0});
    try{original=await response.json();}
    finally{await route.abort('failed');await response.dispose();}
  },{times:1});
  await submit.click();
  const check=page.getByRole('button',{name:'Check submission',exact:true});
  const retry=page.getByRole('button',{name:'Retry same submission',exact:true});
  await check.waitFor();
  assert.equal(original.status,'pending');
  assert.equal(original.snapshot.pending.length,1);
  assert.deepEqual(present(executes[0]).args,{start:'2026-11-23',end:'2026-11-25'});
  assert.equal(await submit.isDisabled(),true);

  await page.getByRole('button',{name:'Refresh records'}).click();
  await snapshotVersion(original.snapshot.snapshotVersion).waitFor();
  assert.equal(await submit.isDisabled(),true,'a fresh snapshot is not a receipt');
  assert.equal(await retry.count(),0);

  await page.reload();
  await check.waitFor();
  assert.equal(await first.inputValue(),'2026-11-23');
  assert.equal(await last.inputValue(),'2026-11-25');
  assert.equal(await submit.isDisabled(),true);

  const deliver=Promise.withResolvers<void>();
  await page.route(reconcile,async route=>{
    await deliver.promise;
    await route.continue();
  },{times:1});
  const assertChecking=async()=>{
    try{
      await check.click();
      await page.getByRole('status').filter({hasText:'Checking the original submission'}).waitFor();
      assert.equal(await submit.isDisabled(),true,'checking does not resolve the submission');
    }finally{deliver.resolve();}
  };
  const [response]=await Promise.all([page.waitForResponse(reconcile),assertChecking()]);
  assert.deepEqual(response.request().postDataJSON(),{
    actor:present(executes[0]).actor,submissionId:present(executes[0]).submissionId,expectedContractId:present(executes[0]).expectedContractId
  });
  const recovered=await response.json();
  assert.equal(recovered.status,original.status);
  assert.equal(recovered.submissionId,original.submissionId);
  assert.deepEqual(recovered.evidence.invocation,original.evidence.invocation);
  assert.equal(recovered.snapshot.pending.length,1);
  await page.getByRole('status').filter({hasText:'Original submission outcome: Approval needed'}).waitFor();
  assert.equal(await check.count(),0);
  assert.equal(await retry.count(),0);
  assert.equal(await submit.isEnabled(),true);
  assert.equal(executes.length,1);
  assert.deepEqual(errors,[]);
});

test('when the request never arrived, the only retry reuses the exact submission',{timeout:30000},async t=>{
  const app=await start();
  t.after(()=>app.close());
  const browser=await chromium.launch();
  t.after(()=>browser.close());
  const page=await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(app.url);
  const submit=page.getByRole('button',{name:'Request time off',exact:true});
  await page.route(execute,route=>route.abort('failed'),{times:1});
  const [first]=await Promise.all([page.waitForRequest(execute),submit.click()]);
  await page.getByRole('button',{name:'Check submission',exact:true}).click();
  const retry=page.getByRole('button',{name:'Retry same submission',exact:true});
  await retry.waitFor();
  assert.equal(await submit.isDisabled(),true);
  const [second]=await Promise.all([page.waitForRequest(execute),retry.click()]);
  assert.deepEqual(second.postDataJSON(),first.postDataJSON());
  await page.getByRole('status').filter({hasText:'Saved. Your records are up to date.'}).waitFor();
  assert.equal(await submit.isEnabled(),true);
  assert.equal((await (await fetch(app.url+'/api/snapshot')).json()).snapshotVersion,1);
});
