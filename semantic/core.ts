/** semantic-core/v1: browser-safe, data-only, bounded reference interpreter. */
import {errorMessage} from '../errors.ts';
import type {Committed, Event, Expr, FieldSchema, Interpreter, Invocation, Model, Preparation, Prepared, Recipient, Rejected, State} from './types.ts';
export type * from './types.ts';
type Patch = Pick<Extract<Event,{kind:'change'}>,'semanticId'|'resource'|'key'|'field'|'before'|'after'>;
type CoreValue=Invocation['args'][string];
type Snapshot=State['records'][string][string];
type Bound={resource:string;key:string;record:Snapshot};
type Context={inv:Invocation;bound:Map<string,Bound>};
type Token={readonly kind:'semantic-prepared/v1'};
type Plan={before:string;state:State;events:Event[]};
const own = (o:object, k:PropertyKey) => Object.hasOwn(o, k);
export function ownValue<T>(table:Readonly<Record<string,T>>|undefined,key:unknown):T|undefined {
  return table!==undefined&&typeof key==='string'&&Object.hasOwn(table,key)?table[key]:undefined;
}
const obj = (x:unknown):x is Record<string,unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
function fail(code:string,message?:string):never { throw Object.assign(new Error(message),{code}); }
function assert(p:unknown,message:string|undefined,code='invalid'):asserts p { if(!p)fail(code,message); }
const safeKey = (k:unknown):k is string => typeof k === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k);
const keys = (x:unknown,names:readonly string[]) => assert(obj(x) && Object.keys(x).length === names.length && names.every(k => own(x, k)), `Expected exactly ${names.join(', ')}`);
const freeze = <T>(x:T):T => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };

/** Reject accessors, cycles, exotic objects, sparse arrays and non-safe JSON numbers. */
export function jsonSnapshot<T>(value:T):T {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(x:unknown, depth:number):unknown {
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
    const result:unknown[]|Record<string,unknown> = array ? [] : {};
    for (const k of names) {
      const d = Object.getOwnPropertyDescriptor(x, k);
      assert(typeof k === 'string' && d?.enumerable && own(d, 'value') && (array || safeKey(k)), 'Unsafe JSON property');
      const child=visit(d.value,depth+1);
      if (Array.isArray(result)) result[Number(k)]=child;
      else result[k]=child;
    }
    seen.delete(x);
    return result;
  }
  return freeze(visit(value, 0)) as T;
}

const canonical = (x:unknown):string => Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : obj(x)
  ? `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}` : JSON.stringify(x);
const types = ['integer', 'string', 'boolean', 'ids'];
function schema(s:unknown) {
  assert(obj(s)&&typeof s['type']==='string'&&types.includes(s['type']), 'Unsupported schema');
  const allowed = s['type'] === 'integer' ? ['type', 'min', 'max'] : s['type'] === 'string' ? ['type', 'enum'] : ['type'];
  assert(Object.keys(s).every(k => allowed.includes(k)), 'Unknown schema member');
  const min=s['min'],max=s['max'],choices=s['enum'];
  if (own(s, 'min')) assert(typeof min==='number'&&Number.isSafeInteger(min), 'Invalid minimum');
  if (own(s, 'max')) assert(typeof max==='number'&&Number.isSafeInteger(max), 'Invalid maximum');
  if (typeof min==='number'&&typeof max==='number') assert(min<=max, 'Inverted bounds');
  if (own(s, 'enum')) assert(Array.isArray(choices) && choices.length > 0 && choices.every(x => typeof x === 'string') && new Set(choices).size === choices.length, 'Invalid enum');
}
function value(s:FieldSchema,x:unknown):asserts x is CoreValue {
  const valid = s.type === 'integer' ? typeof x==='number'&&Number.isSafeInteger(x) && !Object.is(x, -0) && (s.min===undefined||x>=s.min) && (s.max===undefined||x<=s.max)
    : s.type === 'string' ? typeof x === 'string' && (!s.enum || s.enum.includes(x))
    : s.type === 'boolean' ? typeof x === 'boolean'
    : Array.isArray(x) && x.every(id => typeof id === 'string' && safeKey(id));
  assert(valid, `Value violates ${s.type} schema`, 'schema');
}
function fields(o:unknown) { assert(obj(o), 'Expected field map'); Object.values(o).forEach(schema); }
type Kind=FieldSchema['type'];
const binary:Readonly<Record<string,readonly [Kind,Kind]>> = {add: ['integer', 'integer'], sub: ['integer', 'integer'], lt: ['integer', 'boolean'], le: ['integer', 'boolean'], and: ['boolean', 'boolean'], or: ['boolean', 'boolean']};

