import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {makeDurableRuntime, makeDurableStore, initializeDurableState, durableExecute, durableApprove, durableResume, durablePending, durableState, pullOutbox, acknowledgeOutbox, closeDurableStore} from '../../adapters/effect/durable.mjs';
import {decodeJsonObject, decodeJsonValue, encodeJson, encodeJsonPretty, encodeCanonicalJson as canonical} from '../../adapters/effect/json.mjs';
import {inventoryV2Model, initialState, invocation} from './model.mjs';

const require = createRequire(new URL('../../adapters/effect/package.json', import.meta.url));
const Effect = await import(require.resolve('effect/Effect'));
const run = Effect.runPromise;
const copy = x => decodeJsonValue(encodeJson(x));
const policyId = 'reserve.warehouse-approval';
const rng = seed => { let x = seed >>> 0; return () => { x = (x + 0x6d2b79f5) | 0; let t = Math.imul(x ^ x >>> 15, 1 | x); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 0x100000000; }; };
const positiveInteger = (n, name) => { if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`${name} must be a positive safe integer`); return n; };
const validSeed = n => { if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new TypeError('seed must be a uint32'); return n; };

// Randomized block order, identities, IDs, quantities and clock offsets. Each block
// restores capacity; pending requests remain, making later full-state freshness real.
export function generatedHistory(seed, steps = 30) {
  validSeed(seed); positiveInteger(steps, 'steps');
  if (steps < 30) throw new RangeError('steps must be at least 30 for guaranteed boundary coverage');
  const random = rng(seed), pick = xs => xs[Math.floor(random() * xs.length)];
  const owner = () => pick(['alice', 'bob', 'carol']);
  const prefix = `s${seed.toString(16)}`, blocks = []; let serial = 0;
  const id = label => `${prefix}-${label}-${serial++}`;
  const action = (kind, reservationId, actor, clock, quantity = 1, expiresAt = clock + 20) => ({api:'execute', command:invocation(id(kind), kind, {reservationId, actor, clock, quantity, expiresAt})});
  const reserve = (label, actor, clock, quantity = 1, expiresAt = clock + 20) => action('reserve', id(label), actor, clock, quantity, expiresAt);
  const grant = (op, actor = 'warehouse') => ({api:'approve', command:{id:id('grant'), invocationId:op.command.id, policyId}, host:{authenticatedApprover:actor}});
  const resume = (op, clock) => ({api:'resume', command:{id:id('resume'), invocationId:op.command.id, clock}});
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
  for (let i = blocks.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; }
  const ops = blocks.flat(), t = clock();
  ops.push(reserve('invalid-expiry', owner(), t, 1, t));
  const conflict = copy(ops.find(x => x.api === 'execute')); conflict.command.actor = 'intruder'; ops.push(conflict);
  // Optional extra commands explore capacity, existing IDs, absent records and denials.
  while (ops.length < steps) {
    const previous = pick(ops.filter(x => x.api === 'execute')), kind = pick(['reserve', 'cancel', 'expire', 'delete-terminal']), now = clock();
    ops.push(action(kind, pick([previous.command.args.reservationId, id('extra')]), pick(['alice', 'bob', 'carol', 'warehouse']), now, pick([1, 2, 3, 8, 9]), now + pick([0, 1, 20])));
  }
  return ops;
}

