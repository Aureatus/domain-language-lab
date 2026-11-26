import {asError,errorMessage} from '../../errors.ts';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeDurableRuntime, makeDurableStore, initializeDurableState, durableExecute, durableApprove, durableResume, durablePending, durableState, pullOutbox, acknowledgeOutbox, closeDurableStore} from '../../adapters/effect/durable.ts';
import {Effect} from '../../adapters/effect/index.ts';
import {decodeJsonObject, encodeJson, encodeJsonPretty, encodeCanonicalJson as canonical} from '../../adapters/effect/json.ts';
import {inventoryV2Model, initialState, invocation} from './model.ts';
import type {ApprovalReceipt, ApprovalRequest, Grant, Value} from '../../semantic/v2/types.ts';

const run = Effect.runPromise;
const copy = structuredClone;
const policyId = 'reserve.warehouse-approval';
const rng = (seed:number) => { let x = seed >>> 0; return () => { x = (x + 0x6d2b79f5) | 0; let t = Math.imul(x ^ x >>> 15, 1 | x); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 0x100000000; }; };
const positiveInteger = (n:number, name:string) => { if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`${name} must be a positive safe integer`); return n; };
const validSeed = (n:number) => { if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new TypeError('seed must be a uint32'); return n; };
type Execute = {api: 'execute'; command: ReturnType<typeof invocation>};
type Approve = {api: 'approve'; command: {id: string; invocationId: string; policyId: string}; host: {authenticatedApprover: string}};
type Resume = {api: 'resume'; command: {id: string; invocationId: string; clock: number}};
type Operation = Execute | Approve | Resume;
type Reservation = {version: number; values: {stockId: string; owner: string; quantity: number; expiresAt: number; status: string}};
type OracleState = {
  revision: number;
  records: {stock: {camera: {version: number; values: {available: number; capacity: number; watchers: readonly string[]; operator: string}}}; reservation: Record<string, Reservation>};
};
type Pending = {invocation: Execute['command']; prestate: OracleState; grants: Grant[]; status: 'pending' | 'consumed'; resumeId: string | null};
type Prediction = {status: 'committed' | 'pending' | 'approved' | 'rejected'; code?: string; invocation?: Execute['command']; state?: OracleState}
  | {status: 'duplicate'; result: Prediction; code?: never; state?: never};
type Oracle = {state: OracleState; pending: Record<string, Pending>; ledger: Map<string, {op: Operation; expected: Prediction}>};
type ObservedEvent = {readonly id:string;readonly kind?:unknown;readonly invocationId?:unknown;readonly actionId?:unknown;readonly actor?:unknown;readonly clock?:unknown;readonly revision?:unknown};
type ObservedResult = {
  status: string; code?: string;
  state?: unknown; events?: readonly ObservedEvent[];
  result?: ObservedResult;
  policyIds?: readonly string[];
  request?: ApprovalRequest;
  receipt?: ApprovalReceipt;
};
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
type Observation = {result: ObservedResult; snapshot: Snapshot};
type Counterexample = {status: 'counterexample'; index?: number; phase?: string; command?: Operation; expected?: Prediction; actual?: ObservedResult; cause: {name: string; message: string; expected?: unknown; actual?: unknown}; failingPrefix: Operation[]};
type Case = {seed: number; commands: Operation[]; observations: Observation[]; checks: 'passed' | 'counterexample'; restartBoundaries: number; counterexample?: Counterexample; replay?: {status: 'passed'; comparison: string}};
type History = {seed: number; observations?: unknown[]} & ({commands: Operation[]; failingPrefix?: Operation[]} | {commands?: undefined; failingPrefix: Operation[]});
type GeneratedOptions = {reportPath?: string; seed?: number; runs?: number; steps?: number; histories?: History[]};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function isOperation(value: unknown): value is Operation {
  if (!isObject(value) || !isObject(value['command']) || typeof value['command']['id'] !== 'string') return false;
  const c = value['command'];
  switch (value['api']) {
    case 'execute': return typeof c['clock'] === 'number' && typeof c['action'] === 'string' && typeof c['actor'] === 'string' &&
      isObject(c['args']) && typeof c['args']['reservationId'] === 'string' && Object.values(c['args']).every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
    case 'approve': return typeof c['invocationId'] === 'string' && typeof c['policyId'] === 'string' &&
      isObject(value['host']) && typeof value['host']['authenticatedApprover'] === 'string';
    case 'resume': return typeof c['invocationId'] === 'string' && typeof c['clock'] === 'number';
    default: return false;
  }
}
function replayHistory(value: unknown): History {
  if (!isObject(value) || typeof value['seed'] !== 'number') throw new TypeError('Expected a seeded replay history');
  const commands = value['commands'] ?? value['failingPrefix'];
  if (!Array.isArray(commands) || !commands.every(isOperation)) throw new TypeError('Expected replay operations');
  if (value['observations'] !== undefined && !Array.isArray(value['observations'])) throw new TypeError('Expected replay observations');
  return {seed:value['seed'], commands, ...(value['observations']===undefined?{}:{observations:value['observations']})};
}
const count = (value: Value | undefined) => {
  assert.ok(typeof value === 'number');
  return value;
};

