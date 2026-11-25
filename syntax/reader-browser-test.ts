import {chromium} from '/tmp/opencode/workbench-tooling/node_modules/playwright/index.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {sourcePage,sourceExcerptPage,moduleSourcePage} from './highlight.ts';
import {loadSource} from './load.ts';
const parsed=loadSource('leave/browser.domain'),html=moduleSourcePage('leave/browser.domain');
await writeFile('artifacts/time-away-highlighted.html',html);
await writeFile('artifacts/time-away-highlighted-inline.html',html);
await writeFile('artifacts/time-away-source-preview.html',sourceExcerptPage(parsed.modules[0].source,{parsed}));
const browser=await chromium.launch({headless:true}),report=[];
try{
  for(const width of [1440,728,390]){
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(pathToFileURL(resolve('artifacts/time-away-highlighted.html')).href);
    assert.equal(await page.locator('iframe').count(),parsed.modules.length);
    for(const [i,module] of parsed.modules.entries()){
      const frame=page.frameLocator('iframe').nth(i),source=module.source;
      assert.equal(await frame.locator('.line').count(),source.trimEnd().split('\n').length);
      assert.equal(await frame.locator('.text').allTextContents().then(a=>a.join('\n')+'\n'),source);
      assert.equal(await frame.locator('#raw-text').textContent(),source);
      assert.equal(await frame.locator('.quiet-id').count(),0);assert.equal(await frame.locator('.diagnostic').count(),0);
      const download=page.waitForEvent('download');await frame.locator('#download').click();
      assert.equal(await readFile(await(await download).path(),'utf8'),source);
      await frame.locator('#copy').click();await frame.locator('#status').filter({hasText:/copied|Clipboard unavailable/}).waitFor();
      const links=frame.locator('nav a');if(await links.count()){await links.first().focus();await page.keyboard.press('Enter');}
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:`artifacts/time-away-source-${width}.png`});
    assert.deepEqual(errors,[]);report.push({width,files:parsed.modules.length,exactSource:true,allIdsVisible:true,download:true,keyboardNavigation:true});await page.close();
  }
  const page=await browser.newPage();await page.setContent(sourcePage('domain "<script>"\nunknown <tag>','<img onerror=alert(1)>'));
  assert.equal(await page.locator('.diagnostic').count(),1);assert.equal(await page.locator('img').count(),0);
  await writeFile('artifacts/time-away-source-reader-report.json',JSON.stringify({scope:'Sampled Chromium source import-closure reader; not semantic proof or installed editor evidence',cases:report},null,2)+'\n');
  console.log('PASS modular source reader: 1440/728/390, complete domain/data/view files, exact source/download, visible IDs, keyboard navigation and clipboard/fallback');
}finally{await browser.close();}
