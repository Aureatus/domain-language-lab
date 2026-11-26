import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createInterpreter} from '../../semantic/core.ts';
import {generate, hash, MAX, Unsupported} from './generate.ts';
import {check, PINNED_LEAN} from './check.ts';
import {model, obligation} from './fixture.ts';
import {present} from '../../semantic/test-support.ts';

const out = fileURLToPath(new URL('./test-output', import.meta.url));
mkdirSync(out, {recursive: true});
const clone = <T>(x:T) => structuredClone(x);
const action = (m:typeof model) => m.actions['capacity.take'];
const lit = (value:string|boolean|number) => ({op: 'literal', value});
const input = (name:string) => ({op: 'input', name});
const add = <L,R>(left:L,right:R) => ({op: 'add', left, right});
const sub = <L,R>(left:L,right:R) => ({op: 'sub', left, right});
type Capacity={remaining:number;previous:number;revision:number;version:number};
const record = (s:Capacity) => `{ remaining := (${s.remaining} : Int), previous := (${s.previous} : Int), revision := (${s.revision} : Int), version := (${s.version} : Int) }`;

// Each runtime outcome becomes an independently checked Lean equality, not a JS
// interpreter of the generated code. Differential cases have allow-true policies.
function differential(name:string,m:typeof model,cases:{pre?:Partial<Capacity>;amount?:number;expected?:string;previous?:number;leanExpected?:string}[]) {
  const runtime = createInterpreter(m);
  const {code} = generate(m, obligation);
  let lean = present(code.split('-- Independent source obligation:')[0]);
  for (const [n, c] of cases.entries()) {
    const pre = {remaining: 10, previous: 0, revision: 0, version: 0, ...c.pre};
    const amount = c.amount ?? 3;
    const state = {revision: pre.revision, records: {capacity: {main: {version: pre.version, values: {remaining: pre.remaining, previous: pre.previous}}}}};
    const result = runtime.execute(state, {id: `case${n}`, action: 'capacity.take', args: {amount}, actor: 'tester', clock: 0});
    assert.ok(result.status === 'committed' || result.status === 'rejected');
    if (c.expected) assert.equal(result.status === 'committed' ? 'committed' : result.code, c.expected);
    let expected;
    if (result.status === 'committed') {
      const r = present(present(result.state.records['capacity'])['main']);
      const remaining=r.values['remaining'],previous=r.values['previous'];
      assert.ok(typeof remaining==='number'&&typeof previous==='number');
      expected = `.committed ${record({remaining,previous,revision:result.state.revision,version:r.version})}`;
      if (c.previous !== undefined) assert.equal(r.values['previous'], c.previous);
    } else {
      assert.equal(result.status, 'rejected');
      assert.ok(['overflow', 'precondition', 'schema'].includes(result.code), result.code);
      expected = `.${c.leanExpected || result.code}`;
    }
    lean += `-- runtime cross-check ${name}/${n}\nexample : step ${record(pre)} { amount := (${amount} : Int), clock := 0 } = ${expected} := by decide\n`;
  }
  lean += 'end Generated\n';
  const path = resolve(out, `${name}.lean`);
  writeFileSync(path, lean);
  const run = spawnSync(PINNED_LEAN, [path], {encoding: 'utf8', timeout: 120000});
  assert.equal(run.status, 0, `${run.error || ''}\n${run.stdout}\n${run.stderr}`);
}

test('pinned Lean checks generated nonvacuous law and complete axiom reports', () => {
  const report = check(model, obligation, resolve(out, 'positive'));
  assert.equal(report.status, 'proof_checked', report.detail);
  assert.deepEqual(Object.keys(report.theorem_axioms), ['preserves', 'positive_witness']);
  assert.deepEqual(report.theorem_axioms['positive_witness'], []);
  assert.equal(report.semantic_primitives_sha256, hash(readFileSync(new URL('../../semantic/primitives.ts', import.meta.url), 'utf8')));
});

