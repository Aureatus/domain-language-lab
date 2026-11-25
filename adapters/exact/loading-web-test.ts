// Run against loading-fixture.ts generated AND compiled in a fresh workspace.
// An explicit URL is required so the live server cannot be tested by accident.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const url=process.argv[2];
if(!url||!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)||url.endsWith(':4186'))throw Error('Supply an isolated adapter URL.');
const require=createRequire(`${process.env['EXACT_ROOT']??'/tmp/opencode/exact-source'}/package.json`);
const browser=await require('playwright-core').chromium.launch({headless:true});
try{
  const page=await browser.newPage(),errors:string[]=[];
  page.setDefaultTimeout(6000);
  page.on('pageerror',e=>errors.push(e.message));
  let gate;
  function hold(){let release,seen;gate={done:new Promise(r=>{release=r;}),started:new Promise(r=>{seen=r;}),release,seen};return gate;}
  await page.route('**/api/snapshot',async route=>{
    const current=gate;
    if(current){current.seen();if(await current.done==='fail')return route.abort('failed');}
    return route.continue();
  });
  const by=id=>page.getByTestId(id),rows=page.locator('[data-testid^="view:"]'),loaders=page.locator('[data-testid^="loading:"]');
  const loading=async()=>{
    await by('loading:0:icon').waitFor();
    assert.equal(await by('loading:0:icon').getAttribute('aria-label'),'Loading Record group 0…');
    assert.equal(await by('loading:1:text').innerText(),'Loading Record group 1…');
    assert.equal(await by('loading:2:skeleton').getAttribute('aria-label'),'Loading Record group 2…');
    assert.equal(await loaders.count(),3);assert.equal(await rows.count(),0);
  };
  const ready=async actor=>{
    await by(`view:3:${actor}`).waitFor();
    assert.equal(await rows.count(),4);assert.equal(await loaders.count(),0);
    assert.equal(await page.locator('[data-testid^="screen-"]').count(),0);
  };
  const initial=hold();await page.goto(url);await loading();initial.release('fail');
  await by('screen-failed').waitFor();assert.equal(await rows.count(),0);
  gate=null;await by('refresh').click();await ready('maya');
  const draft=by('maya:leave.request:start');await draft.fill('2026-11-23');
  const bounds=await draft.boundingBox();
  const refreshing=hold();await by('refresh').click();await refreshing.started;
  await ready('maya');assert.deepEqual(await draft.boundingBox(),bounds);assert.equal(await draft.inputValue(),'2026-11-23');
  refreshing.release('fail');await by('screen-stale').waitFor();assert.equal(await rows.count(),4);
  const switching=hold();await by('actor').selectOption('sam');await loading();
  assert.equal(await draft.count(),0);assert.equal(await by('screen-stale').count(),0);
  gate=null;await by('actor').selectOption('leo');await ready('leo');
  switching.release();await page.waitForLoadState('networkidle');await ready('leo');
  assert.equal(await by('view:0:sam').count(),0);assert.deepEqual(errors,[]);
  console.log('Compiled Exact web: mixed initial modes, explicit failure/retry, retained refresh rows/draft/bounds, stale warning, actor switch and late reply passed.');
}finally{await browser.close();}