// Randomized block order, identities, IDs, quantities and clock offsets. Each block
// restores capacity; pending requests remain, making later full-state freshness real.
export function generatedHistory(seed: number, steps = 30) {
  validSeed(seed); positiveInteger(steps, 'steps');
  if (steps < 30) throw new RangeError('steps must be at least 30 for guaranteed boundary coverage');
  const random=rng(seed);
  function pick<T>(xs:readonly T[]):T {
    const item=xs[Math.floor(random()*xs.length)];
    assert.ok(item!==undefined,'Expected a nonempty generation pool');
    return item;
  }
  const owner = () => pick(['alice', 'bob', 'carol']);
  const prefix = `s${seed.toString(16)}`, blocks: Operation[][] = []; let serial = 0;
  const id = (label:string) => `${prefix}-${label}-${serial++}`;
  const action = (kind: string, reservationId: string, actor: string, clock: number, quantity = 1, expiresAt = clock + 20): Execute =>
    ({api:'execute', command:invocation(id(kind), kind, {reservationId, actor, clock, quantity, expiresAt})});
  const reserve = (label: string, actor: string, clock: number, quantity = 1, expiresAt = clock + 20) => {
    const reservationId = id(label);
    return {api:'execute' as const, command:invocation(id('reserve'), 'reserve', {reservationId, actor, clock, quantity, expiresAt})};
  };
  const grant = (op: Execute, actor = 'warehouse'): Approve => ({api:'approve', command:{id:id('grant'), invocationId:op.command.id, policyId}, host:{authenticatedApprover:actor}});
  const resume = (op: Execute, clock: number): Resume => ({api:'resume', command:{id:id('resume'), invocationId:op.command.id, clock}});
  const clock = () => 100 + Math.floor(random() * 1000);
  {
    const t = clock(), a = owner(), q = pick([1, 2]), r = reserve('cancel', a, t, q), key = r.command.args.reservationId;
    const cancel = action('cancel', key, a, t + 2);
    const b = owner(), e = reserve('expire', b, t + 4, pick([1, 2])), ek = e.command.args.reservationId;
    blocks.push([r, action('cancel', key, 'intruder', t + 1), action('expire', key, 'warehouse', t + 1), action('delete-terminal', key, a, t + 1), cancel, copy(cancel), action('cancel', key, a, t + 3), action('delete-terminal', key, a, t + 3), e, action('expire', ek, 'warehouse', e.command.args.expiresAt), action('delete-terminal', ek, b, e.command.args.expiresAt + 1)]);
  }
  {
    const t = clock(), a = owner(), r = reserve('approved', a, t, pick([3, 4])), key = r.command.args.reservationId, res = resume(r, t + 1);
    blocks.push([r, grant(r, 'intruder'), grant(r), res, copy(res), resume(r, t + 2), action('cancel', key, a, t + 3), action('delete-terminal', key, a, t + 4)]);
  }
  {
    const t = clock(), r = reserve('stale', owner(), t, pick([3, 4])), a = owner(), intervention = reserve('intervention', a, t + 1, pick([1, 2])), key = intervention.command.args.reservationId;
    blocks.push([r, grant(r), intervention, resume(r, t + 2), action('cancel', key, a, t + 3), action('delete-terminal', key, a, t + 4)]);
  }
  {
    const t = clock(), r = reserve('expired', owner(), t, pick([3, 4]));
    blocks.push([r, grant(r), resume(r, r.command.args.expiresAt)]);
  }
  for (let i=blocks.length-1;i>0;i--) {
    const j=Math.floor(random()*(i+1)), a=blocks[i],b=blocks[j];
    assert.ok(a&&b,'Missing block during shuffle');
    [blocks[i],blocks[j]]=[b,a];
  }
  const ops = blocks.flat(), t = clock();
  ops.push(reserve('invalid-expiry', owner(), t, 1, t));
  const first = ops.find(x => x.api === 'execute'); assert.ok(first);
  const conflict = copy(first); conflict.command.actor = 'intruder'; ops.push(conflict);
  // Optional extra commands explore capacity, existing IDs, absent records and denials.
  while (ops.length < steps) {
    const previous = pick(ops.filter(x => x.api === 'execute')), kind = pick(['reserve', 'cancel', 'expire', 'delete-terminal']), now = clock();
    ops.push(action(kind, pick([previous.command.args.reservationId, id('extra')]), pick(['alice', 'bob', 'carol', 'warehouse']), now, pick([1, 2, 3, 8, 9]), now + pick([0, 1, 20])));
  }
  return ops;
}

