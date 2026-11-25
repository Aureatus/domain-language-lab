/** semantic-core/v1: browser-safe, data-only, bounded reference interpreter. */
import type {Event, Interpreter, Model, State} from './types.ts';
export type * from './types.ts';
type Patch = Pick<Extract<Event,{kind:'change'}>,'semanticId'|'resource'|'key'|'field'|'before'|'after'>;
const own = (o, k) => Object.hasOwn(o, k);
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const assert = (p, message, code = 'invalid') => { if (!p) fail(code, message); };
const safeKey = k => typeof k === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k);
const keys = (x, names) => assert(obj(x) && Object.keys(x).length === names.length && names.every(k => own(x, k)), `Expected exactly ${names.join(', ')}`);
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };

/** Reject accessors, cycles, exotic objects, sparse arrays and non-safe JSON numbers. */
export function jsonSnapshot<T>(value: T): T {
  let nodes = 0;
  const seen = new Set();
  function visit(x, depth) {
    assert(++nodes <= 100000 && depth <= 40, 'JSON complexity limit');
    if (x === null || typeof x === 'boolean') return x;
    if (typeof x === 'string') { assert(x.length <= 100000, 'String limit'); return x; }
    if (typeof x === 'number') { assert(Number.isSafeInteger(x) && !Object.is(x, -0), 'Expected safe integer'); return x; }
    assert(x && typeof x === 'object' && !seen.has(x), 'Expected acyclic JSON');
    const array = Array.isArray(x);
    assert(array || [Object.prototype, null].includes(Object.getPrototypeOf(x)), 'Expected plain JSON');
    const names = Reflect.ownKeys(x).filter(k => !(array && k === 'length'));
    assert(!array || (names.length === x.length && names.every((k, i) => k === String(i))), 'Expected dense array');
    seen.add(x);
    const result = array ? [] : {};
    for (const k of names) {
      const d = Object.getOwnPropertyDescriptor(x, k)!;
      assert(typeof k === 'string' && d.enumerable && own(d, 'value') && (array || safeKey(k)), 'Unsafe JSON property');
      result[k] = visit(d.value, depth + 1);
    }
    seen.delete(x);
    return result;
  }
  return freeze(visit(value, 0));
}

const canonical = x => Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : obj(x)
  ? `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}` : JSON.stringify(x);
const types = ['integer', 'string', 'boolean', 'ids'];
function schema(s) {
  assert(obj(s) && types.includes(s.type), 'Unsupported schema');
  const allowed = s.type === 'integer' ? ['type', 'min', 'max'] : s.type === 'string' ? ['type', 'enum'] : ['type'];
  assert(Object.keys(s).every(k => allowed.includes(k)), 'Unknown schema member');
  if (own(s, 'min')) assert(Number.isSafeInteger(s.min), 'Invalid minimum');
  if (own(s, 'max')) assert(Number.isSafeInteger(s.max), 'Invalid maximum');
  if (own(s, 'min') && own(s, 'max')) assert(s.min <= s.max, 'Inverted bounds');
  if (own(s, 'enum')) assert(Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every(x => typeof x === 'string') && new Set(s.enum).size === s.enum.length, 'Invalid enum');
}
function value(s, x) {
  const valid = s.type === 'integer' ? Number.isSafeInteger(x) && !Object.is(x, -0) && (!own(s, 'min') || x >= s.min) && (!own(s, 'max') || x <= s.max)
    : s.type === 'string' ? typeof x === 'string' && (!s.enum || s.enum.includes(x))
    : s.type === 'boolean' ? typeof x === 'boolean'
    : Array.isArray(x) && x.every(id => typeof id === 'string' && safeKey(id));
  assert(valid, `Value violates ${s.type} schema`, 'schema');
}
function fields(o) { assert(obj(o), 'Expected field map'); Object.values(o).forEach(schema); }
const unary = {not: ['boolean', 'boolean']};
const binary = {add: ['integer', 'integer'], sub: ['integer', 'integer'], lt: ['integer', 'boolean'], le: ['integer', 'boolean'], and: ['boolean', 'boolean'], or: ['boolean', 'boolean']};