test('Lean command-line reports agree with persisted proof evidence and fail on unsupported laws', t => {
  const directory=mkdtempSync(resolve(tmpdir(),'premise-lean-cli-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const input=resolve(directory,'model.json'),law=resolve(directory,'law.json');
  writeFileSync(input,JSON.stringify(model));
  const run=(entry:string,args:string[])=>spawnSync(process.execPath,[entry,...args],{encoding:'utf8'});
  const valid=resolve(directory,'valid');
  writeFileSync(law,JSON.stringify(obligation));
  const checked=run('adapters/lean/check.ts',[input,law,valid]);
  assert.equal(checked.status,0,checked.stderr);
  const report=JSON.parse(checked.stdout);
  assert.deepEqual(report,JSON.parse(readFileSync(resolve(valid,'report.json'),'utf8')));
  assert.equal(report.status,'proof_checked');
  assert.deepEqual(report.theorem_axioms,{preserves:['propext'],positive_witness:[]});
  for(const [patch,detail] of [
    [{format:'unknown'},/Unsupported law format/],
    [{id:'invalid id'},/Unsupported law ID/],
    [{witness:null},/Invalid law witness/],
    [{witness:{...obligation.witness,pre:null}},/Invalid law witness record/],
  ] satisfies [object,RegExp][]){
    const rejected=resolve(directory,'rejected');
    writeFileSync(law,JSON.stringify({...obligation,...patch}));
    const unsupported=run('adapters/lean/check.ts',[input,law,rejected]);
    assert.equal(unsupported.status,1,unsupported.stderr);
    const failure=JSON.parse(unsupported.stdout);
    assert.equal(failure.status,'unsupported');
    assert.match(failure.detail,detail);
    assert.deepEqual(failure.theorem_axioms,{});
  }
  const inventory=resolve(directory,'inventory');
  const projected=run('adapters/lean/inventory.ts',[inventory]);
  assert.equal(projected.status,0,projected.stderr);
  const summary=JSON.parse(projected.stdout),persisted=JSON.parse(readFileSync(resolve(inventory,'report.json'),'utf8'));
  assert.equal(summary.status,'proof_checked');
  assert.equal(summary.source_sha256,persisted.inventory.source_sha256);
  assert.match(summary.source_sha256,/^[0-9a-f]{64}$/);
});

test('unsupported selected strings, dynamic binding, boolean schema and operators fail closed', () => {
  const edits:((m:typeof model)=>void)[]=[
    m => {Reflect.set(m.resources.capacity.fields,'remaining',{type:'string'});},
    m => {Reflect.set(present(action(m).bindings[0]),'key',input('amount'));},
    m => {Reflect.set(action(m).inputs,'extra',{type:'boolean'});},
    m => {present(action(m).updates[0]).value.op = 'mul';},
    m => {action(m).updates.push({...present(action(m).updates[0]), id: 'duplicate.update'});},
  ];
  for(const edit of edits){
    const m = clone(model); edit(m);
    assert.throws(() => generate(m, obligation), Unsupported);
  }
  const m = clone(model); present(action(m).updates[0]).value.op = 'mul';
  assert.equal(check(m, obligation, resolve(out, 'unsupported')).status, 'unsupported');
});

test('changed declaration changes actual generated semantics; overselling fails same law', () => {
  const m = clone(model);
  Reflect.set(present(action(m).updates[0]).value,'right',add(input('amount'),lit(1)));
  const original = generate(model, obligation), mutant = generate(m, obligation);
  assert.notEqual(original.code, mutant.code);
  assert.notEqual(original.metadata.source_sha256, mutant.metadata.source_sha256);
  assert.match(mutant.code, /s.remaining - \(i.amount \+ \(1 : Int\)\)/);
  // Give the mutant its correct successful witness: failure must be the law,
  // not merely the unchanged positive example.
  const mutantLaw = clone(obligation); mutantLaw.witness.post.remaining = 6;
  const report = check(m, mutantLaw, resolve(out, 'overselling'));
  assert.equal(report.status, 'not_checked');
  const log = readFileSync(resolve(out, 'overselling/check.log'), 'utf8');
  assert.match(log, /omega could not prove the goal/);
  assert.match(log, /'Generated.positive_witness' does not depend on any axioms/);
  differential('overselling-semantics', m, [{expected: 'committed'}]);
});

test('safe integer boundaries, grouped prestate values, revision/version overflow match runtime', () => {
  differential('boundaries-grouping', model, [
    {expected: 'committed', previous: 10},
    {pre: {remaining: 3}, expected: 'committed', previous: 3},
    {pre: {remaining: 2}, expected: 'precondition'},
    {pre: {remaining: MAX}, amount: MAX, expected: 'committed', previous: MAX},
    {pre: {remaining: MAX, revision: MAX - 1, version: MAX - 1}, amount: MAX, expected: 'committed'},
    {pre: {revision: MAX}, expected: 'overflow'},
    {pre: {version: MAX}, expected: 'overflow'},
    {amount: 0, expected: 'schema', leanExpected: 'invalid'},
  ]);
});

test('intermediate overflow cannot cancel; eager boolean RHS is evaluated', () => {
  const m = clone(model);
  Reflect.set(present(action(m).updates[0]),'value',sub(add(lit(MAX),input('amount')),lit(MAX)));
  differential('intermediate-overflow', m, [{expected: 'overflow'}, {pre: {remaining: 0}, expected: 'precondition'}]);
  for (const op of ['and', 'or']) {
    const eager = clone(model);
    Reflect.set(present(action(eager).preconditions[0]),'when',{op,left:lit(op==='or'),right:{op:'eq',left:add(lit(MAX),lit(1)),right:lit(0)}});
    differential(`eager-${op}`, eager, [{expected: 'overflow'}]);
  }
});

test('ordered preconditions stop before later overflowing guard', () => {
  const m = clone(model);
  Reflect.set(action(m).preconditions,action(m).preconditions.length,{id:'capacity.later',when:{op:'eq',left:add(lit(MAX),lit(1)),right:lit(0)}});
  differential('guard-order', m, [{pre: {remaining: 2}, expected: 'precondition'}, {expected: 'overflow'}]);
});

test('boolean equality, negation, comparisons and explicit clock are translated', () => {
  const m = clone(model);
  Reflect.set(present(action(m).preconditions[0]),'when',{op:'eq',left:{op:'not',value:{op:'lt',left:{op:'clock'},right:lit(0)}},right:lit(true)});
  differential('boolean-equality-clock', m, [{expected: 'committed'}]);
});

test('signed lower boundary and update schema failure precede later overflow', () => {
  const signed = clone(model);
  Reflect.set(signed.resources.capacity.fields,'remaining',{type:'integer'});
  Reflect.set(signed.resources.capacity.fields,'previous',{type:'integer'});
  action(signed).preconditions = [];
  differential('signed-boundary', signed, [
    {pre: {remaining: -MAX + 1}, amount: 1, expected: 'committed', previous: -MAX + 1},
    {pre: {remaining: -MAX}, amount: 1, expected: 'overflow'},
  ]);
  const m = clone(model);
  action(m).preconditions = [];
  Reflect.set(present(action(m).updates[1]),'value',add(lit(MAX),lit(1)));
  differential('update-error-order', m, [{pre: {remaining: 2}, expected: 'schema'}]);
});

test('missing/wrong Lean executable reports tool_error, never checked', () => {
  assert.equal(check(model, obligation, resolve(out, 'missing-tool'), '/nonexistent/lean').status, 'tool_error');
  assert.equal(check(model, obligation, resolve(out, 'wrong-tool'), '/usr/bin/true').status, 'tool_error');
});

test('runtime stale commit rejects; this is not a generated concurrency theorem', () => {
  const runtime = createInterpreter(model);
  const state = {revision: 0, records: {capacity: {main: {version: 0, values: {remaining: 10, previous: 0}}}}};
  const invoke = (id:string) => ({id, action: 'capacity.take', args: {amount: 3}, actor: 'tester', clock: 0});
  const pending = runtime.prepare(state, invoke('first'));
  const other = runtime.execute(state, invoke('second'));
  assert.equal(pending.status, 'prepared'); assert.equal(other.status, 'committed');
  const stale=runtime.commit(other.state, pending.prepared);
  assert.equal(stale.status,'rejected'); assert.equal(stale.code,'stale');
});