// An inventory-specific state machine. No execute/prepare/approve/resume calls,
// declaration traversal, or observed-success-driven oracle updates are used here.
function oracle(): Oracle {
  const camera=initialState.records['stock']?.['camera'];
  assert.ok(camera,'Missing initial camera stock');
  const {version,values:{available,capacity,watchers,operator}}=camera;
  assert.ok(Array.isArray(watchers) && typeof operator === 'string');
  return {state:{revision:initialState.revision, records:{stock:{camera:{version, values:{available:count(available), capacity:count(capacity), watchers:copy(watchers), operator}}}, reservation:{}}}, pending:{}, ledger:new Map()};
}
const reject = (code: string) => ({status:'rejected' as const, code});
function reserveValidity(state: OracleState, inv: Execute['command']) {
  const a = inv.args;
  if (count(a['quantity']) > state.records.stock.camera.values.available || inv.clock >= count(a['expiresAt'])) return 'precondition';
  return null;
}
function predict(o: Oracle, op: Operation): Prediction {
  const previous = o.ledger.get(op.command.id);
  if (previous) return canonical(previous.op) === canonical(op) ? {status:'duplicate', result:previous.expected} : reject('invocation-conflict');
  let expected: Exclude<Prediction, {status:'duplicate'}>, inv: Execute['command'] | undefined;
  if (op.api === 'execute') {
    const c = op.command;
    inv = c;
    const kind = c.action.split('.').at(-1), r = o.state.records.reservation[c.args.reservationId];
    if (kind === 'reserve') {
      const invalid = reserveValidity(o.state, c);
      if (invalid) expected = reject(invalid);
      else if (count(c.args['quantity']) >= 3) {
        expected = {status:'pending'};
        o.pending[c.id] = {invocation:copy(c), prestate:copy(o.state), grants:[], status:'pending', resumeId:null};
      } else if (r) expected = reject('existing-record');
      else expected = {status:'committed'};
    } else if (!r) expected = reject('missing-record');
    else if (c.actor !== (kind === 'expire' ? 'warehouse' : r.values.owner)) expected = reject('denied');
    else if (kind === 'delete-terminal' ? r.values.status === 'active' : r.values.status !== 'active' || kind === 'expire' && c.clock < r.values.expiresAt) expected = reject('precondition');
    else expected = {status:'committed'};
  } else {
    const p = o.pending[op.command.invocationId];
    if (!p) expected = reject('missing-request');
    else if (p.status === 'consumed') expected = reject('consumed');
    else if (op.api === 'approve') {
      const c = op.command;
      if (p.grants.length) expected = reject('already-granted');
      else if (c.policyId !== policyId || op.host.authenticatedApprover !== 'warehouse' || p.invocation.actor === 'warehouse') expected = reject('unauthorized-approval');
      else { expected = {status:'approved'}; p.grants.push({policyId, approver:'warehouse'}); }
    } else {
      const c = op.command;
      inv = {...p.invocation, clock:c.clock};
      if (c.clock < p.invocation.clock) expected = reject('invalid');
      else if (canonical(o.state) !== canonical(p.prestate)) expected = reject('stale');
      else if (reserveValidity(o.state, inv)) expected = reject('precondition');
      else if (!p.grants.length) expected = reject('approval');
      else if (o.state.records.reservation[inv.args.reservationId]) expected = reject('existing-record');
      else { expected = {status:'committed'}; p.status = 'consumed'; p.resumeId = c.id; }
    }
  }
  if (expected.status === 'committed') {
    assert.ok(inv);
    const kind = inv.action.split('.').at(-1), a = inv.args, stock = o.state.records.stock.camera, records = o.state.records.reservation;
    if (kind === 'reserve') { stock.values.available -= count(a['quantity']); stock.version++; records[a.reservationId] = {version:0, values:{stockId:'camera', owner:inv.actor, quantity:count(a['quantity']), expiresAt:count(a['expiresAt']), status:'active'}}; }
    else if (kind === 'delete-terminal') delete records[a.reservationId];
    else {
      const record=records[a.reservationId];
      assert.ok(record,'Missing committed reservation');
      stock.values.available+=record.values.quantity;stock.version++;record.version++;
      record.values.status=kind==='cancel'?'cancelled':'expired';
    }
    o.state.revision++;
    expected.invocation = copy(inv);
  }
  // Store independent historical state, not the current state at retry time.
  if (op.api === 'execute' || op.api === 'resume' && expected.code !== 'missing-request' && expected.code !== 'consumed') expected.state = copy(o.state);
  o.ledger.set(op.command.id, {op:copy(op), expected:copy(expected)});
  return expected;
}

