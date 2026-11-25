/** semantic-core/v2. Explicit independent lifecycle profile; v1 is unchanged. */
import {errorMessage} from '../../errors.ts';
import {jsonSnapshot,ownValue} from '../core.ts';
import type {ApprovalReceipt, ApprovalRequest, ApprovalResult, Committed, Event, Expr, FieldSchema, Grant, Interpreter, Invocation, InvocationInput, Model, Pending, Prepared, PreparedResult, Recipient, RecordSnapshot, Rejected, State, Value} from './types.ts';
export type * from './types.ts';
type Patch<K extends 'change'|'create'|'delete'> = Omit<Extract<Event,{kind:K}>,'kind'|'id'|'modelId'|'actionId'|'invocationId'|'actor'|'clock'|'revision'|'recipients'>;
export {jsonSnapshot};
type Address={resource:string;key:string};
type Bound=Address&{record:RecordSnapshot};
type EvalContext={inv:Invocation;bound:Map<string,Bound>};
type Token={readonly kind:'semantic-prepared/v2'};
type Plan={before:string;state:State;events:readonly Event[]};
type MutableState={revision:number;records:Record<string,Record<string,{version:number;values:Record<string,Value>}>>};
const own = (o:object,k:PropertyKey) => Object.hasOwn(o,k);
const obj = (x:unknown):x is Record<string,unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
function fail(code:string,message?:string):never { throw Object.assign(new Error(message),{code}); }
function assert(p:unknown,message:string|undefined,code='invalid'):asserts p { if(!p)fail(code,message); }
const safeKey = (k:unknown):k is string => typeof k === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(k) && !['constructor', 'prototype', '__proto__'].includes(k);
function keys(x:unknown,names:readonly string[]):asserts x is Record<string,unknown> {assert(obj(x) && Object.keys(x).length === names.length && names.every(k => own(x, k)), `Expected exactly ${names.join(', ')}`);}
const canonical = (x:unknown):string => Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : obj(x)
  ? `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}` : JSON.stringify(x);
const equal = (a:unknown,b:unknown) => canonical(a) === canonical(b);
const increment = (x:number) => { assert(x < Number.MAX_SAFE_INTEGER, 'Version overflow', 'overflow'); return x + 1; };
function schema(s:unknown) {
  assert(obj(s)&&typeof s['type']==='string'&&['integer','string','boolean','ids'].includes(s['type']), 'Unsupported schema');
  const allowed = s['type'] === 'integer' ? ['type', 'min', 'max'] : s['type'] === 'string' ? ['type', 'enum'] : ['type'];
  assert(Object.keys(s).every(k => allowed.includes(k)), 'Unknown schema member');
  const min=s['min'],max=s['max'],choices=s['enum'];
  if (own(s, 'min')) assert(typeof min==='number'&&Number.isSafeInteger(min), 'Invalid minimum');
  if (own(s, 'max')) assert(typeof max==='number'&&Number.isSafeInteger(max), 'Invalid maximum');
  if (typeof min==='number'&&typeof max==='number') assert(min<=max, 'Inverted bounds');
  if (own(s, 'enum')) assert(Array.isArray(choices) && choices.length > 0 && choices.every(x => typeof x === 'string') && new Set(choices).size === choices.length, 'Invalid enum');
}
function value(s:FieldSchema,x:unknown):asserts x is Value {
  const valid = s.type === 'integer' ? typeof x==='number'&&Number.isSafeInteger(x) && !Object.is(x, -0) && (s.min===undefined||x>=s.min) && (s.max===undefined||x<=s.max)
    : s.type === 'string' ? typeof x === 'string' && (!s.enum || s.enum.includes(x))
    : s.type === 'boolean' ? typeof x === 'boolean' : Array.isArray(x) && x.every(safeKey);
  assert(valid, `Value violates ${s.type} schema`, 'schema');
}
function checkArgs(inputs:Readonly<Record<string,FieldSchema>>,args:unknown):asserts args is Invocation['args'] {
  keys(args,Object.keys(inputs));
  for(const [name,schema] of Object.entries(inputs))value(schema,args[name]);
}
function fields(o:unknown) { assert(obj(o), 'Expected field map'); Object.values(o).forEach(schema); }
type Kind=FieldSchema['type'];
const binary:Readonly<Record<string,readonly [Kind,Kind]>> = {add: ['integer', 'integer'], sub: ['integer', 'integer'], lt: ['integer', 'boolean'], le: ['integer', 'boolean'], and: ['boolean', 'boolean'], or: ['boolean', 'boolean']};

