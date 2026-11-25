import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {parseSource,SourceError,tokenize} from './frontend.ts';
import prior from './fixtures/prior-leave.ts';
import current,{sourceMap} from '../leave/model.ts';
import {deriveApplication,buildInvocation} from '../application/derive.ts';
import {createApplicationServer} from '../application/server.ts';

import source from './fixtures/legacy-source.ts';
const parse=s=>parseSource(s,{filename:'fixture.domain'});
const invocation=(derived,days=1,id='syntax-test')=>buildInvocation(derived.contract,{action:'leave.request',actor:'maya',args:{start:'2026-11-23',end:days===1?'2026-11-23':'2026-11-24'},id,clock:1});

test('independent fixed prior fixture exactly equals full parsed model, state and metadata',()=>{
  assert.deepEqual(parse(source).declaration,prior);
  assert.deepEqual(current,prior);
  assert.deepEqual(deriveApplication(current).contract,deriveApplication(prior).contract);
});

test('stable IDs map to exact spans; whitespace/comments change no semantic content',()=>{
  for(const id of ['time-away','employee','leave.request','request.employee','leave.enough-days','leave.owner-only','leave.manager-approval','leave.deduct-days','leave.create','settings.set-threshold']){
    const s=sourceMap[id],actual=readFileSync(s.filename,'utf8'),excerpt=actual.slice(s.start.offset,s.end.offset);
    assert.ok(excerpt.includes(id)||id==='request.employee',`${id} maps to its declaration or typed-reference identity`);
    assert.equal(actual.slice(0,s.start.offset).split('\n').length,s.start.line);
    const prefix=actual.slice(0,s.start.offset).split('\n').at(-1);
    assert.ok(prefix!==undefined);assert.equal(s.start.column,prefix.length+1);
    if(id==='leave.create')assert.match(excerpt,/end$/);
  }
  const formatted=source.split('\n').map(l=>`  ${l} # ignored`).join('\n');
  assert.deepEqual(parse(formatted).declaration,prior);
  assert.deepEqual(Object.keys(parse(formatted).sourceMap),Object.keys(parse(source).sourceMap));
});

test('strings, escapes, comments, keyword-looking field end and tight operators are unambiguous',()=>{
  const altered=source.replace('title "Time away"','title "A # title \\"quoted\\" \\n tab\\t slash\\\\"');
  assert.equal(parse(altered).declaration.application.title,'A # title "quoted" \n tab\t slash\\');
  assert.deepEqual(parse(source.replace('employee.balance - days','employee.balance-days')).declaration,prior);
  const adapter=parse(source).declaration.application.actions['leave.request'].adapters?.[0];
  assert.ok(adapter);assert.equal(adapter.mapping['end'],'end');
  assert.equal(tokenize('days>=3 # x\n')[1].value,'>=');
  assert.throws(()=>parse(source.replace('field balance label "Days remaining"','field name label "Days remaining"')),/Duplicate view field/);
  assert.throws(()=>parse(source.replace('settings from settings key "leave-rule" id "request.settings"','employee from settings key "leave-rule" id "request.settings"')),/Duplicate binding alias/);
});

test('precedence, parentheses, comparison reversal and left-associative subtraction elaborate explicitly',()=>{
  const policy=expr=>parse(source.replace('not actor == employeeId',expr)).declaration.domain.actions['leave.request'].policies[0].when;
  assert.deepEqual(policy('not actor == employeeId'),prior.domain.actions['leave.request'].policies[0].when);
  const e=policy('not days + 1 <= employee.balance and actor != employeeId or false');
  assert.equal(e.op,'or');assert.equal(e.left.op,'and');assert.equal(e.left.left.op,'not');
  assert.equal(e.left.left.value.op,'le');assert.equal(e.left.left.value.left.op,'add');assert.equal(e.left.right.op,'not');
  assert.equal(policy('(days + 1) > (employee.balance - 1)').op,'lt');
  const sub=parse(source.replace('employee.balance - days','employee.balance - days - 1')).declaration.domain.actions['leave.request'].updates[0].value;
  assert.equal(sub.op,'sub');assert.equal(sub.left.op,'sub');
});

for(const [label,mutate,pattern] of [
  ['unknown statement',s=>s+'import "evil"\n',/Expected resource/],
  ['unknown expression',s=>s.replace('days <= employee.balance','mystery <= employee.balance'),/Unknown expression/],
  ['unknown field',s=>s.replace('days <= employee.balance','days <= employee.missing'),/Unknown binding\/field/],
  ['unknown resource',s=>s.replace('employee from employee','employee from missing'),/Unknown resource/],
  ['unknown relationship',s=>s.replace('through "leave.owner"','through "missing"'),/validation.*observation/i],
  ['unknown input metadata',s=>s.replace('field employeeId\n','field missing\n'),/Unknown action input/],
  ['unknown adapter',s=>s.replace('"utc-weekday-range/v1"','"foreign/v1"'),/Unsupported adapter/],
  ['duplicate action',s=>s.replace('action "settings.change"','action "leave.request"'),/Duplicate semantic ID/],
  ['duplicate field',s=>s.replace('    balance\n','    name\n'),/Duplicate declaration/],
  ['duplicate input',s=>s.replace('    leaveId string','    employeeId string'),/Duplicate declaration/],
  ['duplicate binding',s=>s.replace('settings from settings key "leave-rule" id "request.settings"','employee from settings key "leave-rule" id "request.settings"'),/Duplicate binding/],
  ['duplicate semantic ID',s=>s.replace('id "leave.deduct-days"','id "leave.enough-days"'),/Duplicate semantic ID/],
  ['duplicate metadata',s=>s.replace('title "Time away"','title "Time away"\n title "Again"'),/Duplicate declaration/],
  ['bad escape',s=>s.replace('title "Time away"','title "bad\\q"'),/Unsupported string escape/],
  ['unclosed string',s=>s.replace('title "Time away"','title "Time away'),/Unterminated string/],
  ['missing end',s=>s.trimEnd().slice(0,-3),/Unclosed block/],
  ['brace payload',s=>s.replace('days <= employee.balance','{days: 2}'),/Unexpected character/],
  ['function call',s=>s.replace('days <= employee.balance','check(days)'),/Unknown expression/],
  ['unknown operator',s=>s.replace('days <= employee.balance','days * 2 <= employee.balance'),/Expected 'id'/],
  ['ill typed expression',s=>s.replace('days <= employee.balance','"days" <= employee.balance'),/Binary type mismatch/],
  ['unsafe integer',s=>s.replace('balance = 5','balance = 9007199254740992'),/safe integer/],
] satisfies [string,(source:string)=>string,RegExp][])test(`reject ${label} with filename, line and column`,()=>{
  assert.throws(()=>parse(mutate(source)),e=>e instanceof SourceError&&/^fixture\.domain:\d+:\d+:/.test(e.message)&&pattern.test(e.message),label);
});

