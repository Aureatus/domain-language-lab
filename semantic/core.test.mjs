import test from 'node:test';
import assert from 'node:assert/strict';
import {createInterpreter, validateModel, validateState, jsonSnapshot} from './core.mjs';
import {issueModel, issueState} from './issues.mjs';

const copy = x => JSON.parse(JSON.stringify(x));
const lit = value => ({op: 'literal', value});
const field = (binding, name) => ({op: 'field', binding, field: name});
const bin = (op, left, right) => ({op, left, right});
const invocation = (id = 'inv1', extra = {}) => ({id, action: 'issue.resolve', args: {issueId: 'i1'}, actor: 'maya', clock: 42, ...extra});
const edit = fn => { const m = copy(issueModel); fn(m.actions['issue.resolve'], m); return m; };

test('issue declarations execute across resources with implicit provenance/routing', () => {
  const state = copy(issueState), original = copy(state);
  const r = createInterpreter(issueModel).execute(state, invocation());
  assert.equal(r.status, 'committed');
  assert.equal(r.state.records.issues.i1.values.status, 'resolved');
  assert.equal(r.state.records.issues.i1.values.updatedAt, 42);
  assert.equal(r.state.records.counters.global.values.resolved, 1);
  assert.equal(r.state.records.issues.i1.version, 1);
  assert.deepEqual(r.events.map(e => e.kind), ['action', 'change', 'change', 'change']);
  assert.equal(r.events[1].semanticId, 'resolve.status');
  assert.equal(r.events[0].id, 'event:inv1:action');
  assert.deepEqual(r.events[0].recipients, [{recipient: 'jon', paths: [{relationship: 'issue.watchers', resource: 'issues', key: 'i1'}]}]);
  assert.deepEqual(state, original);
  assert.equal(Object.isFrozen(state), false);
  assert.equal(Object.isFrozen(r.state.records.issues.i1.values), true);
});

test('editing declaration changes actual execution, not just metadata', () => {
  const runtime = createInterpreter(edit(a => { a.updates[2].value.right.value = 3; }));
  assert.equal(runtime.execute(issueState, invocation()).state.records.counters.global.values.resolved, 3);
});

test('grouped prestate swap, even across records; unmentioned fields preserved', () => {
  const model = edit(a => {
    a.updates = [
      {id: 'swap.first', target: 'resolve.issue', field: 'updatedAt', value: field('resolve.counter', 'resolved')},
      {id: 'swap.second', target: 'resolve.counter', field: 'resolved', value: field('resolve.issue', 'updatedAt')},
    ];
  });
  const state = copy(issueState); state.records.issues.i1.values.updatedAt = 9; state.records.counters.global.values.resolved = 4;
  const r = createInterpreter(model).execute(state, invocation());
  assert.equal(r.status, 'committed');
  assert.equal(r.state.records.issues.i1.values.updatedAt, 4);
  assert.equal(r.state.records.counters.global.values.resolved, 9);
  assert.equal(r.state.records.issues.i1.values.status, 'open');
});

test('pending is non-mutating and denial wins over both approval and allow', () => {
  const model = edit(a => a.policies.push({id: 'needs.review', effect: 'approval-required', when: lit(true)}));
  const state = copy(issueState), before = copy(state);
  const p = createInterpreter(model).execute(state, invocation());
  assert.equal(p.status, 'pending'); assert.equal(p.state, state); assert.equal(p.events, undefined);
  assert.deepEqual(p.policyIds, ['needs.review']); assert.deepEqual(state, before); assert.equal(Object.isFrozen(state), false);
  model.actions['issue.resolve'].policies.push({id: 'blocked', effect: 'deny', when: lit(true)});
  assert.equal(createInterpreter(model).execute(state, invocation()).code, 'denied');
  assert.equal(createInterpreter(edit(a => { a.policies = []; })).execute(state, invocation()).code, 'denied');
});

test('precondition failure distinct from authorization, no committed facts', () => {
  const state = copy(issueState); state.records.issues.i1.values.status = 'resolved';
  const r = createInterpreter(issueModel).execute(state, invocation());
  assert.equal(r.code, 'precondition'); assert.equal(r.reason, 'resolve.open');
  assert.equal(r.state, state); assert.equal(r.events, undefined);
  assert.equal(createInterpreter(issueModel).execute(issueState, invocation('inv1', {actor: 'jon'})).code, 'denied');
});

