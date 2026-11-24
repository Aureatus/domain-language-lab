import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {lintSource} from './lint.mjs';
import source from './fixtures/legacy-source.mjs';
test('actual author source is lint clean, including adapter and hidden input contracts',()=>{
  assert.deepEqual(lintSource(source),[]);
});
test('AST references distinguish unused inputs from strings/comments and referenced inputs',()=>{
  const edited=source.replace('days like leave.days','days like leave.days\n    unused string\n    # unused is not a reference').replace('label "Request time off"','label "unused"');
  const diagnostics=lintSource(edited,{filename:'edited.domain'});
  assert.equal(diagnostics.length,1);
  assert.deepEqual(diagnostics[0],{filename:'edited.domain',line:edited.split('\n').indexOf('    unused string')+1,column:5,severity:'warning',ruleId:'usage/unused-input',message:"Input 'unused' has no core expression, host binding or adapter reference; review whether it is intended."});
  assert.deepEqual(lintSource(edited.replace('owner = employeeId','owner = unused')),[]);
});
test('whitespace advisories have stable positions and avoid string/comment content',()=>{
  assert.deepEqual(lintSource(source.replace('    name string','\tname string  ')).map(d=>[d.ruleId,d.line,d.column]),[['style/tab-indentation',6,1],['style/trailing-whitespace',6,13]]);
  assert.deepEqual(lintSource(source.replace('title "Time away"','title "input ghost string # \\t"\n  # input ghost string')),[]);
});
test('input use follows binding keys, host bindings and adapter mappings, not just labels',()=>{
  const edited=source.replace('key leaveId id','key "fixed" id').replace('start = input.start','start = "2026-11-20"').replace('end = input.end','end = "2026-11-20"');
  assert.deepEqual(lintSource(edited),[]);
  assert.equal(lintSource(edited.replace('      bind "operation-id"','      label "leaveId"'))[0].ruleId,'usage/unused-input');
  assert.deepEqual(lintSource(source.replaceAll('\n','\r\n')),[]);
});
test('lexical, unsupported, core and metadata errors fail rather than advisory pass',()=>{
  for(const edited of [source+'unknown\n',source.replace('days like leave.days','days decimal'),source.replace('      min 0','      min 9'),source.replace('label "Weekdays"','widget impossible')]){
    const d=lintSource(edited);assert.equal(d[0].severity,'error');assert.ok(d[0].line>0);assert.ok(d[0].column>0);
  }
  assert.equal(lintSource(source.replace('label "Weekdays"','widget impossible'))[0].ruleId,'domain/model-validation');
});
test('CLI JSON, exit policies, missing files and invalid arguments',()=>{
  const dir=mkdtempSync('/tmp/opencode/lint-'),path=dir+'/test.domain';
  const run=(...args)=>spawnSync(process.execPath,['syntax/lint.mjs',...args],{encoding:'utf8'});
  writeFileSync(path,source+'# trailing  \n');
  let result=run(path,'--json');assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).warnings,1);
  assert.equal(run(path,'--strict').status,1);
  writeFileSync(path,source+'unsupported\n');result=run(path,'--json');assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).errors,1);
  result=run(dir+'/missing','--json');assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).diagnostics[0].ruleId,'io/read-source');
  assert.equal(run(path,'--wat').status,1);
});