function checkOutcome(actual:ObservedResult, expected: Prediction, o: Oracle, op: Operation):void {
  assert.equal(actual.status, expected.status, `expected ${expected.status}, received ${actual.status} for ${op.api} ${op.command.id}`);
  if (expected.code) assert.equal(actual.code, expected.code, 'rejection cause');
  if (expected.status === 'duplicate') {
    const entry = o.ledger.get(op.command.id);
    assert.ok(entry&&actual.result);
    return checkOutcome(actual.result, expected.result, o, entry.op);
  }
  if (expected.state) assert.deepEqual(actual.state, expected.state, 'returned domain state');
  if (expected.status === 'pending') {
    assert.deepEqual(actual.policyIds, [policyId]);
    checkRequest(actual.request, o.pending[op.command.id]);
  }
  if (expected.status === 'approved') {
    assert.ok(op.api === 'approve'&&actual.receipt);
    assert.equal(actual.receipt.policyId, policyId); assert.equal(actual.receipt.approver, 'warehouse');
    checkRequest(actual.receipt.request, o.pending[op.command.invocationId]);
  }
}
function checkRequest(actual:ApprovalRequest|undefined,p:Pending|undefined) {
  assert.ok(actual&&p);
  assert.equal(actual.format, 'semantic-approval-request/v2');
  assert.deepEqual(actual.model, inventoryV2Model, 'request model binding');
  assert.deepEqual(actual.invocation, p.invocation); assert.deepEqual(actual.prestate, p.prestate);
  assert.deepEqual(actual.requirements, [{policyId, approvers:p.invocation.actor === 'warehouse' ? [] : ['warehouse'], allowSelfApproval:false}]);
}
function checkEvents(events: NonNullable<ObservedResult['events']>, before: OracleState, after: OracleState, inv: Execute['command']) {
  // Check publication against independently predicted record differences, not deltas
  // returned by the interpreter. Routing contents are additionally covered by replay.
  const changes: {kind: string; resource: string; key: string; field?: string; before?: unknown; after?: unknown}[] = [];
  for (const resource of ['stock', 'reservation'] as const) {
    const collections=(s:OracleState):Readonly<Record<string,{values:Readonly<Record<string,Value>>}>>=>s.records[resource];
    const a=collections(before),b=collections(after);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const prior=a[key],next=b[key];
      if (!prior) changes.push({kind:'create', resource, key, after:next});
      else if (!next) changes.push({kind:'delete', resource, key, before:prior});
      else for (const field of Object.keys(prior.values)) if (canonical(prior.values[field]) !== canonical(next.values[field])) changes.push({kind:'change', resource, key, field, before:prior.values[field], after:next.values[field]});
    }
  }
  assert.equal(events.length, changes.length + 1, 'one action and exactly the predicted record changes');
  assert.equal(events[0]?.['kind'], 'action');
  const fields=new Set(['kind','resource','key','field','before','after']);
  const projection=(e:NonNullable<ObservedResult['events']>[number])=>Object.fromEntries(Object.entries(e).filter(([key])=>fields.has(key)));
  assert.deepEqual(events.slice(1).map(projection).sort((a,b) => canonical(a).localeCompare(canonical(b))), changes.sort((a,b) => canonical(a).localeCompare(canonical(b))));
  for (const event of events) {
    assert.equal(event['invocationId'], inv.id); assert.equal(event['actionId'], inv.action); assert.equal(event['actor'], inv.actor); assert.equal(event['clock'], inv.clock); assert.equal(event['revision'], after.revision);
  }
  assert.equal(new Set(events.map(e => e.id)).size, events.length);
}