test('competing numeric reservations: stale commit rejected; deliberate stale-read mutant differs', () => {
  const model = edit(a => {
    a.inputs.amount = {type: 'integer', min: 1};
    a.preconditions = [{id: 'capacity.sufficient', when: bin('le', {op: 'input', name: 'amount'}, field('resolve.counter', 'resolved'))}];
    a.updates = [{id: 'capacity.consume', target: 'resolve.counter', field: 'resolved', value: bin('sub', field('resolve.counter', 'resolved'), {op: 'input', name: 'amount'})}];
  });
  const runtime = createInterpreter(model), state = copy(issueState); state.records.counters.global.values.resolved = 5;
  const inv = id => invocation(id, {args: {issueId: 'i1', amount: 4}});
  const p = runtime.prepare(state, inv('r1')), q = runtime.prepare(state, inv('r2'));
  assert.equal(p.status, 'prepared'); assert.equal(q.status, 'prepared');
  const first = runtime.commit(state, p.prepared); assert.equal(first.status, 'committed');
  const safe = runtime.commit(first.state, q.prepared); assert.equal(safe.code, 'stale'); assert.equal(safe.state, first.state);
  assert.equal(runtime.execute(first.state, inv('r2')).code, 'precondition');
  // Test-only bad host: commit against the OLD snapshot, then replace current state.
  const mutant = runtime.commit(state, q.prepared);
  assert.equal(mutant.status, 'committed');
  assert.equal(first.state.records.counters.global.values.resolved, 1);
  assert.equal(mutant.state.records.counters.global.values.resolved, 1);
  assert.equal(first.events[0].invocationId, 'r1'); assert.equal(mutant.events[0].invocationId, 'r2');
  // Two accepted reservations of four against five: the mutant loses a write.
  assert.ok(4 + 4 > state.records.counters.global.values.resolved);
});

test('tokens bound to interpreter, prestate content, authorization reads and frozen invocation', () => {
  const rt = createInterpreter(issueModel), state = copy(issueState), inv = invocation();
  const p = rt.prepare(state, inv); inv.clock = 99; inv.args.issueId = 'wrong';
  assert.equal(rt.commit(state, p.prepared).events[0].clock, 42);
  const changed = copy(state); changed.records.issues.i1.values.assignee = 'jon';
  assert.equal(rt.commit(changed, p.prepared).code, 'stale');
  assert.equal(createInterpreter(issueModel).commit(state, p.prepared).code, 'invalid-token');
  assert.equal(rt.commit(state, copy(p.prepared)).code, 'invalid-token');
});