// An inventory-specific state machine. No execute/prepare/approve/resume calls,
// declaration traversal, or observed-success-driven oracle updates are used here.
function oracle() { return {state:copy(initialState), pending:{}, ledger:new Map()}; }
const reject = code => ({status:'rejected', code});
function reserveValidity(state, inv) {
  const a = inv.args;
  if (a.quantity > state.records.stock.camera.values.available || inv.clock >= a.expiresAt) return 'precondition';
  return null;
}
function predict(o, op) {
  const c = op.command, previous = o.ledger.get(c.id);
  if (previous) return canonical(previous.op) === canonical(op) ? {status:'duplicate', result:previous.expected} : reject('invocation-conflict');
  let expected, inv;
  if (op.api === 'execute') {
    inv = c;
    const kind = c.action.split('.').at(-1), r = o.state.records.reservation[c.args.reservationId];
    if (kind === 'reserve') {
      const invalid = reserveValidity(o.state, c);
      if (invalid) expected = reject(invalid);
      else if (c.args.quantity >= 3) {
        expected = {status:'pending'};
        o.pending[c.id] = {invocation:copy(c), prestate:copy(o.state), grants:[], status:'pending', resumeId:null};
      } else if (r) expected = reject('existing-record');
      else expected = {status:'committed'};
    } else if (!r) expected = reject('missing-record');
    else if (c.actor !== (kind === 'expire' ? 'warehouse' : r.values.owner)) expected = reject('denied');
    else if (kind === 'delete-terminal' ? r.values.status === 'active' : r.values.status !== 'active' || kind === 'expire' && c.clock < r.values.expiresAt) expected = reject('precondition');
    else expected = {status:'committed'};
  } else {
    const p = o.pending[c.invocationId];
    if (!p) expected = reject('missing-request');
    else if (p.status === 'consumed') expected = reject('consumed');
    else if (op.api === 'approve') {
      if (p.grants.length) expected = reject('already-granted');
      else if (c.policyId !== policyId || op.host.authenticatedApprover !== 'warehouse' || p.invocation.actor === 'warehouse') expected = reject('unauthorized-approval');
      else { expected = {status:'approved'}; p.grants.push({policyId, approver:'warehouse'}); }
    } else {
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
    const kind = inv.action.split('.').at(-1), a = inv.args, stock = o.state.records.stock.camera, records = o.state.records.reservation;
    if (kind === 'reserve') { stock.values.available -= a.quantity; stock.version++; records[a.reservationId] = {version:0, values:{stockId:'camera', owner:inv.actor, quantity:a.quantity, expiresAt:a.expiresAt, status:'active'}}; }
    else if (kind === 'delete-terminal') delete records[a.reservationId];
    else { stock.values.available += records[a.reservationId].values.quantity; stock.version++; records[a.reservationId].version++; records[a.reservationId].values.status = kind === 'cancel' ? 'cancelled' : 'expired'; }
    o.state.revision++;
    expected.invocation = copy(inv);
  }
  // Store independent historical state, not the current state at retry time.
  if (op.api === 'execute' || op.api === 'resume' && !['missing-request', 'consumed'].includes(expected.code)) expected.state = copy(o.state);
  o.ledger.set(c.id, {op:copy(op), expected:copy(expected)});
  return expected;
}

function checkOutcome(actual, expected, o, op) {
  assert.equal(actual.status, expected.status, `expected ${expected.status}, received ${actual.status} for ${op.api} ${op.command.id}`);
  if (expected.code) assert.equal(actual.code, expected.code, 'rejection cause');
  if (expected.status === 'duplicate') return checkOutcome(actual.result, expected.result, o, o.ledger.get(op.command.id).op);
  if (expected.state) assert.deepEqual(actual.state, expected.state, 'returned domain state');
  if (expected.status === 'pending') {
    assert.deepEqual(actual.policyIds, [policyId]);
    checkRequest(actual.request, o.pending[op.command.id]);
  }
  if (expected.status === 'approved') {
    assert.equal(actual.receipt.policyId, policyId); assert.equal(actual.receipt.approver, 'warehouse');
    checkRequest(actual.receipt.request, o.pending[op.command.invocationId]);
  }
}
function checkRequest(actual, p) {
  assert.equal(actual.format, 'semantic-approval-request/v2');
  assert.deepEqual(actual.model, inventoryV2Model, 'request model binding');
  assert.deepEqual(actual.invocation, p.invocation); assert.deepEqual(actual.prestate, p.prestate);
  assert.deepEqual(actual.requirements, [{policyId, approvers:p.invocation.actor === 'warehouse' ? [] : ['warehouse'], allowSelfApproval:false}]);
}
function checkEvents(events, before, after, inv) {
  // Check publication against independently predicted record differences, not deltas
  // returned by the interpreter. Routing contents are additionally covered by replay.
  const changes = [];
  for (const resource of ['stock', 'reservation']) {
    const a = before.records[resource], b = after.records[resource];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!a[key]) changes.push({kind:'create', resource, key, after:b[key]});
      else if (!b[key]) changes.push({kind:'delete', resource, key, before:a[key]});
      else for (const field of Object.keys(a[key].values)) if (canonical(a[key].values[field]) !== canonical(b[key].values[field])) changes.push({kind:'change', resource, key, field, before:a[key].values[field], after:b[key].values[field]});
    }
  }
  assert.equal(events.length, changes.length + 1, 'one action and exactly the predicted record changes');
  assert.equal(events[0].kind, 'action');
  const projection = e => Object.fromEntries(['kind', 'resource', 'key', 'field', 'before', 'after'].filter(k => Object.hasOwn(e, k)).map(k => [k, e[k]]));
  assert.deepEqual(events.slice(1).map(projection).sort((a,b) => canonical(a).localeCompare(canonical(b))), changes.sort((a,b) => canonical(a).localeCompare(canonical(b))));
  for (const event of events) {
    assert.equal(event.invocationId, inv.id); assert.equal(event.actionId, inv.action); assert.equal(event.actor, inv.actor); assert.equal(event.clock, inv.clock); assert.equal(event.revision, after.revision);
  }
  assert.equal(new Set(events.map(e => e.id)).size, events.length);
}