// Also used unchanged for all observation mutations. Mutators never touch oracle
// predictions, generated commands, or the actual database.
export function checkHistory(commands: Operation[], observations: Observation[]): {status: 'passed'; steps: number} | Counterexample {
  const o = oracle(); let previousEvents: Snapshot['events'] = [];
  for (const [index,op] of commands.entries()) {
    let expected: Prediction | undefined;
    try {
      const before = copy(o.state); expected = predict(o, op);
      const observation=observations[index];
      assert.ok(observation,'Missing step observation');
      const {result,snapshot}=observation;
      checkOutcome(result, expected, o, op);
      assert.deepEqual(snapshot.state, o.state, 'persisted domain state');
      assert.equal(snapshot.state.records.stock.camera.values.available, 8 - Object.values(o.state.records.reservation).filter(r => r.values.status === 'active').reduce((n,r) => n + r.values.quantity, 0), 'capacity conservation');
      for (const [id, p] of Object.entries(o.pending)) {
        const actual = snapshot.pending[id]; assert.ok(actual, `missing pending projection ${id}`);
        assert.equal(actual.invocationId, id);
        assert.equal(actual.status, p.status); assert.equal(actual.resumeId, p.resumeId); assert.deepEqual(actual.grants, p.grants); checkRequest(actual.request, p);
      }
      assert.deepEqual(Object.keys(snapshot.pending).filter(id => snapshot.pending[id]).sort(), Object.keys(o.pending).sort());
      const events = snapshot.events;
      assert.deepEqual(events.slice(0, previousEvents.length), previousEvents, 'published prefix is immutable');
      if (expected.status === 'committed') {
        assert.ok(expected.invocation && result.events);
        checkEvents(result.events, before, o.state, expected.invocation);
        assert.deepEqual(events.slice(previousEvents.length), result.events, 'atomic publication');
      } else assert.deepEqual(events, previousEvents, 'noncommitting operation must not publish');
      previousEvents = copy(events);
    } catch (error) {
      const actual=observations[index]?.result;
      const detail=error instanceof assert.AssertionError?{expected:error.expected,actual:error.actual}:{};
      return {status:'counterexample', index, command:op, ...(expected===undefined?{}:{expected}), ...(actual===undefined?{}:{actual}), cause:{name:asError(error).name, message:errorMessage(error), ...detail}, failingPrefix:commands.slice(0, index + 1)};
    }
  }
  return {status:'passed', steps:commands.length};
}