/** Validate the entire declaration, including unreachable expressions. Returns frozen JSON. */
export function validateModel(source: unknown): Model {
  const m = jsonSnapshot(source) as Model;
  keys(m, ['format', 'id', 'resources', 'relationships', 'actions']);
  assert(m.format === 'semantic-core/v1', 'Unsupported semantic profile');
  const ids = new Set();
  const id = x => { assert(safeKey(x) && !ids.has(x), `Invalid/duplicate semantic ID: ${x}`); ids.add(x); };
  id(m.id);
  assert(obj(m.resources) && obj(m.actions) && Array.isArray(m.relationships), 'Invalid model collections');
  for (const [rid, r] of Object.entries(m.resources)) { id(rid); keys(r, ['fields']); fields(r.fields); }
  const relationships = new Map();
  for (const r of m.relationships) {
    keys(r, ['id', 'resource', 'field']); id(r.id);
    assert(['string', 'ids'].includes(m.resources[r.resource]?.fields[r.field]?.type), 'Invalid relationship field');
    relationships.set(r.id, r);
  }
  for (const [aid, a] of Object.entries(m.actions)) {
    id(aid); keys(a, ['inputs', 'bindings', 'preconditions', 'policies', 'updates', 'observe']); fields(a.inputs);
    for (const k of ['bindings', 'preconditions', 'policies', 'updates', 'observe']) assert(Array.isArray(a[k]), `Expected ${k} array`);
    const bindings = new Map();
    function type(e, allowFields = true) {
      assert(obj(e) && typeof e.op === 'string', 'Invalid expression');
      if (e.op === 'literal') { keys(e, ['op', 'value']); const t = typeof e.value; assert(['string', 'number', 'boolean'].includes(t), 'Unsupported literal'); return t === 'number' ? 'integer' : t; }
      if (e.op === 'input') { keys(e, ['op', 'name']); assert(own(a.inputs, e.name), 'Unknown input'); return a.inputs[e.name].type; }
      if (e.op === 'actor' || e.op === 'clock') { keys(e, ['op']); return e.op === 'actor' ? 'string' : 'integer'; }
      if (e.op === 'field') { keys(e, ['op', 'binding', 'field']); const r = bindings.get(e.binding); assert(allowFields && r && own(m.resources[r].fields, e.field), 'Unknown field binding'); return m.resources[r].fields[e.field].type; }
      if (e.op === 'eq') { keys(e, ['op', 'left', 'right']); const t = type(e.left, allowFields); assert(t !== 'ids' && t === type(e.right, allowFields), 'Equality type mismatch'); return 'boolean'; }
      if (own(unary, e.op)) { keys(e, ['op', 'value']); assert(type(e.value, allowFields) === unary[e.op][0], 'Unary type mismatch'); return unary[e.op][1]; }
      assert(own(binary, e.op), `Unsupported operator ${e.op}`);
      keys(e, ['op', 'left', 'right']); const [input, output] = binary[e.op];
      assert(type(e.left, allowFields) === input && type(e.right, allowFields) === input, 'Binary type mismatch'); return output;
    }
    for (const b of a.bindings) {
      keys(b, ['id', 'resource', 'key']); id(b.id);
      assert(own(m.resources, b.resource) && type(b.key, false) === 'string', 'Invalid record binding'); bindings.set(b.id, b.resource);
    }
    for (const p of a.preconditions) { keys(p, ['id', 'when']); id(p.id); assert(type(p.when) === 'boolean', 'Precondition must be boolean'); }
    for (const p of a.policies) { keys(p, ['id', 'when', 'effect']); id(p.id); assert(['allow', 'deny', 'approval-required'].includes(p.effect) && type(p.when) === 'boolean', 'Invalid policy'); }
    for (const u of a.updates) {
      keys(u, ['id', 'target', 'field', 'value']); id(u.id);
      const r = bindings.get(u.target); assert(r && own(m.resources[r].fields, u.field) && type(u.value) === m.resources[r].fields[u.field].type, 'Update type mismatch');
    }
    for (const o of a.observe) { keys(o, ['binding', 'relationship']); assert(relationships.has(o.relationship) && bindings.get(o.binding) === relationships.get(o.relationship).resource, 'Invalid observation'); }
  }
  return m;
}