/** Validate the entire declaration, including unreachable expressions. Returns frozen JSON. */
export function validateModel(source: unknown): Model {
  const m = jsonSnapshot(source) as Model;
  keys(m, ['format', 'id', 'resources', 'relationships', 'actions']);
  assert(m.format === 'semantic-core/v1', 'Unsupported semantic profile');
  const ids = new Set<string>();
  const id = (x:unknown) => { assert(safeKey(x) && !ids.has(x), `Invalid/duplicate semantic ID: ${x}`); ids.add(x); };
  id(m.id);
  assert(obj(m.resources) && obj(m.actions) && Array.isArray(m.relationships), 'Invalid model collections');
  for (const [rid, r] of Object.entries(m.resources)) { id(rid); keys(r, ['fields']); fields(r.fields); }
  const relationships = new Map<string,Model['relationships'][number]>();
  for (const r of m.relationships) {
    keys(r, ['id', 'resource', 'field']); id(r.id);
    const spec=ownValue(ownValue(m.resources,r.resource)?.fields,r.field);
    assert(spec&&(spec.type==='string'||spec.type==='ids'), 'Invalid relationship field');
    relationships.set(r.id, r);
  }
  for (const [aid, a] of Object.entries(m.actions)) {
    id(aid); keys(a, ['inputs', 'bindings', 'preconditions', 'policies', 'updates', 'observe']); fields(a.inputs);
    const collections:readonly (keyof Omit<typeof a,'inputs'>)[]=['bindings','preconditions','policies','updates','observe'];
    for (const k of collections) assert(Array.isArray(a[k]), `Expected ${k} array`);
    const bindings = new Map<string,string>();
    function type(e:Expr, allowFields = true):Kind {
      assert(obj(e) && typeof e.op === 'string', 'Invalid expression');
      if (e.op === 'literal') { keys(e, ['op', 'value']); const t = typeof e.value; assert(t==='string'||t==='number'||t==='boolean', 'Unsupported literal'); return t === 'number' ? 'integer' : t; }
      if (e.op === 'input') { keys(e, ['op', 'name']); const spec=ownValue(a.inputs,e.name);assert(spec,'Unknown input');return spec.type; }
      if (e.op === 'actor' || e.op === 'clock') { keys(e, ['op']); return e.op === 'actor' ? 'string' : 'integer'; }
      if (e.op === 'field') { keys(e, ['op', 'binding', 'field']); const spec=ownValue(ownValue(m.resources,bindings.get(e.binding))?.fields,e.field);assert(allowFields&&spec,'Unknown field binding');return spec.type; }
      if (e.op === 'eq') { keys(e, ['op', 'left', 'right']); const t = type(e.left, allowFields); assert(t !== 'ids' && t === type(e.right, allowFields), 'Equality type mismatch'); return 'boolean'; }
      if (e.op==='not') { keys(e, ['op', 'value']); assert(type(e.value, allowFields)==='boolean', 'Unary type mismatch'); return 'boolean'; }
      const operator=ownValue(binary,e.op);
      assert(operator, `Unsupported operator ${e.op}`);
      keys(e, ['op', 'left', 'right']); const [input, output] = operator;
      assert('left' in e&&'right' in e,'Missing binary operands');
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
      const spec=ownValue(ownValue(m.resources,bindings.get(u.target))?.fields,u.field);
      assert(spec&&type(u.value)===spec.type,'Update type mismatch');
    }
    for (const o of a.observe) { keys(o, ['binding', 'relationship']); const relationship=relationships.get(o.relationship); assert(relationship&&bindings.get(o.binding)===relationship.resource,'Invalid observation'); }
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
    const collection=ownValue(s.records,rid);
    assert(collection&&obj(collection), 'Missing resource collection');
    for (const record of Object.values(collection)) {
      keys(record, ['version', 'values']); assert(Number.isSafeInteger(record.version) && record.version >= 0, 'Invalid record version');
      keys(record.values, Object.keys(r.fields));
      for (const [f, spec] of Object.entries(r.fields)) value(spec, record.values[f]);
    }
  }
  return s;
}

