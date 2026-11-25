import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {loadSource} from './load.ts';
import {parseSource} from './frontend.ts';
import {deriveApplication,buildInvocation} from '../application/derive.ts';
import prior from './fixtures/prior-leave.ts';
import {moduleSourcePage} from './highlight.ts';
import {present} from '../semantic/test-support.ts';

const loaded=loadSource('leave/browser.domain');
const flattened=loaded.modules.map(m=>m.source.split('\n').filter(l=>!/^(module|import|use)\b/.test(l)).join('\n')).join('\n');
const parse=(text:string)=>parseSource(text,{filename:'references.domain'});
test('loading declarations preserve explicit scope and reject invalid or duplicate modes',()=>{
  const global=(row:string)=>flattened.replace('\napplication\n',`\napplication\n  ${row}\n`);
  const view=(s:string,row:string)=>s.replace('    field name label "Team member"',`    ${row}\n    field name label "Team member"`);
  const contract=(s:string)=>deriveApplication(parse(s).declaration).contract;
  const base=contract(flattened);assert.ok(!Object.hasOwn(base,'loading')&&base.views.every(v=>!Object.hasOwn(v,'loading')));
  for(const [index,mode] of ['text','icon','skeleton','wait'].entries()){
    const local=['wait','text','icon','skeleton'][index],c=contract(view(global(`loading ${mode}`),`loading ${local}`));
    assert.deepEqual(c,{...base,loading:mode,views:[{...base.views[0],loading:local},...base.views.slice(1)]});
  }
  for(const insert of [global,(row:string)=>view(flattened,row)]){
    assert.throws(()=>parse(insert('loading spinner')),/Expected loading mode/);
    assert.throws(()=>parse(insert('loading wait\n    loading icon')),/Duplicate declaration 'loading'/);
  }
  for(const scope of ['application','view'])for(const invalid of [null,true,'spinner',{mode:'icon'}]){
    const d=structuredClone(loaded.declaration),app=present(d.application);
    Reflect.set(scope==='application'?app:present(app.views[0]),'loading',invalid);
    assert.throws(()=>deriveApplication(d),/Expected loading mode/);
  }
});
test('three explicit views share the exact legacy domain/state; browser preserves full contract',()=>{
  assert.deepEqual(loaded.declaration,prior);
  for(const view of ['browser','cli','mobile']){
    const {declaration,modules}=loadSource(`leave/${view}.domain`);
    assert.deepEqual(declaration.domain,prior.domain);assert.deepEqual(declaration.initialState,prior.initialState);
    assert.equal(modules.filter(m=>m.kind==='domain').length,1);
    assert.equal(modules.at(-1)?.kind,'view');
  }
  assert.deepEqual(deriveApplication(loaded.declaration).contract,deriveApplication(prior).contract);
  assert.deepEqual(loaded.bindingOrigins.map(b=>[b.id,b.kind]),[['request.employee','typed-reference'],['request.settings','singleton-selector'],['edit.settings','singleton-selector']]);
  for(const span of Object.values(loaded.sourceMap)){
    const source=readFileSync(span.filename,'utf8');assert.ok(span.start.offset>=0&&span.end.offset<=source.length);
    assert.equal(source.slice(0,span.start.offset).split('\n').length,span.start.line);
  }
  const html=moduleSourcePage('leave/browser.domain');
  assert.equal((html.match(/<iframe /g)??[]).length,3);
  for(const m of loaded.modules)assert.ok(html.includes(m.filename));
});
test('references lower lazily, fail closed, retain policy authorization and record dependencies',()=>{
  assert.throws(()=>parse(flattened.replace('employeeId reference employee as employee','employeeId string')),/Unknown reference 'employee'/);
  assert.throws(()=>parse(flattened.replace('employeeId reference employee as employee','employeeId reference missing as employee')),/Unknown resource/);
  assert.throws(()=>parse(flattened.replace('leaveId string','leaveId reference employee as employee')),/Ambiguous reference/);
  assert.throws(()=>parse(flattened.replace('  preconditions','  bind employee from employee key employeeId\n  preconditions')),/Duplicate binding alias/);
  assert.throws(()=>parse(flattened.replace('employeeId reference employee as employee','employeeId reference employee as settings')),/Ambiguous reference 'settings'/);
  assert.throws(()=>parse(flattened.replace('employeeId reference employee as employee','employeeId reference employee as employee\n    another reference employee as settings')),/Ambiguous reference 'settings'/);
  const d=deriveApplication(loaded.declaration);
  const inv=buildInvocation(d.contract,{action:'leave.request',actor:'maya',args:{start:'2026-11-20',end:'2026-11-20'},id:'test',clock:1});
  const denied=d.runtime.execute(d.initialState,{...inv,actor:'leo'});
  assert.equal(denied.status,'rejected');assert.equal(denied.code,'denied');
  const originalSettings=present(d.initialState.records['settings']);
  const settings:{-readonly [K in keyof typeof originalSettings]:typeof originalSettings[K]}={...originalSettings,alternate:present(originalSettings['leave-rule'])};delete settings['leave-rule'];
  const missing=d.runtime.execute({...d.initialState,records:{...d.initialState.records,settings}},inv);
  assert.equal(missing.status,'rejected');assert.equal(missing.code,'missing-record');
  const employee={...d.initialState.records['employee']};delete employee['maya'];
  const noEmployee=d.runtime.execute({...d.initialState,records:{...d.initialState.records,employee}},inv);
  assert.equal(noEmployee.status,'rejected');assert.equal(noEmployee.code,'missing-record');
  const unused=parse(flattened.replace('leaveId string','leaveId string\n    optional reference employee as unused')).declaration;
  assert.deepEqual(present(unused.domain.actions['leave.request']).bindings,prior.domain.actions['leave.request'].bindings);
  const renamed=parse(flattened.replaceAll('employee','person').replaceAll('settings','configuration')).declaration;
  assert.deepEqual(present(renamed.domain.actions['leave.request']).bindings.map(b=>b.resource),['person','configuration']);
  const r=deriveApplication(renamed).runtime.execute(renamed.initialState,{...inv,args:{...inv.args,personId:'maya'}});
  // The old employeeId is intentionally not accepted after renaming the schema.
  assert.equal(r.status,'rejected');assert.equal(r.code,'invalid');
  const {employeeId,...previousArgs}=inv.args;
  const args={...previousArgs,personId:present(employeeId)};
  assert.equal(deriveApplication(renamed).runtime.execute(renamed.initialState,{...inv,args}).status,'committed');
});
test('real relative graph resolution rejects cycles, duplicate IDs/imports, missing use and domain leakage',()=>{
  const dir=mkdtempSync('/tmp/opencode/modules-');
  const put=(name:string,text:string)=>writeFileSync(`${dir}/${name}.domain`,text);
  put('a','module "a" view\nimport "./b.domain"\nuse "b"\n');
  put('b','module "b" domain\nimport "./a.domain"\ndomain "b"\n');
  assert.throws(()=>loadSource(`${dir}/a.domain`),/cycle/);
  put('b','module "a" domain\ndomain "b"\n');assert.throws(()=>loadSource(`${dir}/a.domain`),/Duplicate module ID/);
  put('b','module "b" domain\ndomain "b"\n');
  put('a','module "a" view\nimport "./b.domain"\nimport "./b.domain"\nuse "b"\n');assert.throws(()=>loadSource(`${dir}/a.domain`),/Duplicate import/);
  put('a','module "a" view\nimport "./b.domain"\nuse "missing"\n');assert.throws(()=>loadSource(`${dir}/a.domain`),/missing imported module/);
  put('data','module "data" data\nimport "./b.domain"\nuse "b"\n');
  put('a','module "a" view\nimport "./data.domain"\nuse "data"\n');assert.throws(()=>loadSource(`${dir}/a.domain`),/directly imported domain/);
  put('a','module "a" view\nimport "./absent.domain"\nuse "b"\n');assert.throws(()=>loadSource(`${dir}/a.domain`),/ENOENT/);
  put('a','module "a" view\nimport "node:fs"\nuse "b"\n');assert.throws(()=>loadSource(`${dir}/a.domain`),/relative/);
  put('a','module "a" view\nimport "./b.domain"\nuse "b"\nresource injected\n field name string\nend\napplication\n title "Bad"\n actor a label "A"\nend\n');
  assert.throws(()=>loadSource(`${dir}/a.domain`),/not allowed in a view module/);
});
