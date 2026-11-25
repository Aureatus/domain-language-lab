import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {makeDurableRuntime, makeDurableStore, initializeDurableState, durableExecute,
  durableApprove, durableResume, durablePending, durableState, pullOutbox, closeDurableStore} from '../../adapters/effect/durable.mjs';
import {encodeJsonPretty} from '../../adapters/effect/json.mjs';
import {inventoryV2Model, initialState, invocation} from './model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Effect is intentionally installed in the adapter package, not at repository root.
const adapterRequire = createRequire(new URL('../../adapters/effect/package.json', import.meta.url));
const Effect = await import(adapterRequire.resolve('effect/Effect'));
const run = Effect.runPromise;
export const durableApprovalFixture = Object.freeze({
  modelId: 'inventory.v2', initialRevision: 0,
  invocation: invocation('durable-reserve-1', 'reserve', {reservationId: 'durable-reservation', clock: 100, quantity: 3, expiresAt: 200}),
  policyId: 'reserve.warehouse-approval', approver: 'warehouse', resumeClock: 101,
});

/** One open/close lifetime; also usable from a fresh child process. No direct state/ledger writes. */
export async function runDurablePhase(databasePath, scenario, phase) {
  if (!['lifecycle', 'stale', 'expired'].includes(scenario)) throw new Error('Unknown scenario');
  const runtime = makeDurableRuntime(inventoryV2Model);
  const db = await run(makeDurableStore(databasePath));
  const command = durableApprovalFixture.invocation;
  const resume = {id: 'resume-1', invocationId: command.id, clock: scenario === 'expired' ? 200 : 101};
  const snapshot = async () => ({state: await run(durableState(runtime, db)),
    outbox: await run(pullOutbox(db)), pending: await run(durablePending(runtime, db, command.id))});
  try {
    if (phase === 'start') await run(initializeDurableState(runtime, db, initialState));
    const before = await snapshot();
    const results = [];
    if (phase === 'start') results.push(await run(durableExecute(runtime, db, command)));
    else if (phase === 'grant') results.push(await run(durableApprove(runtime, db,
      {id: 'grant-1', invocationId: command.id, policyId: durableApprovalFixture.policyId},
      {authenticatedApprover: durableApprovalFixture.approver})));
    else if (phase === 'intervene') results.push(await run(durableExecute(runtime, db,
      invocation('small-reserve', 'reserve', {reservationId: 'small-reservation', actor: 'bob', quantity: 1, clock: 100, expiresAt: 200}))));
    else if (phase === 'resume') results.push(await run(durableResume(runtime, db, resume)));
    else if (phase === 'retry') {
      results.push(await run(durableResume(runtime, db, resume)));
      results.push(await run(durableExecute(runtime, db, command)));
      results.push(await run(durableResume(runtime, db, {...resume, id: 'resume-again'})));
    } else if (phase === 'finish') {
      results.push(await run(durableExecute(runtime, db, invocation('cancel-1', 'cancel', {reservationId: 'durable-reservation', clock: 102}))));
      results.push(await run(durableExecute(runtime, db, invocation('delete-1', 'delete-terminal', {reservationId: 'durable-reservation', clock: 103}))));
    } else throw new Error('Unknown phase');
    return {scenario, phase, databasePath, before, results, after: await snapshot()};
  } finally { await run(closeDurableStore(db)); }
}

export async function runDurableDemo() {
  await mkdir('/tmp/opencode', {recursive: true});
  // Exclusive fresh directory on every run: never remove or overwrite a user's database.
  const directory = await mkdtemp('/tmp/opencode/inventory-v2-demo-');
  const scenarios = [];
  for (const scenario of ['lifecycle', 'stale', 'expired']) {
    const databasePath = resolve(directory, `${scenario}.sqlite`);
    const phases = ['start', 'grant', ...(scenario === 'stale' ? ['intervene'] : []), 'resume',
      ...(scenario === 'lifecycle' ? ['retry', 'finish'] : [])];
    const steps = [];
    for (const phase of phases) steps.push(await runDurablePhase(databasePath, scenario, phase));
    const start = steps[0], grant = steps[1], resumed = steps.find(x => x.phase === 'resume');
    assert.equal(start.results[0].status, 'pending');
    assert.deepEqual(start.after.state, initialState);
    assert.deepEqual(start.after.outbox, []);
    assert.equal(grant.results[0].status, 'approved');
    assert.equal(resumed.before.pending.grants[0].approver, 'warehouse');
    if (scenario === 'lifecycle') {
      assert.equal(resumed.results[0].status, 'committed');
      assert.equal(resumed.after.state.records.stock.camera.values.available, 8 - 3);
      assert.deepEqual(Object.keys(resumed.after.state.records.reservation), ['durable-reservation']);
      assert.deepEqual(resumed.after.outbox.map(x => x.event.kind), ['action', 'change', 'create']);
      assert.ok(resumed.after.outbox.every(x => x.event.clock === 101));
      assert.equal(resumed.after.pending.status, 'consumed');
      const retry = steps.find(x => x.phase === 'retry');
      assert.deepEqual(retry.results.map(x => x.status), ['duplicate', 'duplicate', 'rejected']);
      assert.equal(retry.results[2].code, 'consumed');
      assert.deepEqual(retry.after, retry.before);
      const finish = steps.at(-1);
      assert.deepEqual(finish.results.map(x => x.status), ['committed', 'committed']);
      assert.equal(finish.after.state.records.stock.camera.values.available, 8);
      assert.deepEqual(finish.after.state.records.reservation, {});
    } else {
      assert.equal(resumed.results[0].status, 'rejected');
      assert.equal(resumed.results[0].code, scenario === 'stale' ? 'stale' : 'precondition');
      assert.deepEqual(resumed.after, resumed.before);
      if (scenario === 'stale') {
        assert.equal(steps[2].results[0].status, 'committed');
        assert.equal(resumed.after.state.records.stock.camera.values.available, 8 - 1);
      }
    }
    scenarios.push({scenario, databasePath, steps, checks: 'passed'});
  }
  return {format: 'inventory-v2-execution-report/2', modelId: inventoryV2Model.id, execution: 'executed',
    runtime: {node: process.version, effect: adapterRequire('effect/package.json').version, storage: 'node:sqlite DatabaseSync'},
    scope: 'Actual SQLite inventory API executions; each phase closes and reopens the database. Explicit deterministic host identities/clocks; not authentication, power-loss, concurrent-writer or delivery certification. Separate-process recovery is tested in inventory/v2/durable.test.mjs, not asserted by this demo.',
    paths: {model: 'inventory/v2/model.mjs', adapter: 'adapters/effect/durable.mjs', tests: 'inventory/v2/durable.test.mjs', contract: 'docs/durable-execution.md', databaseDirectory: directory},
    durableApprovalIntegration: {status: 'executed'}, scenarios};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runDurableDemo();
  const target = resolve(process.argv[2] ?? resolve(here, '../../artifacts/inventory-v2-report.json'));
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, `${encodeJsonPretty(report)}\n`);
  process.stdout.write(`${encodeJsonPretty({report: target, execution: report.execution,
    scenarios: report.scenarios.map(({scenario, checks, databasePath}) => ({scenario, checks, databasePath}))})}\n`);
}
