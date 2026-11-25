/** semantic-core/v2. Explicit independent lifecycle profile; v1 is unchanged. */
import {errorMessage} from '../../errors.ts';
import {jsonSnapshot} from '../core.ts';
import type {Event, Interpreter, Model, State} from './types.ts';
export type * from './types.ts';
type Patch<K extends 'change'|'create'|'delete'> = Omit<Extract<Event,{kind:K}>,'kind'|'id'|'modelId'|'actionId'|'invocationId'|'actor'|'clock'|'revision'|'recipients'>;
export {jsonSnapshot};
const own = (o, k) => Object.hasOwn(o, k);
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const assert = (p, message, code = 'invalid') => { if (!p) fail(code, message); };
const safeKey = k => typeof k === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(k) && !['constructor', 'prototype', '__proto__'].includes(k);
const keys = (x, names) => assert(obj(x) && Object.keys(x).length === names.length && names.every(k => own(x, k)), `Expected exactly ${names.join(', ')}`);
const canonical = x => Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : obj(x)
  ? `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}` : JSON.stringify(x);
const equal = (a, b) => canonical(a) === canonical(b);
const increment = x => { assert(x < Number.MAX_SAFE_INTEGER, 'Version overflow', 'overflow'); return x + 1; };
function schema(s) {
  assert(obj(s) && ['integer', 'string', 'boolean', 'ids'].includes(s.type), 'Unsupported schema');
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
    : s.type === 'boolean' ? typeof x === 'boolean' : Array.isArray(x) && x.every(safeKey);
  assert(valid, `Value violates ${s.type} schema`, 'schema');
}
function fields(o) { assert(obj(o), 'Expected field map'); Object.values(o).forEach(schema); }
const binary = {add: ['integer', 'integer'], sub: ['integer', 'integer'], lt: ['integer', 'boolean'], le: ['integer', 'boolean'], and: ['boolean', 'boolean'], or: ['boolean', 'boolean']};

