import test from 'node:test';
import assert from 'node:assert/strict';
import {withStatus} from "../test-support.ts";
import {createInterpreter, validateModel, validateState, jsonSnapshot} from './core.ts';
import type {Expr, Model, Scalar, State} from './types.ts';
type Mutable<T> = T extends object ? {-readonly [K in keyof T]: Mutable<T[K]>} : T;
const lit = (value:Scalar):Mutable<Expr> => ({op: 'literal', value});
const input = (name:string):Mutable<Expr> => ({op: 'input', name});
const field = (binding:string, name:string):Mutable<Expr> => ({op: 'field', binding, field: name});
const copy = x => JSON.parse(JSON.stringify(x));
function fixture() {
  const model:Mutable<Model> = {format: 'semantic-core/v2', id: 'example.v2', resources: {items: {fields: {amount: {type: 'integer', min: 0}, owner: {type: 'string'}, reviewers: {type: 'ids'}}}}, relationships: [{id: 'owner.path', resource: 'items', field: 'owner'}], actions: {move: {
    inputs: {from: {type: 'string'}, to: {type: 'string'}}, bindings: [{id: 'source', resource: 'items', key: input('from')}],
    preconditions: [], policies: [{id: 'permit', when: lit(true), effect: 'allow'}], updates: [],
    inserts: [{id: 'make', resource: 'items', key: input('to'), values: {amount: field('source', 'amount'), owner: {op: 'actor'}, reviewers: field('source', 'reviewers')}}],
    deletes: [{id: 'remove', target: 'source'}], observe: [{binding: 'source', relationship: 'owner.path'}, {binding: 'make', relationship: 'owner.path'}]
  }}};
  const state:Mutable<State> = {revision: 0, records: {items: {old: {version: 4, values: {amount: 7, owner: 'former', reviewers: ['boss', 'actor']}}}}};
  const inv = {id: 'call1', action: 'move', args: {from: 'old', to: 'new'}, actor: 'actor', clock: 10};
  return {model, state, inv};
}
function pendingFixture() {
  const f = fixture();
  f.model.actions['move'].policies.push({id: 'review', effect: 'approval-required', when: lit(true), approvers: field('source', 'reviewers')});
  const runtime = createInterpreter(f.model), pending = runtime.execute(f.state, f.inv);
  assert.equal(pending.status, 'pending');
  const granted = runtime.approve(pending.request, {policyId: 'review', approver: 'boss'});
  assert.equal(granted.status, 'approved');
  return {...f, runtime, pending, receipt: granted.receipt};
}
test('grouped lifecycle, frozen prestate RHS, lifecycle facts and deletion routing', () => {
  const {model, state, inv} = fixture(), original = copy(state);
  const r = createInterpreter(model).execute(state, inv);
  assert.equal(r.status, 'committed'); assert.deepEqual(state, original);
  assert.equal(r.state.records['items']['old'], undefined);
  assert.deepEqual(r.state.records['items']['new'], {version: 0, values: {amount: 7, owner: 'actor', reviewers: ['boss', 'actor']}});
  assert.equal(r.state.revision, 1); assert.deepEqual(r.events.map(e => e.kind), ['action', 'create', 'delete']);
  assert.deepEqual(r.events[0].recipients.map(r => r.recipient), ['former']);
  const removed=r.events[2],created=r.events[1];assert.equal(removed.kind,'delete');assert.equal(created.kind,'create');
  assert.deepEqual(removed.before, original.records.items.old); assert(Object.isFrozen(created.after.values));
});
test('rollback on existing, missing, duplicate insert/delete and aliased update/delete', () => {
  const variants = [
    f => { f.inv.args.to = 'old'; },
    f => { f.inv.args.from = 'absent'; },
    f => { f.model.actions.move.inserts.push({...copy(f.model.actions.move.inserts[0]), id: 'make2'}); },
    f => { f.model.actions.move.deletes.push({id: 'remove2', target: 'source'}); },
    f => { const a = f.model.actions.move; a.bindings.push({id: 'alias', resource: 'items', key: input('from')}); a.updates.push({id: 'u', target: 'alias', field: 'amount', value: lit(1)}); },
    f => { f.model.actions.move.inserts[0].values.amount = lit(-1); }
  ];
  for (const mutate of variants) {
    const f = fixture(); mutate(f); const before = copy(f.state), r = createInterpreter(f.model).execute(f.state, f.inv);
    assert.equal(r.status, 'rejected'); assert.equal('events' in r, false); assert.strictEqual(r.state, f.state); assert.deepEqual(f.state, before);
  }
});
test('same-field aliases reject, distinct fields grouped against immutable prestate', () => {
  const {model, state, inv} = fixture(), a = model.actions['move'];
  a.inserts = []; a.deletes = []; a.observe = [];
  a.bindings.push({id: 'alias', resource: 'items', key: input('from')});
  a.updates = [{id: 'u1', target: 'source', field: 'amount', value: lit(2)}, {id: 'u2', target: 'alias', field: 'amount', value: field('source', 'amount')}];
  assert.equal(withStatus(createInterpreter(model).execute(state, inv), "rejected").code, 'conflicting-update');
  a.updates[1] = {id: 'u2', target: 'alias', field: 'owner', value: field('source', 'owner')};
  const r = createInterpreter(model).execute(state, inv); assert.equal(r.status, 'committed'); assert.equal(r.state.records['items']['old'].version, 5);
  assert.deepEqual(r.events.map(e => e.kind), ['action', 'change']);
});
test('no-op and empty groups advance revision; only written records advance version; overflow atomic', () => {
  const {model, state, inv} = fixture(), a = model.actions['move'];
  a.inserts = []; a.deletes = []; a.observe = [];
  let r = createInterpreter(model).execute(state, inv);
  assert.equal(r.status,'committed');assert.equal(r.state.revision, 1); assert.equal(r.state.records['items']['old'].version, 4); assert.equal(r.events.length, 1);
  a.updates = [{id: 'noop', target: 'source', field: 'amount', value: field('source', 'amount')}];
  r = createInterpreter(model).execute(state, inv); assert.equal(r.status,'committed');assert.equal(r.state.records['items']['old'].version, 5); assert.equal(r.events.length, 1);
  state.records['items']['old'].version = Number.MAX_SAFE_INTEGER;
  assert.equal(withStatus(createInterpreter(model).execute(state, inv), "rejected").code, 'overflow');
  a.updates = []; state.revision = Number.MAX_SAFE_INTEGER;
  assert.equal(withStatus(createInterpreter(model).execute(state, inv), "rejected").code, 'overflow');
});
test('malformed IR fails closed even unreachable, exact complete fields and approval declarations', () => {
  for (const mutate of [
    m => { m.format = 'semantic-core/v1'; },
    m => { delete m.actions.move.inserts; },
    m => { delete m.actions.move.inserts[0].values.owner; },
    m => { m.actions.move.inserts[0].values.extra = lit(1); },
    m => { m.actions.move.inserts[0].values.amount = lit('bad'); },
    m => { m.actions.move.inserts[0].key = field('source', 'owner'); },
    m => { m.actions.move.updates.push({id: 'u', target: 'make', field: 'owner', value: lit('x')}); },
    m => { m.actions.move.policies = [{id: 'review', effect: 'approval-required', when: lit(false)}]; },
    m => { m.actions.move.policies[0].approvers = lit('boss'); },
    m => { m.actions.move.inserts[0].values.owner = {op: 'unknown'}; }
  ]) { const {model} = fixture(); mutate(model); assert.throws(() => validateModel(model)); }
  const {model, state} = fixture(); state.records['items']['old'].values['extra'] = 1; assert.throws(() => validateState(model, state));
  assert.throws(() => jsonSnapshot({get bad() { throw Error('must not run'); }}));
});
test('allow, pending without writes/events, deny dominates and failed precondition is not pending', () => {
  const {model, state, inv} = fixture(), a = model.actions['move'];
  assert.equal(createInterpreter(model).execute(state, inv).status, 'committed');
  a.policies.push({id: 'review', effect: 'approval-required', when: lit(true), approvers: lit('boss')});
  const pending = createInterpreter(model).execute(state, inv); assert.equal(pending.status, 'pending'); assert.strictEqual(pending.state, state); assert.equal('events' in pending, false); assert.equal('prepared' in pending, false);
  a.preconditions = [{id: 'notReady', when: lit(false)}]; assert.equal(withStatus(createInterpreter(model).execute(state, inv), "rejected").code, 'precondition');
  a.preconditions = []; a.policies.push({id: 'ban', effect: 'deny', when: lit(true)}); assert.equal(withStatus(createInterpreter(model).execute(state, inv), "rejected").code, 'denied');
  a.policies = []; assert.equal(withStatus(createInterpreter(model).execute(state, inv), "rejected").code, 'denied');
});
test('serialized positive grant/resume across interpreter restart and explicit resumed clock', () => {
  const f = pendingFixture(), rt = createInterpreter(copy(f.model));
  const r = rt.resume(copy(f.state), copy(f.inv), copy(f.pending.request), [copy(f.receipt)], {clock: 12});
  assert.equal(r.status, 'committed'); assert.equal(r.events[0].clock, 12); assert.equal(r.state.records['items']['old'], undefined);
  assert.equal(rt.execute(f.state, f.inv).status, 'pending'); // no policy rewrite/bypass persists
  assert.equal(withStatus(rt.resume(f.state, f.inv, f.pending.request, [], {clock: 12}), "rejected").code, 'approval');
  assert.equal(withStatus(rt.commit(f.state, copy(f.pending.request)), "rejected").code, 'invalid-token');
});
test('unauthorized/self approval rejected unless explicitly enabled; every matching policy needs a grant', () => {
  const f = pendingFixture();
  for (const approver of ['intruder', 'actor']) assert.equal(withStatus(f.runtime.approve(f.pending.request, {policyId: 'review', approver}), "rejected").code, 'unauthorized-approval');
  const bad = {...copy(f.receipt), approver: 'intruder'};
  assert.equal(withStatus(f.runtime.resume(f.state, f.inv, f.pending.request, [bad], {clock: 12}), "rejected").code, 'unauthorized-approval');
  const policy=f.model.actions['move'].policies[1];assert.equal(policy.effect,'approval-required');policy.allowSelfApproval=true;
  f.model.actions['move'].policies.push({id: 'second', effect: 'approval-required', when: lit(true), approvers: lit('other')});
  const rt = createInterpreter(f.model), p = rt.execute(f.state, f.inv), g = rt.approve(withStatus(p, "pending").request, {policyId: 'review', approver: 'actor'});
  assert.equal(g.status, 'approved'); assert.equal(withStatus(rt.resume(f.state, f.inv, withStatus(p, "pending").request, [g.receipt], {clock: 10}), "rejected").code, 'approval');
  const second = rt.approve(withStatus(p, "pending").request, {policyId: 'second', approver: 'other'});
  assert.equal(rt.resume(f.state, f.inv, withStatus(p, "pending").request, [g.receipt, withStatus(second, "approved").receipt], {clock: 10}).status, 'committed');
});
test('changed full model, policy, args, actor, clock, state and receipt/request invalidate binding', () => {
  const f = pendingFixture(), resume = (rt, state, inv, request = f.pending.request, receipt = f.receipt) => rt.resume(state, inv, request, [receipt], {clock: 12});
  for (const change of [m => { m.id = 'different'; }, m => { m.actions.move.policies[1].approvers = lit('other'); }, m => { m.resources.items.fields.amount.max = 100; }, m => { m.actions.move.policies.splice(1); }]) {
    const m = copy(f.model); change(m); assert.equal(resume(createInterpreter(m), f.state, f.inv).code, 'stale');
  }
  for (const change of [i => { i.args.to = 'other'; }, i => { i.actor = 'other'; }, i => { i.clock++; }, i => { i.id = 'newCall'; }]) {
    const i = copy(f.inv); change(i); assert.equal(resume(f.runtime, f.state, i).code, 'stale');
  }
  for (const change of [s => { s.revision++; }, s => { s.records.items.old.version++; }, s => { s.records.items.old.values.amount++; }, s => { s.records.items.unrelated = copy(s.records.items.old); }]) {
    const s = copy(f.state); change(s); assert.equal(resume(f.runtime, s, f.inv).code, 'stale');
  }
  const request = copy(f.pending.request); request.requirements[0].approvers.push('intruder');
  assert.equal(resume(f.runtime, f.state, f.inv, request).code, 'stale');
  const receipt = copy(f.receipt); receipt.request.invocation.args.to = 'other';
  assert.equal(resume(f.runtime, f.state, f.inv, f.pending.request, receipt).code, 'stale');
});
test('resume uses fresh clock: preconditions/deny rechecked, approval cannot disappear into allow', () => {
  for (const scenario of ['precondition', 'denied', 'stale']) {
    const f = fixture(), a = f.model.actions['move'], guard:Mutable<Expr> = {op: 'lt', left: {op: 'clock'}, right: lit(20)};
    a.policies.push({id: 'review', effect: 'approval-required', when: scenario === 'stale' ? guard : lit(true), approvers: lit('boss')});
    if (scenario === 'precondition') a.preconditions.push({id: 'deadline', when: guard});
    if (scenario === 'denied') a.policies.push({id: 'lateBan', effect: 'deny', when: {op: 'not', value: guard}});
    const rt = createInterpreter(f.model), p = rt.execute(f.state, f.inv), g = rt.approve(withStatus(p, "pending").request, {policyId: 'review', approver: 'boss'});
    assert.equal(withStatus(rt.resume(f.state, f.inv, withStatus(p, "pending").request, [withStatus(g, "approved").receipt], {clock: 21}), "rejected").code, scenario);
    assert.equal(withStatus(rt.resume(f.state, f.inv, withStatus(p, "pending").request, [withStatus(g, "approved").receipt], {clock: 9}), "rejected").code, 'invalid');
  }
});
test('optimistic commit compares entire latest state, interpreter-bound tokens and no consumed authority', () => {
  const f = fixture(), rt = createInterpreter(f.model), p = rt.prepare(f.state, f.inv), changed = copy(f.state); changed.revision++;
  assert.equal(withStatus(rt.commit(changed, withStatus(p, "prepared").prepared), "rejected").code, 'stale');
  assert.equal(withStatus(createInterpreter(f.model).commit(f.state, withStatus(p, "prepared").prepared), "rejected").code, 'invalid-token');
  assert.equal(withStatus(rt.commit(f.state, copy(withStatus(p, "prepared").prepared)), "rejected").code, 'invalid-token');
  const result = rt.commit(f.state, withStatus(p, "prepared").prepared); assert.equal(result.status, 'committed');
  assert.equal(withStatus(rt.commit(result.state, withStatus(p, "prepared").prepared), "rejected").code, 'stale');
});
test('mixed update and multiple inserts read prestate, then route poststate; late routing failure rolls back', () => {
  const f = fixture(), a = f.model.actions['move'];
  a.deletes = [];
  a.updates = [{id: 'adjust', target: 'source', field: 'amount', value: lit(1)}, {id: 'reassign', target: 'source', field: 'owner', value: lit('nextOwner')}];
  a.inserts.push({...copy(a.inserts[0]), id: 'makeSecond', key: lit('second')});
  const before = copy(f.state), r = createInterpreter(f.model).execute(f.state, f.inv);
  assert.equal(r.status, 'committed'); assert.equal(r.state.records['items']['old'].values['amount'], 1);
  assert.equal(r.state.records['items']['new'].values['amount'], 7); assert.equal(r.state.records['items']['second'].values['amount'], 7);
  assert.equal(r.state.records['items']['old'].version, 5); assert.equal(r.state.revision, 1);
  assert.deepEqual(r.events[0].recipients.map(r => r.recipient), ['nextOwner']);
  a.updates[1].value = lit('not a recipient id');
  const rejected = createInterpreter(f.model).execute(f.state, f.inv);
  assert.equal(withStatus(rejected, "rejected").code, 'routing'); assert.equal('events' in rejected, false); assert.deepEqual(f.state, before);
});
test('safe arithmetic rejects intermediate overflow and eager boolean RHS, not only final totals', () => {
  const f = fixture(), a = f.model.actions['move'];
  a.deletes = []; a.inserts = []; a.observe = [];
  const overflow:Mutable<Expr> = {op: 'add', left: lit(Number.MAX_SAFE_INTEGER), right: lit(1)};
  a.updates = [{id: 'adjust', target: 'source', field: 'amount', value: {op: 'sub', left: overflow, right: lit(1)}}];
  assert.equal(withStatus(createInterpreter(f.model).execute(f.state, f.inv), "rejected").code, 'overflow');
  a.updates = [];
  a.policies[0].when = {op: 'or', left: lit(true), right: {op: 'eq', left: overflow, right: lit(0)}};
  assert.equal(withStatus(createInterpreter(f.model).execute(f.state, f.inv), "rejected").code, 'overflow');
});
test('resumed preparation still requires latest full state at commit and keeps original models immutable', () => {
  const f = pendingFixture(), modelBefore = copy(f.runtime.model), invocationBefore = copy(f.inv);
  const p = f.runtime.prepareResume(f.state, f.inv, f.pending.request, [f.receipt], {clock: 15});
  assert.equal(p.status, 'prepared');
  const changed = copy(f.state); changed.records.items.old.values.owner = 'other';
  assert.equal(withStatus(f.runtime.commit(changed, p.prepared), "rejected").code, 'stale');
  const r = f.runtime.commit(f.state, p.prepared); assert.equal(r.status, 'committed');
  assert.equal(r.events[0].clock, 15); assert.deepEqual(f.runtime.model, modelBefore); assert.deepEqual(f.inv, invocationBefore);
  assert.equal(f.runtime.execute(f.state, f.inv).status, 'pending');
});
test('deleted prototype-shaped but valid identity routes from own prestate record', () => {
  const f = fixture();
  Object.defineProperty(f.state.records['items'],'toString',{value:f.state.records['items']['old'],writable:true,enumerable:true,configurable:true}); delete f.state.records['items']['old'];
  f.inv.args.from = 'toString'; f.inv.args.to = 'valueOf';
  const r = createInterpreter(f.model).execute(f.state, f.inv);
  assert.equal(r.status, 'committed'); assert.equal(Object.hasOwn(r.state.records['items'], 'toString'), false);
  assert.equal(Object.hasOwn(r.state.records['items'], 'valueOf'), true);
  assert.deepEqual(r.events[0].recipients.map(r => r.recipient), ['former']);
});