function evaluate(e:Expr, ctx:Context):CoreValue {
  if (e.op === 'literal') return e.value;
  if (e.op === 'input') {
    const arg=ownValue(ctx.inv.args,e.name);
    assert(arg!==undefined,'Missing input');
    return arg;
  }
  if (e.op === 'actor') return ctx.inv.actor;
  if (e.op === 'clock') return ctx.inv.clock;
  if (e.op === 'field') {
    const field=ownValue(ctx.bound.get(e.binding)?.record.values,e.field);
    assert(field!==undefined,'Missing bound field');
    return field;
  }
  if (e.op === 'not') return !evaluate(e.value, ctx);
  assert('left' in e&&'right' in e,'Missing binary operands');
  const l = evaluate(e.left, ctx), r = evaluate(e.right, ctx);
  switch (e.op) {
    case 'add': case 'sub': {
      assert(typeof l==='number'&&typeof r==='number','Expected integer operands');
      const n = e.op === 'add' ? BigInt(l) + BigInt(r) : BigInt(l) - BigInt(r);
      assert(n >= -9007199254740991n && n <= 9007199254740991n, 'Integer overflow', 'overflow'); return Number(n);
    }
    case 'eq': return l === r;
    case 'lt': case 'le':
      assert(typeof l==='number'&&typeof r==='number','Expected integer operands');
      return e.op==='lt'?l<r:l<=r;
    case 'and': return l && r;
    case 'or': return l || r;
    default: fail('unsupported', 'Unknown expression');
  }
}
const increment = (x:number) => { assert(x < Number.MAX_SAFE_INTEGER, 'Version overflow', 'overflow'); return x + 1; };
const rejection = (state:State,error:unknown):Rejected=>Object.freeze({status:'rejected',code:error instanceof Error&&'code' in error&&typeof error.code==='string'?error.code:'invalid',reason:errorMessage(error),state});