export function validateModel(source: unknown): Model {
  const m = jsonSnapshot(source) as Model;
  keys(m, ['format', 'id', 'resources', 'relationships', 'actions']);
  assert(m.format === 'semantic-core/v2', 'Unsupported semantic profile');
  const ids = new Set(), relationships = new Map();
  const id = x => { assert(safeKey(x) && !ids.has(x), `Invalid/duplicate semantic ID: ${x}`); ids.add(x); };
  id(m.id);
  assert(obj(m.resources) && obj(m.actions) && Array.isArray(m.relationships), 'Invalid model collections');
  for (const [rid, r] of Object.entries(m.resources)) { id(rid); keys(r, ['fields']); fields(r.fields); }
  for (const r of m.relationships) {
    keys(r, ['id', 'resource', 'field']); id(r.id);
    assert(own(m.resources, r.resource) && ['string', 'ids'].includes(m.resources[r.resource].fields[r.field]?.type), 'Invalid relationship');
    relationships.set(r.id, r);
  }
  for (const [aid, a] of Object.entries(m.actions)) {
    id(aid); keys(a, ['inputs', 'bindings', 'preconditions', 'policies', 'updates', 'inserts', 'deletes', 'observe']); fields(a.inputs);
    for (const k of ['bindings', 'preconditions', 'policies', 'updates', 'inserts', 'deletes', 'observe']) assert(Array.isArray(a[k]), `Expected ${k} array`);
    const bindings = new Map(), observable = new Map();
    function type(e, allowFields = true) {
      assert(obj(e) && typeof e.op === 'string', 'Invalid expression');
      if (e.op === 'literal') { keys(e, ['op', 'value']); const t = typeof e.value; assert(['string', 'number', 'boolean'].includes(t), 'Unsupported literal'); return t === 'number' ? 'integer' : t; }
      if (e.op === 'input') { keys(e, ['op', 'name']); assert(own(a.inputs, e.name), 'Unknown input'); return a.inputs[e.name].type; }
      if (e.op === 'actor' || e.op === 'clock') { keys(e, ['op']); return e.op === 'actor' ? 'string' : 'integer'; }
      if (e.op === 'field') { keys(e, ['op', 'binding', 'field']); const r = bindings.get(e.binding); assert(allowFields && r && own(m.resources[r].fields, e.field), 'Unknown field binding'); return m.resources[r].fields[e.field].type; }
      if (e.op === 'not') { keys(e, ['op', 'value']); assert(type(e.value, allowFields) === 'boolean', 'Unary type mismatch'); return 'boolean'; }
      keys(e, ['op', 'left', 'right']);
      if (e.op === 'eq') { const t = type(e.left, allowFields); assert(t !== 'ids' && t === type(e.right, allowFields), 'Equality type mismatch'); return 'boolean'; }
      assert(own(binary, e.op), `Unsupported operator ${e.op}`);
      const [input, output] = binary[e.op];
      assert(type(e.left, allowFields) === input && type(e.right, allowFields) === input, 'Binary type mismatch'); return output;
    }
    for (const b of a.bindings) {
      keys(b, ['id', 'resource', 'key']); id(b.id);
      assert(own(m.resources, b.resource) && type(b.key, false) === 'string', 'Invalid binding'); bindings.set(b.id, b.resource); observable.set(b.id, b.resource);
    }
    for (const p of a.preconditions) { keys(p, ['id', 'when']); id(p.id); assert(type(p.when) === 'boolean', 'Invalid precondition'); }
    for (const p of a.policies) {
      assert(obj(p), 'Invalid policy');
      keys(p, p.effect === 'approval-required' ? ['id', 'when', 'effect', 'approvers', ...(own(p, 'allowSelfApproval') ? ['allowSelfApproval'] : [])] : ['id', 'when', 'effect']);
      id(p.id); assert(['allow', 'deny', 'approval-required'].includes(p.effect) && type(p.when) === 'boolean', 'Invalid policy');
      if (p.effect === 'approval-required') {
        assert(['ids', 'string'].includes(type(p.approvers)), 'Invalid approver expression');
        if (own(p, 'allowSelfApproval')) assert(typeof p.allowSelfApproval === 'boolean', 'Invalid self approval option');
      }
    }
    for (const u of a.updates) {
      keys(u, ['id', 'target', 'field', 'value']); id(u.id);
      const r = bindings.get(u.target); assert(r && own(m.resources[r].fields, u.field) && type(u.value) === m.resources[r].fields[u.field].type, 'Update type mismatch');
    }
    for (const i of a.inserts) {
      keys(i, ['id', 'resource', 'key', 'values']); id(i.id);
      assert(own(m.resources, i.resource) && type(i.key, false) === 'string', 'Invalid insert');
      keys(i.values, Object.keys(m.resources[i.resource].fields));
      for (const [f, s] of Object.entries(m.resources[i.resource].fields)) assert(type(i.values[f]) === s.type, 'Insert type mismatch');
      observable.set(i.id, i.resource);
    }
    for (const d of a.deletes) { keys(d, ['id', 'target']); id(d.id); assert(bindings.has(d.target), 'Unknown delete binding'); }
    for (const o of a.observe) { keys(o, ['binding', 'relationship']); assert(relationships.has(o.relationship) && observable.get(o.binding) === relationships.get(o.relationship).resource, 'Invalid observation'); }
  }
  return m;
}
function checkState(model: Model, source: unknown): State {
  const s = jsonSnapshot(source) as State;
  keys(s, ['revision', 'records']); assert(Number.isSafeInteger(s.revision) && s.revision >= 0, 'Invalid revision');
  keys(s.records, Object.keys(model.resources));
  for (const [rid, r] of Object.entries(model.resources)) {
    assert(obj(s.records[rid]), 'Invalid resource collection');
    for (const record of Object.values(s.records[rid])) {
      keys(record, ['version', 'values']); assert(Number.isSafeInteger(record.version) && record.version >= 0, 'Invalid record version');
      keys(record.values, Object.keys(r.fields));
      for (const [f, spec] of Object.entries(r.fields)) value(spec, record.values[f]);
    }
  }
  return s;
}
export function validateState(model: Model, source: unknown): State { return checkState(validateModel(model), source); }
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
const rejection = (state, error) => Object.freeze({status: 'rejected', code: error.code ?? 'invalid', reason: error.message, state});

