/** semantic-core/v2. Explicit opt-in lifecycle profile. */
import {errorMessage} from '../../errors.ts';
import {jsonSnapshot} from '../core.ts';
import {assert, binary, canonical, checkInvocation, checkRecords, evaluate, fields, increment, keys, obj, own, ownValue, routeRecipients, safeKey, value} from '../primitives.ts';
import type {Kind} from '../primitives.ts';
import type {ApprovalReceipt, ApprovalRequest, ApprovalResult, Committed, Event, Expr, Grant, Interpreter, InvocationInput, Model, Pending, Prepared, PreparedResult, RecordSnapshot, Rejected, State, Value} from './types.ts';
export type * from './types.ts';
type Patch<K extends 'change'|'create'|'delete'> = Omit<Extract<Event,{kind:K}>,'kind'|'id'|'modelId'|'actionId'|'invocationId'|'actor'|'clock'|'revision'|'recipients'>;
export {jsonSnapshot};
type Address={resource:string;key:string};
type Bound=Address&{record:RecordSnapshot};
type Token={readonly kind:'semantic-prepared/v2'};
type Plan={before:string;state:State;events:readonly Event[]};
type MutableState={revision:number;records:Record<string,Record<string,{version:number;values:Record<string,Value>}>>};
const equal = (a:unknown,b:unknown) => canonical(a) === canonical(b);

export function validateModel(source: unknown): Model {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- The checks below validate the frozen declaration before returning it.
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
  const s = jsonSnapshot(source);
  assertState(model,s);
  return s;
}
function assertState(model:Model,s:unknown):asserts s is State {
  const record=keys(s, ['revision', 'records']),revision=record['revision'];
  assert(typeof revision==='number'&&Number.isSafeInteger(revision)&&revision>=0, 'Invalid revision');
  const records=keys(record['records'], Object.keys(model.resources));
  for (const [rid, r] of Object.entries(model.resources)) {
    const collection=ownValue(records,rid);
    assert(collection&&obj(collection),'Invalid resource collection');
    checkRecords(collection, r.fields);
  }
}
export function validateState(model: Model, source: unknown): State { return checkState(validateModel(model), source); }
const rejection = (state:State,error:unknown):Rejected=>Object.freeze({status:'rejected',code:error instanceof Error&&'code' in error&&typeof error.code==='string'?error.code:'invalid',reason:errorMessage(error),state});

export function createInterpreter(source: unknown): Readonly<Interpreter> {
  const model = validateModel(source), tokens = new WeakMap<Token,Plan>();
  const isPrepared=(token:Token):token is Prepared=>tokens.has(token);
  const relations = new Map(model.relationships.map(r => [r.id, r]));
  function context(state:State,invocation:InvocationInput) {
    const before = checkState(model, state), input = jsonSnapshot(invocation);
    const {a, inv} = checkInvocation(model.actions, input, 'Invalid invocation');
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
    const nextState = checkState(model, candidate);
    const routing = routeRecipients(a.observe, inv.actor, o => {
      const b=bound.get(o.binding),r=relations.get(o.relationship);
      assert(b&&r,'Missing observation declaration','routing');
      // Deleted observations deliberately retain prestate recipients. Others use poststate.
      const record=ownValue(ownValue(nextState.records,b.resource),b.key)??b.record;
      return {path: {relationship: r.id, resource: b.resource, key: b.key}, raw: record.values[r.field]};
    });
    const base = {modelId: model.id, actionId: inv.action, invocationId: inv.id, actor: inv.actor, clock: inv.clock, revision: nextState.revision, recipients: routing};
    const prefix = `event:${encodeURIComponent(inv.id)}`;
    const factId=(kind:Event['kind'],id:string)=>`${prefix}:${kind}:${encodeURIComponent(id)}`;
    const events = jsonSnapshot<Event[]>([{...base, id: `${prefix}:action`, kind: 'action', semanticId: inv.action},
      ...patches.filter(p => !equal(p.before,p.after)).map((p):Event=>({...base,id:factId('change',p.semanticId),kind:'change',...p})),
      ...inserts.map((p):Event=>({...base,id:factId('create',p.semanticId),kind:'create',...p})),
      ...deletes.map((p):Event=>({...base,id:factId('delete',p.semanticId),kind:'delete',...p}))]);
    const token:Token = Object.freeze({kind: 'semantic-prepared/v2'});
    tokens.set(token, {before: canonical(before), state: nextState, events});
    assert(isPrepared(token), 'Unregistered preparation token');
    return Object.freeze({status: 'prepared', prepared: token});
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
  function prepareResume(state:State,invocation:InvocationInput,source:ApprovalRequest,receipts:readonly ApprovalReceipt[],options:{readonly clock:number}):PreparedResult|Rejected {
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