const temp = async () => { await mkdir('/tmp/opencode', {recursive:true}); return mkdtemp('/tmp/opencode/v2-generated-'); };
async function durable<T>(path: string, fn: (rt: ReturnType<typeof makeDurableRuntime>, db: import('node:sqlite').DatabaseSync) => Promise<T>) {
  const rt = makeDurableRuntime(inventoryV2Model), db = await run(makeDurableStore(path));
  try { return await fn(rt, db); } finally { await run(closeDurableStore(db)); }
}
async function snapshot(path: string, commands: Operation[]) {
  const ids = [...new Set(commands.flatMap(x => x.api !== 'execute' ? [x.command.invocationId] : x.command.action === 'reservation.reserve' ? [x.command.id] : []))];
  return durable(path, async (rt, db) => ({state:await run(durableState(rt, db)), pending:Object.fromEntries(await Promise.all(ids.map(async id => [id, await run(durablePending(rt, db, id))]))), events:(await run(pullOutbox(db, {limit:1000}))).map(x => x.event)}));
}
async function execute(path: string, op: Operation): Promise<ObservedResult> {
  const api = op.api;
  return durable(path, async (rt, db) => {
    if (op.api === 'execute') return run(durableExecute(rt, db, op.command));
    if (op.api === 'approve') return run(durableApprove(rt, db, op.command, op.host));
    if (op.api === 'resume') return run(durableResume(rt, db, op.command));
    throw new TypeError(`Unknown API ${api}`);
  });
}
async function observe(path: string, commands: Operation[]): Promise<{observations: Observation[]; failure?: Counterexample}> {
  const observations: Observation[] = [];
  try { await durable(path, (rt, db) => run(initializeDurableState(rt, db, initialState))); }
  catch (error) { return {observations, failure:{status:'counterexample', phase:'initialize', cause:{name:asError(error).name, message:errorMessage(error)}, failingPrefix:[]}}; }
  for (const [index,command] of commands.entries()) {
    try {
      const result=copy(await execute(path,command));
      if(result.state===undefined)delete result.state;
      observations.push({result,snapshot:await snapshot(path,commands)});
    }
    catch (error) { return {observations, failure:{status:'counterexample', index, command, cause:{name:asError(error).name, message:errorMessage(error)}, failingPrefix:commands.slice(0, index + 1)}}; }
  }
  return {observations};
}

