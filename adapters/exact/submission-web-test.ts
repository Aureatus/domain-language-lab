// Destructive trace: run only against a fresh isolated leave fixture.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const url=process.argv[2];
if(!url||!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)||url.endsWith(':4186'))throw Error('Supply an isolated adapter URL.');
const require=createRequire(`${process.env['EXACT_ROOT']??'/tmp/opencode/exact-source'}/package.json`);
const browser=await require('playwright-core').chromium.launch({headless:true});
try{
  const page=await browser.newPage(),writes:{submissionId:string}[]=[],errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(8000);
  const actor=page.getByTestId('actor'),notice=page.getByTestId('notice');
  const field=name=>page.getByTestId('maya:leave.request:'+name);
  const balance=async()=>(await (await fetch(url+'/api/snapshot')).json()).state.records.employee.maya.values.balance;
  assert.equal(await balance(),5);
  await page.goto(url);
  await field('start').fill('2026-11-25');await field('end').fill('2026-11-23');
  await field('execute').click();await notice.filter({hasText:'end date must be on or after'}).waitFor();
  assert.equal(await field('start').inputValue(),'2026-11-25');
  assert.equal(await field('start').isEnabled(),true);assert.equal(await field('check').count(),0);
  await field('start').fill('2026-11-20');await field('end').fill('2026-11-20');
  // Lose the first request before delivery, then lose the retry's reply after commit.
  await page.route('**/api/actions/execute',async route=>{
    writes.push(route.request().postDataJSON());
    if(writes.length===2)assert.equal((await route.fetch()).status(),200);
    await route.abort('failed');
  });
  await field('execute').click();
  await page.getByRole('button',{name:'Check submission'}).waitFor();
  assert.equal(await field('execute').isDisabled(),true);assert.equal(await field('retry').count(),0);
  await actor.selectOption('leo');
  assert.equal(await page.getByRole('button',{name:'Check submission'}).count(),0);
  await actor.selectOption('maya');
  assert.equal(await field('start').inputValue(),'2026-11-20');
  await field('check').click();await field('retry').waitFor();
  assert.equal(writes.length,1);assert.equal(await balance(),5);assert.equal(await field('execute').isDisabled(),true);
  await field('retry').click();await field('check').waitFor();
  assert.ok(writes[0]?.submissionId);assert.deepEqual(writes[0],writes[1]);assert.equal(await balance(),4);
  await field('check').click();await notice.filter({hasText:'Saved.'}).waitFor();
  assert.equal(await field('check').count(),0);assert.equal(writes.length,2);assert.equal(await balance(),4);
  assert.deepEqual(errors,[]);
  console.log('Exact web: owner-scoped unknown → not-found → same-body/id retry → lost reply → reconciled commit. One debit.');
}finally{await browser.close();}