/** Tokens are opaque interpreter-owned capabilities, not serializable commands. */
export function createInterpreter(source: unknown): Readonly<Interpreter> {
  const model = validateModel(source), tokens = new WeakMap<Token,Plan>();
  const relations = new Map(model.relationships.map(r => [r.id, r]));
  function prepare(state:State, invocation:Invocation):Preparation {
    try {
      const before = checkState(model, state), inv = jsonSnapshot(invocation);
      keys(inv, ['id', 'action', 'args', 'actor', 'clock']);
      assert(safeKey(inv.id) && safeKey(inv.actor) && Number.isSafeInteger(inv.clock) && inv.clock >= 0, 'Invalid invocation identity/clock');
      const a=ownValue(model.actions,inv.action);
      assert(a,'Unknown action');keys(inv.args,Object.keys(a.inputs));
      for (const [k, s] of Object.entries(a.inputs)) value(s, inv.args[k]);
      const bound = new Map<string,Bound>(), ctx = {inv, bound};
      for (const b of a.bindings) {
        const key=evaluate(b.key,ctx),record=ownValue(ownValue(before.records,b.resource),key);
        assert(safeKey(key)&&record,'Missing bound record','missing-record');
        bound.set(b.id,{resource:b.resource,key,record});
      }
      const matches = a.policies.filter(p => evaluate(p.when, ctx));
      if (matches.some(p => p.effect === 'deny') || !matches.some(p => p.effect === 'allow' || p.effect === 'approval-required')) fail('denied', 'Policy denied');
      const failed = a.preconditions.find(p => !evaluate(p.when, ctx));
      if (failed) fail('precondition', failed.id);
      if (matches.some(p => p.effect === 'approval-required')) return Object.freeze({status: 'pending', policyIds: Object.freeze(matches.filter(p => p.effect === 'approval-required').map(p => p.id)), state});
      // Every RHS reads ctx.bound, which contains only immutable prestate records.
      const patches: Patch[] = [], writes = new Set();
      for (const u of a.updates) {
        const b = bound.get(u.target);assert(b,'Missing update binding');
        const address = JSON.stringify([b.resource, b.key, u.field]);
        assert(!writes.has(address), 'Aliased grouped write', 'conflicting-update'); writes.add(address);
        const spec=ownValue(ownValue(model.resources,b.resource)?.fields,u.field);
        assert(spec,'Unknown update field');
        const next = evaluate(u.value, ctx); value(spec,next);
        const prior=ownValue(b.record.values,u.field);assert(prior!==undefined,'Missing update field');
        patches.push({semanticId: u.id, resource: b.resource, key: b.key, field: u.field, before: prior, after: next});
      }
      const candidate:State = JSON.parse(JSON.stringify(before)), touched = new Set<string>();
      for (const p of patches) {
        const r=ownValue(ownValue(candidate.records,p.resource),p.key);assert(r,'Missing candidate record');
        r.values[p.field] = p.after;
        const address = JSON.stringify([p.resource, p.key]);
        if (!touched.has(address)) { r.version = increment(r.version); touched.add(address); }
      }
      candidate.revision = increment(candidate.revision);
      const nextState = checkState(model, candidate);
      // Routing snapshots poststate; duplicate support paths do not duplicate recipients.
      const recipients = new Map<string,Map<string,Recipient['paths'][number]>>();
      for (const o of a.observe) {
        const b = bound.get(o.binding), r = relations.get(o.relationship);
        assert(b&&r,'Missing observation declaration','routing');
        const record=ownValue(ownValue(nextState.records,b.resource),b.key);
        assert(record,'Missing observation record','routing');
        const raw=ownValue(record.values,r.field);
        for (const recipient of Array.isArray(raw) ? raw : [raw]) {
          assert(safeKey(recipient), 'Invalid relationship recipient', 'routing');
          if (recipient === inv.actor) continue;
          let paths=recipients.get(recipient);
          if (!paths) { paths=new Map();recipients.set(recipient,paths); }
          const path = {relationship: r.id, resource: b.resource, key: b.key};
          paths.set(canonical(path), path);
        }
      }
      const routing = [...recipients].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([recipient, paths]) => ({recipient, paths: [...paths.values()].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0)}));
      const eventBase = {modelId: model.id, actionId: inv.action, invocationId: inv.id, actor: inv.actor, clock: inv.clock, revision: nextState.revision, recipients: routing};
      const eventPrefix = `event:${encodeURIComponent(inv.id)}`;
      const events:Event[] = [{...eventBase, id: `${eventPrefix}:action`, kind: 'action', semanticId: inv.action}, ...patches.filter(p => canonical(p.before) !== canonical(p.after)).map((p):Event => ({...eventBase, id: `${eventPrefix}:change:${encodeURIComponent(p.semanticId)}`, kind: 'change', ...p}))];
      const token:Token = freeze({kind: 'semantic-prepared/v1'});
      tokens.set(token, {before: canonical(before), state: nextState, events: jsonSnapshot(events)});
      return freeze({status: 'prepared', prepared: token as Prepared});
    } catch (error) { return rejection(state, error); }
  }
  function commit(state:State, token:Token):Committed|Rejected {
    try {
      const plan = tokens.get(token); assert(plan, 'Foreign or serialized token', 'invalid-token');
      const current = checkState(model, state);
      assert(canonical(current) === plan.before, 'Prestate changed; prepare again', 'stale');
      return freeze({status: 'committed', state: plan.state, events: plan.events});
    } catch (error) { return rejection(state, error); }
  }
  return Object.freeze({model, prepare, commit, execute(state:State, inv:Invocation) { const p = prepare(state, inv); return p.status === 'prepared' ? commit(state, p.prepared) : p; }});
}