export function createInterpreter(source: unknown): Readonly<Interpreter> {
  const model = validateModel(source), tokens = new WeakMap();
  const relations = new Map(model.relationships.map(r => [r.id, r]));
  function context(state, invocation) {
    const before = checkState(model, state), inv = jsonSnapshot(invocation);
    keys(inv, ['id', 'action', 'args', 'actor', 'clock']);
    assert(safeKey(inv.id) && safeKey(inv.actor) && Number.isSafeInteger(inv.clock) && inv.clock >= 0, 'Invalid invocation');
    assert(own(model.actions, inv.action), 'Unknown action');
    const a = model.actions[inv.action]; keys(inv.args, Object.keys(a.inputs));
    for (const [k, s] of Object.entries(a.inputs)) value(s, inv.args[k]);
    const bound = new Map(), ctx = {inv, bound};
    for (const b of a.bindings) {
      const key = evaluate(b.key, ctx); assert(safeKey(key), 'Invalid record key');
      assert(own(before.records[b.resource], key), 'Missing bound record', 'missing-record');
      bound.set(b.id, {resource: b.resource, key, record: before.records[b.resource][key]});
    }
    const matches = a.policies.filter(p => evaluate(p.when, ctx));
    assert(!matches.some(p => p.effect === 'deny') && matches.some(p => p.effect === 'allow' || p.effect === 'approval-required'), 'Policy denied', 'denied');
    const failed = a.preconditions.find(p => !evaluate(p.when, ctx));
    assert(!failed, failed?.id, 'precondition');
    const requirements = matches.filter(p => p.effect === 'approval-required').map(p => {
      const raw = evaluate(p.approvers, ctx), ids = Array.isArray(raw) ? raw : [raw];
      assert(ids.every(safeKey), 'Invalid approver identity', 'approval');
      return {policyId: p.id, approvers: [...new Set(ids)].filter(x => p.allowSelfApproval === true || x !== inv.actor).sort(), allowSelfApproval: p.allowSelfApproval === true};
    });
    return {before, inv, a, bound, ctx, requirements};
  }
  const requestFor = c => jsonSnapshot({format: 'semantic-approval-request/v2', model, invocation: c.inv, prestate: c.before, requirements: c.requirements});
  function checkedRequest(source) {
    const request = jsonSnapshot(source);
    keys(request, ['format', 'model', 'invocation', 'prestate', 'requirements']);
    assert(request.format === 'semantic-approval-request/v2' && equal(request.model, model), 'Approval model changed', 'stale');
    const c = context(request.prestate, request.invocation);
    assert(c.requirements.length > 0 && equal(request, requestFor(c)), 'Approval context changed', 'stale');
    return {request, c};
  }
  function plan(c) {
    const {before, inv, a, bound, ctx} = c;
    const patches: Patch<'change'>[] = [], inserts: Patch<'create'>[] = [], deletes: Patch<'delete'>[] = [];
    const fieldsWritten = new Set(), recordsUpdated = new Set(), exclusive = new Set();
    const address = b => canonical([b.resource, b.key]);
    for (const u of a.updates) {
      const b = bound.get(u.target), field = canonical([b.resource, b.key, u.field]);
      assert(!fieldsWritten.has(field), 'Aliased grouped field write', 'conflicting-update'); fieldsWritten.add(field); recordsUpdated.add(address(b));
      const next = evaluate(u.value, ctx); value(model.resources[b.resource].fields[u.field], next);
      patches.push({semanticId: u.id, resource: b.resource, key: b.key, field: u.field, before: b.record.values[u.field], after: next});
    }
    for (const d of a.deletes) {
      const b = bound.get(d.target), addr = address(b);
      assert(!exclusive.has(addr) && !recordsUpdated.has(addr), 'Conflicting record deletion', 'conflicting-update'); exclusive.add(addr);
      deletes.push({semanticId: d.id, resource: b.resource, key: b.key, before: b.record});
    }
    for (const i of a.inserts) {
      const key = evaluate(i.key, ctx), b = {resource: i.resource, key}, addr = address(b);
      assert(safeKey(key), 'Invalid insert key');
      assert(!exclusive.has(addr) && !recordsUpdated.has(addr), 'Conflicting record insertion', 'conflicting-update'); exclusive.add(addr);
      assert(!own(before.records[i.resource], key), 'Insert target exists', 'existing-record');
      const values = {};
      for (const [f, e] of Object.entries(i.values)) { values[f] = evaluate(e, ctx); value(model.resources[i.resource].fields[f], values[f]); }
      const record = {version: 0, values}; inserts.push({semanticId: i.id, ...b, after: record});
      // Observation only: expressions cannot reference inserted records.
      bound.set(i.id, {...b, record});
    }
    const candidate = JSON.parse(JSON.stringify(before)), touched = new Set();
    for (const p of patches) {
      const r = candidate.records[p.resource][p.key], addr = address(p); r.values[p.field] = p.after;
      if (!touched.has(addr)) { r.version = increment(r.version); touched.add(addr); }
    }
    for (const d of deletes) delete candidate.records[d.resource][d.key];
    for (const i of inserts) candidate.records[i.resource][i.key] = i.after;
    candidate.revision = increment(candidate.revision);
    const nextState = checkState(model, candidate), recipients = new Map();
    for (const o of a.observe) {
      const b = bound.get(o.binding), r = relations.get(o.relationship)!;
      // Deleted observations deliberately retain prestate recipients. Others use poststate.
      const collection = nextState.records[b.resource];
      const record = own(collection, b.key) ? collection[b.key] : b.record, raw = record.values[r.field];
      for (const recipient of Array.isArray(raw) ? raw : [raw]) {
        assert(safeKey(recipient), 'Invalid relationship recipient', 'routing');
        if (recipient === inv.actor) continue;
        if (!recipients.has(recipient)) recipients.set(recipient, new Map());
        const path = {relationship: r.id, resource: b.resource, key: b.key}; recipients.get(recipient).set(canonical(path), path);
      }
    }
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const routing = [...recipients].sort(([a], [b]) => compare(a, b)).map(([recipient, paths]) => ({recipient, paths: [...paths.values()].sort((a, b) => compare(canonical(a), canonical(b)))}));
    const base = {modelId: model.id, actionId: inv.action, invocationId: inv.id, actor: inv.actor, clock: inv.clock, revision: nextState.revision, recipients: routing};
    const prefix = `event:${encodeURIComponent(inv.id)}`;
    const fact = (kind, p) => ({...base, id: `${prefix}:${kind}:${encodeURIComponent(p.semanticId)}`, kind, ...p});
    const events = jsonSnapshot([{...base, id: `${prefix}:action`, kind: 'action', semanticId: inv.action},
      ...patches.filter(p => !equal(p.before, p.after)).map(p => fact('change', p)), ...inserts.map(p => fact('create', p)), ...deletes.map(p => fact('delete', p))]);
    const token = Object.freeze({kind: 'semantic-prepared/v2'});
    tokens.set(token, {before: canonical(before), state: nextState, events});
    return Object.freeze({status: 'prepared', prepared: token});
  }
  function prepare(state, invocation) {
    try {
      const c = context(state, invocation);
      return c.requirements.length ? Object.freeze({status: 'pending', policyIds: Object.freeze(c.requirements.map(p => p.policyId)), request: requestFor(c), state}) : plan(c);
    } catch (error) { return rejection(state, error); }
  }
  function commit(state, token) {
    try {
      const p = tokens.get(token); assert(p, 'Foreign or serialized token', 'invalid-token');
      assert(canonical(checkState(model, state)) === p.before, 'Prestate changed', 'stale');
      return Object.freeze({status: 'committed', state: p.state, events: p.events});
    } catch (error) { return rejection(state, error); }
  }
  function approve(source, grant) {
    try {
      const {request} = checkedRequest(source), g = jsonSnapshot(grant); keys(g, ['policyId', 'approver']);
      assert(safeKey(g.approver), 'Invalid approver');
      const p = request.requirements.find(p => p.policyId === g.policyId);
      assert(p && p.approvers.includes(g.approver), 'Approver not eligible', 'unauthorized-approval');
      return Object.freeze({status: 'approved', receipt: jsonSnapshot({format: 'semantic-approval-receipt/v2', request, ...g})});
    } catch (error) {
      const code=error instanceof Error&&'code' in error&&typeof error.code==='string' ? error.code : 'invalid';
      return Object.freeze({status: 'rejected', code, reason: errorMessage(error)});
    }
  }
  function prepareResume(state, invocation, source, receipts, options) {
    try {
      const {request} = checkedRequest(source), inv = jsonSnapshot(invocation), opts = jsonSnapshot(options);
      keys(opts, ['clock']); assert(Number.isSafeInteger(opts.clock) && opts.clock >= request.invocation.clock, 'Resume clock must not precede request clock');
      assert(equal(inv, request.invocation) && equal(checkState(model, state), request.prestate), 'Approval invocation/prestate changed', 'stale');
      const c = context(state, {...inv, clock: opts.clock});
      assert(equal(c.requirements, request.requirements), 'Approval policy context changed', 'stale');
      const rs = jsonSnapshot(receipts); assert(Array.isArray(rs), 'Expected receipts');
      const granted = new Set();
      for (const r of rs) {
        keys(r, ['format', 'request', 'policyId', 'approver']);
        assert(r.format === 'semantic-approval-receipt/v2' && equal(r.request, request), 'Receipt binding changed', 'stale');
        const result = approve(request, {policyId: r.policyId, approver: r.approver});
        assert(result.status === 'approved', 'Receipt approver not eligible', 'unauthorized-approval');
        assert(!granted.has(r.policyId), 'Duplicate policy receipt', 'approval'); granted.add(r.policyId);
      }
      assert(request.requirements.every(p => granted.has(p.policyId)), 'Missing required approval', 'approval');
      return plan(c);
    } catch (error) { return rejection(state, error); }
  }
  const finish = (state, p) => p.status === 'prepared' ? commit(state, p.prepared) : p;
  return Object.freeze({model, prepare, commit, approve, prepareResume,
    execute(state, invocation) { return finish(state, prepare(state, invocation)); },
    resume(state, invocation, request, receipts, options) { return finish(state, prepareResume(state, invocation, request, receipts, options)); }}) as Readonly<Interpreter>;
}