test('safe integer boundaries, exact intermediate arithmetic and atomic failure', () => {
  const state = copy(issueState); state.records.counters.global.values.resolved = Number.MAX_SAFE_INTEGER - 1;
  const rt = createInterpreter(issueModel);
  assert.equal(rt.execute(state, invocation()).state.records.counters.global.values.resolved, Number.MAX_SAFE_INTEGER);
  state.records.counters.global.values.resolved = Number.MAX_SAFE_INTEGER;
  const before = copy(state), bad = rt.execute(state, invocation());
  assert.equal(bad.code, 'overflow'); assert.deepEqual(state, before); assert.equal(bad.state, state); assert.equal(Object.isFrozen(state), false);
  const m = edit(a => { a.updates[2].value = bin('sub', lit(-Number.MAX_SAFE_INTEGER), lit(1)); });
  assert.equal(createInterpreter(m).execute(issueState, invocation()).code, 'overflow');
  state.revision = Number.MAX_SAFE_INTEGER;
  assert.equal(rt.execute(state, invocation()).code, 'overflow');
  for (const badNumber of [NaN, Infinity, 1.5, -0, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(rt.execute(issueState, invocation('inv1', {clock: badNumber})).status, 'rejected');
  }
});

test('schema errors fail atomically after earlier valid assignments', () => {
  const rt = createInterpreter(edit(a => { a.updates[2].value = lit(-1); }));
  const state = copy(issueState), before = copy(state);
  const r = rt.execute(state, invocation()); assert.equal(r.code, 'schema'); assert.deepEqual(state, before); assert.equal(r.events, undefined);
});

test('unknown/unsupported or ill-typed declarations fail closed even if unreachable', () => {
  const cases = [
    a => { a.foreign = 'ignored?'; },
    a => { a.inputs.issueId.pattern = '.*'; },
    a => { a.updates[0].value = {op: 'eval', source: '1'}; },
    a => { a.updates[0].value = lit(1); },
    a => { a.policies.push({id: 'unsupported', effect: 'allow', when: bin('and', lit(false), {op: 'foreign'})}); },
    a => { a.bindings[0].key = field('resolve.issue', 'assignee'); },
    a => { a.updates[1].id = a.updates[0].id; },
    a => { a.observe[0].relationship = 'unknown'; },
  ];
  for (const mutation of cases) assert.throws(() => validateModel(edit(mutation)));
  assert.throws(() => validateModel({...issueModel, format: 'v999'}));
  const invalidModel = copy(issueModel); invalidModel.resources.issues.fields.watchers.type = 'unknown';
  assert.throws(() => validateState(invalidModel, issueState));
});

test('malformed inputs/state, accessors, sparse arrays, cycles rejected without executing getters', () => {
  const rt = createInterpreter(issueModel);
  for (const args of [{}, {issueId: 'i1', extra: true}, {issueId: 1}, {issueId: 'missing'}]) assert.equal(rt.execute(issueState, invocation('inv1', {args})).status, 'rejected');
  const invalidState = copy(issueState); invalidState.records.issues.i1.version = -1;
  assert.equal(rt.execute(invalidState, invocation()).status, 'rejected');
  const getter = {}; Object.defineProperty(getter, 'id', {enumerable: true, get() { throw Error('getter ran'); }});
  assert.throws(() => jsonSnapshot(getter), /Unsafe JSON property/);
  const cyclic = {}; cyclic.self = cyclic;
  for (const x of [cyclic, new Date(), [,,], {x: undefined}, JSON.parse('{"__proto__":1}')]) assert.throws(() => jsonSnapshot(x));
});

test('aliasing write targets is rejected rather than sequential last-writer-wins', () => {
  const model = edit(a => {
    a.bindings.push({id: 'other.issue', resource: 'issues', key: {op: 'input', name: 'issueId'}});
    a.updates.push({id: 'other.status', target: 'other.issue', field: 'status', value: lit('open')});
  });
  assert.equal(createInterpreter(model).execute(issueState, invocation()).code, 'conflicting-update');
});

test('routing uses poststate and retains multiple support paths, deterministic identity', () => {
  const model = edit(a => {
    a.updates.push({id: 'resolve.reassign', target: 'resolve.issue', field: 'assignee', value: lit('jon')});
  });
  const rt = createInterpreter(model), r = rt.execute(issueState, invocation());
  const recipients = r.events[0].recipients;
  assert.equal(recipients.length, 1); assert.equal(recipients[0].recipient, 'jon');
  assert.deepEqual(recipients[0].paths.map(p => p.relationship), ['issue.assignee', 'issue.watchers']);
  assert.deepEqual(r, rt.execute(issueState, invocation()));
});

test('boolean and comparison operators; eager errors cannot hide in false branches', () => {
  const model = edit(a => {
    a.preconditions = [{id: 'numeric.check', when: bin('and', bin('lt', lit(-1), lit(0)), bin('or', {op: 'not', value: lit(false)}, lit(false)))}];
  });
  assert.equal(createInterpreter(model).execute(issueState, invocation()).status, 'committed');
  model.actions['issue.resolve'].preconditions[0].when = bin('or', lit(true), bin('eq', bin('add', lit(Number.MAX_SAFE_INTEGER), lit(1)), lit(0)));
  assert.equal(createInterpreter(model).execute(issueState, invocation()).code, 'overflow');
});

test('version boundaries and no-op writes have explicit revision semantics', () => {
  const model = edit(a => { a.updates = [{id: 'same.status', target: 'resolve.issue', field: 'status', value: field('resolve.issue', 'status')}]; });
  const rt = createInterpreter(model), r = rt.execute(issueState, invocation());
  assert.equal(r.status, 'committed'); assert.equal(r.state.revision, 1);
  assert.equal(r.state.records.issues.i1.version, 1); assert.equal(r.events.length, 1);
  for (const target of ['revision', 'version']) {
    const state = copy(issueState);
    if (target === 'revision') state.revision = Number.MAX_SAFE_INTEGER;
    else state.records.issues.i1.version = Number.MAX_SAFE_INTEGER;
    assert.equal(rt.execute(state, invocation()).code, 'overflow');
  }
});

test('event IDs cannot collide through delimiter-bearing semantic identities', () => {
  const first = edit(a => { a.updates[2].id = 'x:change:y'; });
  const second = edit(a => { a.updates[2].id = 'y'; });
  const r1 = createInterpreter(first).execute(issueState, invocation('inv'));
  const r2 = createInterpreter(second).execute(issueState, invocation('inv:change:x'));
  assert.notEqual(r1.events.at(-1).id, r2.events.at(-1).id);
  assert.equal(r1.events.at(-1).id, 'event:inv:change:x%3Achange%3Ay');
});

test('bounded arithmetic cross-check: add/subtract versus exact mathematical integers', () => {
  const samples = [-Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER + 1, -1, 0, 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER];
  for (const op of ['add', 'sub']) {
    for (const left of samples) for (const right of samples) {
      const model = edit((a, m) => {
        // Remove application nonnegative bounds: this check covers signed integers.
        m.resources.counters.fields.resolved = {type: 'integer'};
        a.updates = [{id: 'arithmetic.result', target: 'resolve.counter', field: 'resolved', value: bin(op, lit(left), lit(right))}];
      });
      const actual = createInterpreter(model).execute(issueState, invocation());
      const exact = op === 'add' ? BigInt(left) + BigInt(right) : BigInt(left) - BigInt(right);
      if (exact < -9007199254740991n || exact > 9007199254740991n) assert.equal(actual.code, 'overflow');
      else { assert.equal(actual.status, 'committed'); assert.equal(BigInt(actual.state.records.counters.global.values.resolved), exact); }
    }
  }
});