export function mutationChecks(commands: Operation[], observations: Observation[]) {
  const staleIndex = observations.findIndex(x => x.result.code === 'stale');
  const commitIndex = observations.findIndex(x => x.result.status === 'committed' && x.result.events?.some(e => e['kind'] === 'create'));
  assert.ok(staleIndex >= 0 && commitIndex >= 0, 'mutation fixture requires stale rejection and committed reserve');
  const mutations = {
    bogusStaleCommitDetected: [staleIndex, row => { row.result = {...row.result, status:'committed', events:[]}; }],
    duplicateDecrementDetected: [commitIndex, row => {
      const {state}=row.snapshot,camera=state.records['stock']?.['camera'];
      assert.ok(camera&&row.result.state);
      row.snapshot.state = {...state, records:{...state.records, stock:{...state.records['stock'],
        camera:{...camera, values:{...camera.values, available:count(camera.values['available']) - 1}}}}};
      row.result = {...row.result,state:row.snapshot.state};
    }],
    missingExpectedCommitDetected: [commitIndex, row => { row.result = {status:'rejected', code:'precondition'}; }],
  } satisfies Record<string, [number, (row: Observation) => void]>;
  return Object.fromEntries(Object.entries(mutations).map(([name, [index, mutate]]) => {
    const altered=copy(observations),row=altered[index];
    assert.ok(row,'Missing mutation target');mutate(row);
    const result = checkHistory(commands, altered);
    assert.equal(result.status, 'counterexample', `${name}: checker accepted altered history`);
    assert.equal(result.index, index, `${name}: detection must identify altered step`);
    return [name, {detected:true, index, cause:result.cause}];
  }));
}