// Also used unchanged for all observation mutations. Mutators never touch oracle
// predictions, generated commands, or the actual database.
export function checkHistory(commands, observations) {
  const o = oracle(); let previousEvents = [];
  for (let index = 0; index < commands.length; index++) {
    const op = commands[index]; let expected;
    try {
      const before = copy(o.state); expected = predict(o, op);
      const {result, snapshot} = observations[index];
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
        checkEvents(result.events, before, o.state, expected.invocation);
        assert.deepEqual(events.slice(previousEvents.length), result.events, 'atomic publication');
      } else assert.deepEqual(events, previousEvents, 'noncommitting operation must not publish');
      previousEvents = copy(events);
    } catch (error) {
      return {status:'counterexample', index, command:op, expected, actual:observations[index]?.result, cause:{name:error.name, message:error.message, expected:error.expected, actual:error.actual}, failingPrefix:commands.slice(0, index + 1)};
    }
  }
  return {status:'passed', steps:commands.length};
}

const temp = async () => { await mkdir('/tmp/opencode', {recursive:true}); return mkdtemp('/tmp/opencode/v2-generated-'); };
async function durable(path, fn) {
  const rt = makeDurableRuntime(inventoryV2Model), db = await run(makeDurableStore(path));
  try { return await fn(rt, db); } finally { await run(closeDurableStore(db)); }
}
async function snapshot(path, commands) {
  const ids = [...new Set(commands.flatMap(x => x.api !== 'execute' ? [x.command.invocationId] : x.command.action === 'reservation.reserve' ? [x.command.id] : []))];
  return durable(path, async (rt, db) => ({state:await run(durableState(rt, db)), pending:Object.fromEntries(await Promise.all(ids.map(async id => [id, await run(durablePending(rt, db, id))]))), events:(await run(pullOutbox(db, {limit:1000}))).map(x => x.event)}));
}
async function execute(path, op) {
  return durable(path, (rt, db) => {
    if (op.api === 'execute') return run(durableExecute(rt, db, op.command));
    if (op.api === 'approve') return run(durableApprove(rt, db, op.command, op.host));
    if (op.api === 'resume') return run(durableResume(rt, db, op.command));
    throw new TypeError(`Unknown API ${op.api}`);
  });
}
async function observe(path, commands) {
  const observations = [];
  try { await durable(path, (rt, db) => run(initializeDurableState(rt, db, initialState))); }
  catch (error) { return {observations, failure:{status:'counterexample', phase:'initialize', cause:{name:error.name, message:error.message}, failingPrefix:[]}}; }
  for (let index = 0; index < commands.length; index++) {
    // The replay contract is JSON data. Optional undefined JS properties (for
    // example conflict.state) cannot survive report serialization.
    try { observations.push({result:copy(await execute(path, commands[index])), snapshot:await snapshot(path, commands)}); }
    catch (error) { return {observations, failure:{status:'counterexample', index, command:commands[index], cause:{name:error.name, message:error.message}, failingPrefix:commands.slice(0, index + 1)}}; }
  }
  return {observations};
}

export function mutationChecks(commands, observations) {
  const staleIndex = observations.findIndex(x => x.result.code === 'stale');
  const commitIndex = observations.findIndex(x => x.result.status === 'committed' && x.result.events.some(e => e.kind === 'create'));
  assert.ok(staleIndex >= 0 && commitIndex >= 0, 'mutation fixture requires stale rejection and committed reserve');
  const mutations = {
    bogusStaleCommitDetected: [staleIndex, row => { row.result = {...row.result, status:'committed', events:[]}; }],
    duplicateDecrementDetected: [commitIndex, row => { row.snapshot.state.records.stock.camera.values.available--; row.result.state.records.stock.camera.values.available--; }],
    missingExpectedCommitDetected: [commitIndex, row => { row.result = {status:'rejected', code:'precondition'}; }],
  };
  return Object.fromEntries(Object.entries(mutations).map(([name, [index, mutate]]) => {
    const altered = copy(observations); mutate(altered[index]);
    const result = checkHistory(commands, altered);
    assert.equal(result.status, 'counterexample', `${name}: checker accepted altered history`);
    assert.equal(result.index, index, `${name}: detection must identify altered step`);
    return [name, {detected:true, index, cause:result.cause}];
  }));
}

