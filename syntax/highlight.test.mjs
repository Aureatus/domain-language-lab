import test from 'node:test';
import assert from 'node:assert/strict';
import {highlight,sourcePage,sourceExcerptPage} from './highlight.mjs';
import {readFileSync} from 'node:fs';
import {parseSource} from './frontend.mjs';
import source from './fixtures/legacy-source.mjs';

test('highlighting preserves source and escapes HTML without interpreting string comments',()=>{
  const source='field end string\n# <comment>\nrequire days <= 3 id "a#<b>\\\""\n';
  const rendered=highlight(source);
  assert.ok(rendered.includes('class="comment"># &lt;comment&gt;'));
  assert.ok(rendered.includes('class="string">&quot;a#&lt;b&gt;'));
  assert.ok(!rendered.includes('class="keyword">end'));
  const decoded=rendered.replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|quot|#39);/g,(_,v)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[v]));
  assert.equal(decoded,source);
  assert.ok(sourcePage(source,'<file>').includes('<title>&lt;file&gt;</title>'));
});

test('reader uses parser sections and excerpts retain actual line positions',()=>{
  const {sections}=parseSource(source);
  assert.deepEqual(sections.filter(s=>s.kind==='action').map(s=>s.line),source.split('\n').flatMap((line,i)=>line.startsWith('action ')?[i+1]:[]));
  assert.equal(sections.at(-1).line,source.split('\n').indexOf('application')+1);
  const page=sourcePage(source,'<file>');assert.match(page,/Whole file/);assert.doesNotMatch(page,/<details|id="ids"|id="compact"/);
  assert.equal((page.match(/class="line"/g)??[]).length,source.trimEnd().split('\n').length);
  const excerpt=sourceExcerptPage(source);assert.match(excerpt,/settings.set-threshold/);
  assert.throws(()=>sourceExcerptPage(source,{ids:['unknown']}),/Unknown excerpt/);
  const invalid=sourcePage('domain "x"\nunknown <tag>','<title>');
  assert.match(invalid,/class="diagnostic"/);assert.match(invalid,/&lt;tag&gt;/);assert.ok(!invalid.includes('<tag>'));
});

test('quiet ID display distinguishes annotation from an input named id or ID-like string',()=>{
  const html=highlight('require id == "id" id "clause"\nset employee.id = input.id id unquoted\n',{quietIds:true});
  assert.equal((html.match(/class="quiet-id"/g)??[]).length,2);
  assert.match(html,/class="quiet-id"><span class="keyword">id<\/span> <span class="string">&quot;clause/);
  assert.match(html,/class="quiet-id"><span class="keyword">id<\/span> unquoted<\/span>/);
});

test('local editor manifest and TextMate regex grammar remain valid JSON and regex',()=>{
  const root=new URL('./editor/',import.meta.url);
  const manifest=JSON.parse(readFileSync(new URL('package.json',root),'utf8'));
  assert.deepEqual(manifest.contributes.languages[0].extensions,['.domain']);
  JSON.parse(readFileSync(new URL('language-configuration.json',root),'utf8'));
  const grammar=JSON.parse(readFileSync(new URL('domain.tmLanguage.json',root),'utf8'));
  const visit=node=>{if(!node||typeof node!=='object')return;for(const [key,value] of Object.entries(node)){if(['match','begin','end'].includes(key))new RegExp(value);else visit(value)}};
  visit(grammar);
});