test('parsed execution keeps grouped prestate inserts, denial, preconditions and implicit facts',()=>{
  const d=deriveApplication(current),inv=invocation(d),result=d.runtime.execute(d.initialState,inv);
  assert.equal(result.status,'committed');assert.equal(result.state.records['employee']['maya'].values['balance'],4);
  assert.deepEqual(result.events.map(e=>e.kind),['action','change','create']);assert.deepEqual(result.events[0].recipients.map(r=>r.recipient),['sam']);
  assert.equal(result.state.records['leave'][inv.id].values['days'],1);
  const denied=d.runtime.execute(d.initialState,{...inv,actor:'leo'});
  assert.equal(denied.status,'rejected');assert.equal(denied.code,'denied');
  const precondition=d.runtime.execute(d.initialState,{...inv,args:{...inv.args,days:6}});
  assert.equal(precondition.status,'rejected');assert.equal(precondition.code,'precondition');
  // Insert must read old balance 5, not updated balance 4, even though set precedes it.
  const modified=parse(source.replace('days = input.days','days = employee.balance')).declaration;
  const g=deriveApplication(modified),r=g.runtime.execute(g.initialState,invocation(g));
  assert.equal(r.state.records['leave'][inv.id].values['days'],5);assert.equal(r.state.records['employee']['maya'].values['balance'],4);
  // Invalid create rolls back the update, publishing no facts.
  const existing={...d.initialState,records:{...d.initialState.records,leave:{...d.initialState.records['leave'],[inv.id]:result.state.records['leave'][inv.id]}}};
  const failed=d.runtime.execute(existing,inv);assert.equal(failed.status,'rejected');assert.equal(failed.code,'existing-record');assert.equal(failed.state.records['employee']['maya'].values['balance'],5);assert.equal('events' in failed?failed.events:undefined,undefined);
});

test('source-only threshold and input edits change actual derived forms and policy execution',()=>{
  const original=deriveApplication(current),inv=invocation(original,2);
  assert.equal(original.runtime.execute(original.initialState,inv).status,'committed');
  const edited=source.replace('threshold = 3','threshold = 2').replace('days like leave.days','days like leave.days\n    reason string enum "rest" "travel"');
  const d=deriveApplication(parse(edited).declaration),field=d.contract.actions['leave.request'].fields.find(f=>f.name==='reason');
  assert.ok(field);assert.equal(field.widget,'select');assert.equal(field.schema.type,'string');assert.deepEqual(field.schema.enum,['rest','travel']);
  const invalid=d.runtime.execute(d.initialState,inv);
  assert.equal(invalid.status,'rejected');assert.equal(invalid.code,'invalid');
  const pending=d.runtime.execute(d.initialState,{...inv,args:{...inv.args,reason:'rest'}});
  assert.equal(pending.status,'pending');assert.equal(pending.state.records['employee']['maya'].values['balance'],5);assert.deepEqual(pending.request.requirements[0].approvers,['sam']);
});

test('existing prior-model SQLite pending binding survives text loader with no model migration',async()=>{
  const directory=await mkdtemp('/tmp/opencode/syntax-binding-');
  let server=await createApplicationServer(prior,{directory});
  const post=async(path,body)=>(await fetch(`${server.url}/api/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
  let pending;
  try{pending=await post('actions/execute',{actor:'maya',action:'leave.request',args:{start:'2026-11-23',end:'2026-11-25'}});assert.equal(pending.status,'pending');}finally{await server.close();}
  server=await createApplicationServer(current,{directory});
  try{
    const p=pending.snapshot.pending[0],policyId=p.requirements[0].policyId;
    assert.equal((await post('approvals/grant',{actor:'sam',requestId:p.id,policyId})).status,'approved');
    const result=await post('approvals/resume',{actor:'sam',requestId:p.id});assert.equal(result.status,'committed');assert.equal(result.snapshot.state.records.employee.maya.values.balance,2);
  }finally{await server.close();}
});

test('source counter includes domain author text rather than hiding it behind the bridge',()=>{
  const result=spawnSync(process.execPath,['application/count.ts','leave','model.ts','server.ts'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);
  assert.ok(report.files.some(f=>f.path==='leave/time-away.domain'));assert.ok(report.files.some(f=>f.path==='leave/demo.domain'));assert.equal(report.total.files,5);
});