export function validateState(model: Model, source: unknown): State {
  return checkState(validateModel(model), source);
}

function checkState(model: Model, source: unknown): State {
  const s = jsonSnapshot(source) as State;
  keys(s, ['revision', 'records']); assert(Number.isSafeInteger(s.revision) && s.revision >= 0, 'Invalid revision');
  assert(obj(s.records) && Object.keys(s.records).length === Object.keys(model.resources).length, 'Resource collection mismatch');
  for (const [rid, r] of Object.entries(model.resources)) {
    assert(own(s.records, rid) && obj(s.records[rid]), 'Missing resource collection');
    for (const record of Object.values(s.records[rid])) {
      keys(record, ['version', 'values']); assert(Number.isSafeInteger(record.version) && record.version >= 0, 'Invalid record version');
      keys(record.values, Object.keys(r.fields));
      for (const [f, spec] of Object.entries(r.fields)) value(spec, record.values[f]);
    }
  }
  return s;
}

function evaluate(e, ctx) {
  if (e.op === 'literal') return e.value;
  if (e.op === 'input') return ctx.inv.args[e.name];
  if (e.op === 'actor') return ctx.inv.actor;
  if (e.op === 'clock') return ctx.inv.clock;
  if (e.op === 'field') return ctx.bound.get(e.binding).record.values[e.field];
  if (e.op === 'not') return !evaluate(e.value, ctx);
  const l = evaluate(e.left, ctx), r = evaluate(e.right, ctx);
  switch (e.op) {
    case 'add': case 'sub': {
      const n = e.op === 'add' ? BigInt(l) + BigInt(r) : BigInt(l) - BigInt(r);
      assert(n >= -9007199254740991n && n <= 9007199254740991n, 'Integer overflow', 'overflow'); return Number(n);
    }
    case 'eq': return l === r;
    case 'lt': return l < r;
    case 'le': return l <= r;
    case 'and': return l && r;
    case 'or': return l || r;
    default: fail('unsupported', 'Unknown expression');
  }
}
const increment = x => { assert(x < Number.MAX_SAFE_INTEGER, 'Version overflow', 'overflow'); return x + 1; };
const rejection = (state, error) => Object.freeze({status: 'rejected', code: error.code ?? 'invalid', reason: error.message, state});