export async function runGenerated({reportPath, seed = 0x51a7, runs = 6, steps = 30, histories} = {}) {
  validSeed(seed); positiveInteger(runs, 'runs'); positiveInteger(steps, 'steps');
  const seeds = histories ? histories.map(x => x.seed) : Array.from({length:runs}, (_, i) => (seed + Math.imul(i, 0x9e3779b9)) >>> 0);
  const root = await temp(), cases = [], coverage = {}; let mutations;
  for (const [i, caseSeed] of seeds.entries()) {
    const commands = histories ? copy(histories[i].commands ?? histories[i].failingPrefix) : generatedHistory(caseSeed, steps);
    const path = join(root, `seed-${i}.sqlite`), observed = await observe(path, commands);
    const prefixCheck = checkHistory(commands.slice(0, observed.observations.length), observed.observations);
    const checked = prefixCheck.status === 'counterexample' ? prefixCheck : observed.failure ?? prefixCheck;
    const item = {seed:caseSeed, commands, observations:observed.observations, checks:checked.status, restartBoundaries:commands.length + 1};
    if (checked.status === 'counterexample') item.counterexample = checked;
    else {
      let phase = 'replay';
      try {
        // A supplied saved report is also a baseline, not merely a source of commands.
        const baseline = histories?.[i].observations;
        if (baseline) {
          for (let index = 0; index < Math.max(baseline.length, observed.observations.length); index++) {
            try { assert.deepEqual(observed.observations[index], baseline[index], 'saved report observations must replay exactly'); }
            catch (error) { item.checks = 'counterexample'; item.counterexample = {status:'counterexample', phase:'saved-replay', index, command:commands[index], cause:{name:error.name, message:error.message}, failingPrefix:commands.slice(0, index + 1)}; break; }
          }
        }
        const replay = await observe(join(root, `replay-${i}.sqlite`), commands);
        if (replay.failure) { item.checks = 'counterexample'; item.counterexample = {...replay.failure, phase}; }
        else {
          for (let index = 0; index < commands.length; index++) {
            try { assert.deepEqual(replay.observations[index], observed.observations[index], 'exact fresh DB outcomes, states, pending projections and ordered events'); }
            catch (error) { item.checks = 'counterexample'; item.counterexample = {status:'counterexample', phase, index, command:commands[index], cause:{name:error.name, message:error.message}, failingPrefix:commands.slice(0, index + 1)}; break; }
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
          if (first.length) { assert.equal(await run(acknowledgeOutbox(db, first[0].sequence)), true); assert.ok(!(await run(pullOutbox(db, {limit:2}))).some(x => x.sequence === first[0].sequence)); }
        });
      } catch (error) {
        item.checks = 'counterexample'; item.counterexample = {status:'counterexample', phase, cause:{name:error.name, message:error.message}, failingPrefix:commands};
      }
    }
    for (const {result} of observed.observations) { const key = `${result.status}${result.code ? ':' + result.code : ''}`; coverage[key] = (coverage[key] ?? 0) + 1; }
    cases.push(item);
  }
  const status = cases.every(x => x.checks === 'passed') ? 'passed' : 'counterexample';
  const report = {format:'inventory-v2-generated-report/2', execution:'executed', status, seeds, config:{seed, runs:seeds.length, steps}, coverage, cases,
    oracle:{independent:'Inventory/approval state machine predicts status, rejection cause, historical retries, exact domain state, pending/grants/consumption and event differences before checking observations.', mutationChecks:mutations ?? {status:'not-run-for-replay-or-failed-history'}},
    replay:{status:status === 'passed' ? 'passed' : 'not-all-passed'},
    reproduction:{command:`node inventory/v2/generated.mjs --replay ${encodeJson(reportPath ?? 'REPORT.json')} --report /tmp/opencode/durable-replayed.json`, input:'cases[].commands (full API arguments, operation/request references, host identities and clocks); substitute counterexample.failingPrefix to replay only that prefix'},
    shrink:{status:'not-implemented', method:'first failing checked prefix, not a minimal counterexample or automatic shrink'},
    scope:'Bounded seeded real-SQLite execution and handle reopen; not exhaustive, a proof, process-crash/power-loss certification, authentication or external delivery evidence.'};
  if (reportPath) { await mkdir(dirname(reportPath), {recursive:true}); await writeFile(reportPath, encodeJsonPretty(report) + '\n'); }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {}; let replay;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--seed' || arg === '--runs' || arg === '--steps') options[arg.slice(2)] = Number(args[++i]);
    else if (arg === '--report') options.reportPath = resolve(args[++i]);
    else if (arg === '--replay') replay = args[++i];
    else if (!arg.startsWith('-') && !options.reportPath) options.reportPath = resolve(arg);
    else throw new TypeError(`Unknown option ${arg}`);
  }
  options.reportPath ??= resolve('artifacts/durable-generated-report.json');
  if (replay) { const input = decodeJsonObject(await readFile(replay, 'utf8')); options.histories = input.cases ?? [input]; }
  const report = await runGenerated(options);
  process.stdout.write(`${encodeJsonPretty({report:options.reportPath, status:report.status, seeds:report.seeds, coverage:report.coverage, cases:report.cases.length, counterexamples:report.cases.filter(x => x.counterexample).map(x => ({seed:x.seed, ...x.counterexample}))})}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}