export function validateModel(source: unknown): Model {
  const m = jsonSnapshot(source) as Model;
  keys(m, ['format', 'id', 'resources', 'relationships', 'actions']);
  assert(m.format === 'semantic-core/v2', 'Unsupported semantic profile');
  const ids = new Set<string>(), relationships = new Map<string,Model['relationships'][number]>();
  const id = (x:unknown) => { assert(safeKey(x) && !ids.has(x), `Invalid/duplicate semantic ID: ${x}`); ids.add(x); };
  id(m.id);
  assert(obj(m.resources) && obj(m.actions) && Array.isArray(m.relationships), 'Invalid model collections');
  for (const [rid, r] of Object.entries(m.resources)) { id(rid); keys(r, ['fields']); fields(r.fields); }
  for (const r of m.relationships) {
    keys(r, ['id', 'resource', 'field']); id(r.id);
    const spec=ownValue(ownValue(m.resources,r.resource)?.fields,r.field);
    assert(spec&&(spec.type==='string'||spec.type==='ids'),'Invalid relationship');
    relationships.set(r.id, r);
  }
  for (const [aid, a] of Object.entries(m.actions)) {
    id(aid); keys(a, ['inputs', 'bindings', 'preconditions', 'policies', 'updates', 'inserts', 'deletes', 'observe']); fields(a.inputs);
    const collections:readonly (keyof Omit<typeof a,'inputs'>)[]=['bindings','preconditions','policies','updates','inserts','deletes','observe'];
    for (const k of collections) assert(Array.isArray(a[k]), `Expected ${k} array`);
    const bindings = new Map<string,string>(), observable = new Map<string,string>();
    function type(e:Expr|undefined, allowFields = true):Kind {
      assert(obj(e) && typeof e.op === 'string', 'Invalid expression');
      if (e.op === 'literal') { keys(e, ['op', 'value']); const t = typeof e.value; assert(t==='string'||t==='number'||t==='boolean', 'Unsupported literal'); return t === 'number' ? 'integer' : t; }
      if (e.op === 'input') { keys(e, ['op', 'name']); const spec=ownValue(a.inputs,e.name);assert(spec,'Unknown input');return spec.type; }
      if (e.op === 'actor' || e.op === 'clock') { keys(e, ['op']); return e.op === 'actor' ? 'string' : 'integer'; }
      if (e.op === 'field') { keys(e, ['op', 'binding', 'field']); const spec=ownValue(ownValue(m.resources,bindings.get(e.binding))?.fields,e.field);assert(allowFields&&spec,'Unknown field binding');return spec.type; }
      if (e.op === 'not') { keys(e, ['op', 'value']); assert(type(e.value, allowFields) === 'boolean', 'Unary type mismatch'); return 'boolean'; }
      keys(e, ['op', 'left', 'right']);
      if (e.op === 'eq') { const t = type(e.left, allowFields); assert(t !== 'ids' && t === type(e.right, allowFields), 'Equality type mismatch'); return 'boolean'; }
      const operator=ownValue(binary,e.op);
      assert(operator, `Unsupported operator ${e.op}`);
      const [input, output] = operator;
      assert('left' in e&&'right' in e,'Missing binary operands');
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
      const spec=ownValue(ownValue(m.resources,bindings.get(u.target))?.fields,u.field);
      assert(spec&&type(u.value)===spec.type,'Update type mismatch');
    }
    for (const i of a.inserts) {
      keys(i, ['id', 'resource', 'key', 'values']); id(i.id);
      const resource=ownValue(m.resources,i.resource);
      assert(resource&&type(i.key,false)==='string','Invalid insert');
      keys(i.values,Object.keys(resource.fields));
      for (const [f,s] of Object.entries(resource.fields)) assert(type(i.values[f])===s.type,'Insert type mismatch');
      observable.set(i.id, i.resource);
    }
    for (const d of a.deletes) { keys(d, ['id', 'target']); id(d.id); assert(bindings.has(d.target), 'Unknown delete binding'); }
    for (const o of a.observe) { keys(o, ['binding', 'relationship']);const relationship=relationships.get(o.relationship);assert(relationship&&observable.get(o.binding)===relationship.resource,'Invalid observation'); }
  }
  return m;
}
function checkState(model: Model, source: unknown): State {
  const s = jsonSnapshot(source) as State;
  keys(s, ['revision', 'records']); assert(Number.isSafeInteger(s.revision) && s.revision >= 0, 'Invalid revision');
  keys(s.records, Object.keys(model.resources));
  for (const [rid, r] of Object.entries(model.resources)) {
    const collection=ownValue(s.records,rid);
    assert(collection&&obj(collection),'Invalid resource collection');
    for (const record of Object.values(collection)) {
      keys(record, ['version', 'values']); assert(Number.isSafeInteger(record.version) && record.version >= 0, 'Invalid record version');
      keys(record.values, Object.keys(r.fields));
      for (const [f, spec] of Object.entries(r.fields)) value(spec, record.values[f]);
    }
  }
  return s;
}
export function validateState(model: Model, source: unknown): State { return checkState(validateModel(model), source); }
function evaluate(e:Expr,ctx:EvalContext):Value {
  if (e.op === 'literal') return e.value;
  if (e.op === 'input') {const arg=ownValue(ctx.inv.args,e.name);assert(arg!==undefined,'Missing input');return arg;}
  if (e.op === 'actor') return ctx.inv.actor;
  if (e.op === 'clock') return ctx.inv.clock;
  if (e.op === 'field') {const field=ownValue(ctx.bound.get(e.binding)?.record.values,e.field);assert(field!==undefined,'Missing bound field');return field;}
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
const rejection = (state:State,error:unknown):Rejected=>Object.freeze({status:'rejected',code:error instanceof Error&&'code' in error&&typeof error.code==='string'?error.code:'invalid',reason:errorMessage(error),state});

export function createInterpreter(source: unknown): Readonly<Interpreter> {
  const model = validateModel(source), tokens = new WeakMap<Token,Plan>();
  const relations = new Map(model.relationships.map(r => [r.id, r]));
  function context(state:State,invocation:InvocationInput) {
    const before = checkState(model, state), input = jsonSnapshot(invocation);
    keys(input, ['id', 'action', 'args', 'actor', 'clock']);
    assert(safeKey(input.id) && safeKey(input.actor) && Number.isSafeInteger(input.clock) && input.clock >= 0, 'Invalid invocation');
    const a=ownValue(model.actions,input.action);
    assert(a,'Unknown action');const {args}=input;
    checkArgs(a.inputs,args);
    const inv:Invocation={...input,args};
    const bound = new Map<string,Bound>(), ctx = {inv, bound};
    for (const b of a.bindings) {
      const key = evaluate(b.key, ctx); assert(safeKey(key), 'Invalid record key');
      const record=ownValue(ownValue(before.records,b.resource),key);
      assert(record,'Missing bound record','missing-record');
      bound.set(b.id,{resource:b.resource,key,record});
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
  const requestFor = (c:ReturnType<typeof context>):ApprovalRequest => jsonSnapshot({format: 'semantic-approval-request/v2', model, invocation: c.inv, prestate: c.before, requirements: c.requirements});
  function checkedRequest(source:ApprovalRequest) {
    const request = jsonSnapshot(source);
    keys(request, ['format', 'model', 'invocation', 'prestate', 'requirements']);
    assert(request.format === 'semantic-approval-request/v2' && equal(request.model, model), 'Approval model changed', 'stale');
    const c = context(request.prestate, request.invocation);
    assert(c.requirements.length > 0 && equal(request, requestFor(c)), 'Approval context changed', 'stale');
    return {request, c};
  }
  function plan(c:ReturnType<typeof context>):PreparedResult {
    const {before, inv, a, bound, ctx} = c;
    const patches: Patch<'change'>[] = [], inserts: Patch<'create'>[] = [], deletes: Patch<'delete'>[] = [];
    const fieldsWritten = new Set(), recordsUpdated = new Set(), exclusive = new Set();
    const address = (b:Address) => canonical([b.resource,b.key]);
    for (const u of a.updates) {
      const b=bound.get(u.target);assert(b,'Missing update binding');
      const field = canonical([b.resource, b.key, u.field]);
      assert(!fieldsWritten.has(field), 'Aliased grouped field write', 'conflicting-update'); fieldsWritten.add(field); recordsUpdated.add(address(b));
      const spec=ownValue(ownValue(model.resources,b.resource)?.fields,u.field);
      assert(spec,'Unknown update field');
      const next = evaluate(u.value, ctx);value(spec,next);
      const prior=ownValue(b.record.values,u.field);assert(prior!==undefined,'Missing update field');
      patches.push({semanticId: u.id, resource: b.resource, key: b.key, field: u.field, before: prior, after: next});
    }
    for (const d of a.deletes) {
      const b=bound.get(d.target);assert(b,'Missing delete binding');
      const addr=address(b);
      assert(!exclusive.has(addr) && !recordsUpdated.has(addr), 'Conflicting record deletion', 'conflicting-update'); exclusive.add(addr);
      deletes.push({semanticId: d.id, resource: b.resource, key: b.key, before: b.record});
    }
    for (const i of a.inserts) {
      const key=evaluate(i.key,ctx);
      assert(safeKey(key), 'Invalid insert key');
      const b={resource:i.resource,key},addr=address(b);
      assert(!exclusive.has(addr) && !recordsUpdated.has(addr), 'Conflicting record insertion', 'conflicting-update'); exclusive.add(addr);
      const resource=ownValue(model.resources,i.resource),collection=ownValue(before.records,i.resource);
      assert(resource&&collection,'Unknown insert resource');
      assert(!own(collection,key),'Insert target exists','existing-record');
      const values:Record<string,Value> = {};
      for (const [f,e] of Object.entries(i.values)) {
        const spec=ownValue(resource.fields,f);
        assert(spec,'Unknown insert field');
        values[f]=evaluate(e,ctx);value(spec,values[f]);
      }
      const record = {version: 0, values}; inserts.push({semanticId: i.id, ...b, after: record});
      // Observation only: expressions cannot reference inserted records.
      bound.set(i.id, {...b, record});
    }
    const candidate:MutableState = JSON.parse(JSON.stringify(before)), touched = new Set<string>();
    for (const p of patches) {
      const r=ownValue(ownValue(candidate.records,p.resource),p.key);assert(r,'Missing candidate record');
      const addr = address(p);r.values[p.field]=p.after;
      if (!touched.has(addr)) { r.version = increment(r.version); touched.add(addr); }
    }
    for (const d of deletes) {const records=ownValue(candidate.records,d.resource);assert(records,'Missing delete resource');delete records[d.key];}
    for (const i of inserts) {const records=ownValue(candidate.records,i.resource);assert(records,'Missing insert resource');records[i.key]=i.after;}
    candidate.revision = increment(candidate.revision);
    const nextState = checkState(model, candidate), recipients = new Map<string,Map<string,Recipient['paths'][number]>>();
    for (const o of a.observe) {
      const b=bound.get(o.binding),r=relations.get(o.relationship);
      assert(b&&r,'Missing observation declaration','routing');
      // Deleted observations deliberately retain prestate recipients. Others use poststate.
      const record=ownValue(ownValue(nextState.records,b.resource),b.key)??b.record,raw=record.values[r.field];
      for (const recipient of Array.isArray(raw) ? raw : [raw]) {
        assert(safeKey(recipient), 'Invalid relationship recipient', 'routing');
        if (recipient === inv.actor) continue;
        let paths=recipients.get(recipient);
        if (!paths) {paths=new Map();recipients.set(recipient,paths);}
        const path = {relationship: r.id, resource: b.resource, key: b.key};paths.set(canonical(path),path);
      }
    }
    const compare = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0;
    const routing = [...recipients].sort(([a], [b]) => compare(a, b)).map(([recipient, paths]) => ({recipient, paths: [...paths.values()].sort((a, b) => compare(canonical(a), canonical(b)))}));
    const base = {modelId: model.id, actionId: inv.action, invocationId: inv.id, actor: inv.actor, clock: inv.clock, revision: nextState.revision, recipients: routing};
    const prefix = `event:${encodeURIComponent(inv.id)}`;
    const factId=(kind:Event['kind'],id:string)=>`${prefix}:${kind}:${encodeURIComponent(id)}`;
    const events = jsonSnapshot<Event[]>([{...base, id: `${prefix}:action`, kind: 'action', semanticId: inv.action},
      ...patches.filter(p => !equal(p.before,p.after)).map((p):Event=>({...base,id:factId('change',p.semanticId),kind:'change',...p})),
      ...inserts.map((p):Event=>({...base,id:factId('create',p.semanticId),kind:'create',...p})),
      ...deletes.map((p):Event=>({...base,id:factId('delete',p.semanticId),kind:'delete',...p}))]);
    const token:Token = Object.freeze({kind: 'semantic-prepared/v2'});
    tokens.set(token, {before: canonical(before), state: nextState, events});
    return Object.freeze({status: 'prepared', prepared: token as Prepared});
  }
  function prepare(state:State,invocation:InvocationInput):PreparedResult|Pending|Rejected {
    try {
      const c = context(state, invocation);
      return c.requirements.length ? Object.freeze({status: 'pending', policyIds: Object.freeze(c.requirements.map(p => p.policyId)), request: requestFor(c), state}) : plan(c);
    } catch (error) { return rejection(state, error); }
  }
  function commit(state:State,token:Token):Committed|Rejected {
    try {
      const p = tokens.get(token); assert(p, 'Foreign or serialized token', 'invalid-token');
      assert(canonical(checkState(model, state)) === p.before, 'Prestate changed', 'stale');
      return Object.freeze({status: 'committed', state: p.state, events: p.events});
    } catch (error) { return rejection(state, error); }
  }
  function approve(source:ApprovalRequest,grant:Grant):ApprovalResult {
    try {
      const {request} = checkedRequest(source), g = jsonSnapshot(grant); keys(g, ['policyId', 'approver']);
      assert(safeKey(g.approver), 'Invalid approver');
      const p = request.requirements.find(p => p.policyId === g.policyId);
      assert(p && p.approvers.includes(g.approver), 'Approver not eligible', 'unauthorized-approval');
      return Object.freeze({status: 'approved', receipt: jsonSnapshot<ApprovalReceipt>({format: 'semantic-approval-receipt/v2', request, ...g})});
    } catch (error) {
      const code=error instanceof Error&&'code' in error&&typeof error.code==='string' ? error.code : 'invalid';
      return Object.freeze({status: 'rejected', code, reason: errorMessage(error)});
    }
  }
  function prepareResume(state:State,invocation:Invocation,source:ApprovalRequest,receipts:readonly ApprovalReceipt[],options:{readonly clock:number}):PreparedResult|Rejected {
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
  const finish = (state:State,p:PreparedResult|Pending|Rejected) => p.status === 'prepared' ? commit(state, p.prepared) : p;
  return Object.freeze({model, prepare, commit, approve, prepareResume,
    execute(state:State,invocation:InvocationInput) { return finish(state, prepare(state, invocation)); },
    resume(...args:Parameters<Interpreter['resume']>) { const p=prepareResume(...args);return p.status==='prepared'?commit(args[0],p.prepared):p; }});
}