/** Tokens are opaque interpreter-owned capabilities, not serializable commands. */
export function createInterpreter(source: unknown): Readonly<Interpreter> {
  const model = validateModel(source), tokens = new WeakMap();
  const relations = new Map(model.relationships.map(r => [r.id, r]));
  function prepare(state, invocation) {
    try {
      const before = checkState(model, state), inv = jsonSnapshot(invocation);
      keys(inv, ['id', 'action', 'args', 'actor', 'clock']);
      assert(safeKey(inv.id) && safeKey(inv.actor) && Number.isSafeInteger(inv.clock) && inv.clock >= 0, 'Invalid invocation identity/clock');
      assert(own(model.actions, inv.action), 'Unknown action');
      const a = model.actions[inv.action]; keys(inv.args, Object.keys(a.inputs));
      for (const [k, s] of Object.entries(a.inputs)) value(s, inv.args[k]);
      const bound = new Map(), ctx = {inv, bound};
      for (const b of a.bindings) {
        const key = evaluate(b.key, ctx); assert(safeKey(key) && own(before.records[b.resource], key), 'Missing bound record', 'missing-record');
        bound.set(b.id, {resource: b.resource, key, record: before.records[b.resource][key]});
      }
      const matches = a.policies.filter(p => evaluate(p.when, ctx));
      if (matches.some(p => p.effect === 'deny') || !matches.some(p => p.effect === 'allow' || p.effect === 'approval-required')) fail('denied', 'Policy denied');
      const failed = a.preconditions.find(p => !evaluate(p.when, ctx));
      if (failed) fail('precondition', failed.id);
      if (matches.some(p => p.effect === 'approval-required')) return Object.freeze({status: 'pending', policyIds: Object.freeze(matches.filter(p => p.effect === 'approval-required').map(p => p.id)), state});
      // Every RHS reads ctx.bound, which contains only immutable prestate records.
      const patches: Patch[] = [], writes = new Set();
      for (const u of a.updates) {
        const b = bound.get(u.target), address = JSON.stringify([b.resource, b.key, u.field]);
        assert(!writes.has(address), 'Aliased grouped write', 'conflicting-update'); writes.add(address);
        const next = evaluate(u.value, ctx); value(model.resources[b.resource].fields[u.field], next);
        patches.push({semanticId: u.id, resource: b.resource, key: b.key, field: u.field, before: b.record.values[u.field], after: next});
      }
      const candidate = JSON.parse(JSON.stringify(before)), touched = new Set();
      for (const p of patches) {
        const r = candidate.records[p.resource][p.key]; r.values[p.field] = p.after;
        const address = JSON.stringify([p.resource, p.key]);
        if (!touched.has(address)) { r.version = increment(r.version); touched.add(address); }
      }
      candidate.revision = increment(candidate.revision);
      const nextState = checkState(model, candidate);
      // Routing snapshots poststate; duplicate support paths do not duplicate recipients.
      const recipients = new Map();
      for (const o of a.observe) {
        const b = bound.get(o.binding), r = relations.get(o.relationship)!;
        const raw = nextState.records[b.resource][b.key].values[r.field];
        for (const recipient of Array.isArray(raw) ? raw : [raw]) {
          assert(safeKey(recipient), 'Invalid relationship recipient', 'routing');
          if (recipient === inv.actor) continue;
          if (!recipients.has(recipient)) recipients.set(recipient, new Map());
          const path = {relationship: r.id, resource: b.resource, key: b.key};
          recipients.get(recipient).set(canonical(path), path);
        }
      }
      const routing = [...recipients].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([recipient, paths]) => ({recipient, paths: [...paths.values()].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0)}));
      const eventBase = {modelId: model.id, actionId: inv.action, invocationId: inv.id, actor: inv.actor, clock: inv.clock, revision: nextState.revision, recipients: routing};
      const eventPrefix = `event:${encodeURIComponent(inv.id)}`;
      const events = [{...eventBase, id: `${eventPrefix}:action`, kind: 'action', semanticId: inv.action}, ...patches.filter(p => canonical(p.before) !== canonical(p.after)).map(p => ({...eventBase, id: `${eventPrefix}:change:${encodeURIComponent(p.semanticId)}`, kind: 'change', ...p}))];
      const token = freeze({kind: 'semantic-prepared/v1'});
      tokens.set(token, {before: canonical(before), state: nextState, events: jsonSnapshot(events)});
      return freeze({status: 'prepared', prepared: token});
    } catch (error) { return rejection(state, error); }
  }
  function commit(state, token) {
    try {
      const plan = tokens.get(token); assert(plan, 'Foreign or serialized token', 'invalid-token');
      const current = checkState(model, state);
      assert(canonical(current) === plan.before, 'Prestate changed; prepare again', 'stale');
      return freeze({status: 'committed', state: plan.state, events: plan.events});
    } catch (error) { return rejection(state, error); }
  }
  return Object.freeze({model, prepare, commit, execute(state, inv) { const p = prepare(state, inv); return p.status === 'prepared' ? commit(state, p.prepared) : p; }}) as Readonly<Interpreter>;
}