export async function runGenerated({reportPath, seed = 0x51a7, runs = 6, steps = 30, histories}: GeneratedOptions = {}) {
  validSeed(seed); positiveInteger(runs, 'runs'); positiveInteger(steps, 'steps');
  const scenarios=histories?.map(history=>({caseSeed:history.seed,history})) ??
    Array.from({length:runs},(_,i)=>({caseSeed:(seed+Math.imul(i,0x9e3779b9))>>>0,history:undefined}));
  const seeds=scenarios.map(({caseSeed})=>caseSeed);
  const root = await temp(), cases: Case[] = [], coverage: Record<string, number> = {}; let mutations: ReturnType<typeof mutationChecks> | undefined;
  for (const [i,{caseSeed,history}] of scenarios.entries()) {
    const commands=history?copy(history.commands??history.failingPrefix):generatedHistory(caseSeed,steps);
    const path = join(root, `seed-${i}.sqlite`), observed = await observe(path, commands);
    const prefixCheck = checkHistory(commands.slice(0, observed.observations.length), observed.observations);
    const checked = prefixCheck.status === 'counterexample' ? prefixCheck : observed.failure ?? prefixCheck;
    const item: Case = {seed:caseSeed, commands, observations:observed.observations, checks:checked.status, restartBoundaries:commands.length + 1};
    if (checked.status === 'counterexample') item.counterexample = checked;
    else {
      let phase = 'replay';
      try {
        // A supplied saved report is also a baseline, not merely a source of commands.
        const baseline=history?.observations;
        if (baseline) {
          for (let index = 0; index < Math.max(baseline.length, observed.observations.length); index++) {
            try { assert.deepEqual(observed.observations[index], baseline[index], 'saved report observations must replay exactly'); }
            catch (error) {
              const command=commands[index];
              item.checks='counterexample';item.counterexample={status:'counterexample',phase:'saved-replay',index,...(command?{command}:{}),cause:{name:asError(error).name,message:errorMessage(error)},failingPrefix:commands.slice(0,index+1)};break;
            }
          }
        }
        const replay = await observe(join(root, `replay-${i}.sqlite`), commands);
        if (replay.failure) { item.checks = 'counterexample'; item.counterexample = {...replay.failure, phase}; }
        else {
          for (const [index,command] of commands.entries()) {
            try { assert.deepEqual(replay.observations[index], observed.observations[index], 'exact fresh DB outcomes, states, pending projections and ordered events'); }
            catch (error) { item.checks = 'counterexample'; item.counterexample = {status:'counterexample', phase, index, command, cause:{name:asError(error).name, message:errorMessage(error)}, failingPrefix:commands.slice(0, index + 1)}; break; }
          }
          const replayCheck = checkHistory(commands, replay.observations);
          if (replayCheck.status !== 'passed' && !item.counterexample) { item.checks = 'counterexample'; item.counterexample = {...replayCheck, phase}; }
        }
        if (!item.counterexample) {
          item.replay = {status:'passed', comparison:'exact outcomes/state/pending/ordered event values at every step; paths and SQLite sequences excluded'};
        }
        phase = 'mutation-sensitivity';
        if (!histories && !mutations) mutations = mutationChecks(commands, observed.observations);
        // Pull retry and acknowledgement stay separate from the replayed domain history.
        phase = 'outbox-pull-ack';
        await durable(path, async (_rt, db) => {
          const first = await run(pullOutbox(db, {limit:2})); assert.deepEqual(await run(pullOutbox(db, {limit:2})), first);
          const [entry]=first;
          if(entry){assert.equal(await run(acknowledgeOutbox(db,entry.sequence)),true);assert.ok(!(await run(pullOutbox(db,{limit:2}))).some(x=>x.sequence===entry.sequence));}
        });
      } catch (error) {
        item.checks = 'counterexample'; item.counterexample = {status:'counterexample', phase, cause:{name:asError(error).name, message:errorMessage(error)}, failingPrefix:commands};
      }
    }
    for (const {result} of observed.observations) { const key = `${result.status}${result.code ? ':' + result.code : ''}`; coverage[key] = (coverage[key] ?? 0) + 1; }
    cases.push(item);
  }
  const status = cases.every(x => x.checks === 'passed') ? 'passed' : 'counterexample';
  const report = {format:'inventory-v2-generated-report/2', execution:'executed', status, seeds, config:{seed, runs:seeds.length, steps}, coverage, cases,
    oracle:{independent:'Inventory/approval state machine predicts status, rejection cause, historical retries, exact domain state, pending/grants/consumption and event differences before checking observations.', mutationChecks:mutations ?? {status:'not-run-for-replay-or-failed-history'}},
    replay:{status:status === 'passed' ? 'passed' : 'not-all-passed'},
    reproduction:{command:`node inventory/v2/generated.ts --replay ${encodeJson(reportPath ?? 'REPORT.json')} --report /tmp/opencode/durable-replayed.json`, input:'cases[].commands (full API arguments, operation/request references, host identities and clocks); substitute counterexample.failingPrefix to replay only that prefix'},
    shrink:{status:'not-implemented', method:'first failing checked prefix, not a minimal counterexample or automatic shrink'},
    scope:'Bounded seeded real-SQLite execution and handle reopen; not exhaustive, a proof, process-crash/power-loss certification, authentication or external delivery evidence.'};
  if (reportPath) { await mkdir(dirname(reportPath), {recursive:true}); await writeFile(reportPath, encodeJsonPretty(report) + '\n'); }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options: GeneratedOptions = {}; let replay;
  function argValue(index:number):string {
    const value=args[index];
    if(value===undefined)throw new TypeError(`Missing value for ${args[index-1]}`);
    return value;
  }
  for (let i = 0; i < args.length; i++) {
    const arg=argValue(i);
    if (arg === '--seed') options.seed = Number(args[++i]);
    else if (arg === '--runs') options.runs = Number(args[++i]);
    else if (arg === '--steps') options.steps = Number(args[++i]);
    else if (arg === '--report') options.reportPath = resolve(argValue(++i));
    else if (arg === '--replay') replay = args[++i];
    else if (!arg.startsWith('-') && !options.reportPath) options.reportPath = resolve(arg);
    else throw new TypeError(`Unknown option ${arg}`);
  }
  options.reportPath ??= resolve('artifacts/durable-generated-report.json');
  if (replay) {
    const input = decodeJsonObject(await readFile(replay, 'utf8'));
    const cases = input['cases'] ?? [input];
    if (!Array.isArray(cases)) throw new TypeError('Expected replay cases');
    options.histories = cases.map(replayHistory);
  }
  const report = await runGenerated(options);
  process.stdout.write(`${encodeJsonPretty({report:options.reportPath, status:report.status, seeds:report.seeds, coverage:report.coverage, cases:report.cases.length, counterexamples:report.cases.filter(x => x.counterexample).map(x => ({seed:x.seed, ...x.counterexample}))})}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}
