import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as Effect from 'effect/Effect';
import { issueModel, issueState } from '../../semantic/issues.ts';
import { inventoryModel } from '../../inventory/model.ts';
import { makeDurableRuntime, makeDurableStore, initializeDurableState, durableExecute, durableState, pullOutbox, acknowledgeOutbox, closeDurableStore, DurableStore, durableStoreLayer } from './durable.ts';

const invoke = (id, args = { issueId: 'i1' }) => ({ id, action: 'issue.resolve', args, actor: 'maya', clock: 1730000000000 });
const run = Effect.runPromise;
const temp = () => mkdtempSync(join(tmpdir(), 'effect-durable-'));
const worker = new URL('./durable-worker.ts', import.meta.url).pathname;
const child = (path: string, mode: string, id?: string) => spawnSync(process.execPath, [worker, path, mode, ...(id===undefined?[]:[id])], { encoding: 'utf8' });

test('durable store layer supplies a SQLite handle and closes it when its scope ends', async t => {
  const dir = temp(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = await run(Effect.provide(DurableStore, durableStoreLayer(join(dir, 'layer.sqlite'))));
  assert.throws(() => db.prepare('SELECT 1'), /not open/i);
});

test('restart keeps outcomes and immutable command identity', async t => {
  const dir = temp(), path = join(dir, 'store.sqlite'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let db = await run(makeDurableStore(path)), runtime = makeDurableRuntime(issueModel);
  await run(initializeDurableState(runtime, db, issueState));
  const source = invoke('durable1');
  assert.equal((await run(durableExecute(runtime, db, source))).status, 'committed');
  source.args.issueId = 'mutated';
  await run(closeDurableStore(db));
  db = await run(makeDurableStore(path));
  const replay = await run(durableExecute(runtime, db, invoke('durable1')));
  assert.equal(replay.status, 'duplicate'); assert.equal(replay.result.status, 'committed');
  const reordered = { clock: 1730000000000, actor: 'maya', args: { issueId: 'i1' }, action: 'issue.resolve', id: 'durable1' };
  assert.equal((await run(durableExecute(runtime, db, reordered))).status, 'duplicate');
  assert.equal((await run(durableExecute(runtime, db, invoke('durable1', { issueId: 'i2' })))).code, 'invocation-conflict');
  await run(closeDurableStore(db));
});

test('pending and rejected outcomes reserve IDs; changed model/input conflicts after reopen', async t => {
  const dir = temp(), path = join(dir, 'store.sqlite'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = await run(makeDurableStore(path)), rt = makeDurableRuntime(issueModel);
  const pendingModel = structuredClone(issueModel); pendingModel.actions['issue.resolve'].policies[0].effect = 'approval-required';
  const pendingRuntime = makeDurableRuntime(pendingModel);
  await run(initializeDurableState(pendingRuntime, db, issueState));
  const p = await run(durableExecute(pendingRuntime, db, invoke('p')));
  assert.equal(p.status, 'pending');
  assert.equal((await run(durableExecute(rt, db, invoke('p')))).code, 'invocation-conflict');
  const denied = await run(durableExecute(pendingRuntime, db, invoke('bad', { issueId: 'missing' })));
  assert.equal(denied.status, 'rejected');
  assert.equal((await run(durableExecute(pendingRuntime, db, invoke('bad')))).code, 'invocation-conflict');
  await run(closeDurableStore(db));
});

test('failure injection rolls back state, ledger, and outbox in one transaction', async t => {
  const dir = temp(), path = join(dir, 'store.sqlite'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = await run(makeDurableStore(path)), rt = makeDurableRuntime(issueModel);
  await run(initializeDurableState(rt, db, issueState));
  await assert.rejects(run(durableExecute(rt, db, invoke('rollback'), { beforeCommit: () => { throw Error('injected'); } })));
  assert.deepEqual(await run(durableState(rt, db)), issueState);
  assert.equal((await run(pullOutbox(db))).length, 0);
  assert.equal((await run(durableExecute(rt, db, invoke('rollback')))).status, 'committed');
  await run(closeDurableStore(db));
});

test('outbox pull is ordered and ack is explicit at-least-once', async t => {
  const dir = temp(), path = join(dir, 'store.sqlite'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = await run(makeDurableStore(path)), rt = makeDurableRuntime(issueModel);
  await run(initializeDurableState(rt, db, issueState)); await run(durableExecute(rt, db, invoke('outbox')));
  const first = await run(pullOutbox(db)); assert.ok(first.length > 0);
  assert.deepEqual(await run(pullOutbox(db)), first);
  assert.equal(await run(acknowledgeOutbox(db, first[0].sequence)), true);
  await run(closeDurableStore(db));
});

test('separate processes serialize contenders against one SQLite state', async t => {
  const dir = temp(), path = join(dir, 'store.sqlite'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(child(path, 'init').status, 0);
  const outcomes = await Promise.all(['a', 'b'].map(id => new Promise<ReturnType<typeof child>>(resolve => {
    const p = spawnSync(process.execPath, [worker, path, 'execute', id], { encoding: 'utf8' }); resolve(p);
  })));
  assert.ok(outcomes.every(x => x.status === 0), outcomes.map(x => x.stderr).join('\n'));
  const db = await run(makeDurableStore(path));
  const state = await run(durableState(makeDurableRuntime(issueModel), db));
  assert.equal(state.records.issues.i1.values.status, 'resolved');
  assert.equal((await run(pullOutbox(db))).length, 4);
  await run(closeDurableStore(db));
});

test('two processes competing to reserve 3 from stock 5 admit only one', async t => {
  const dir = temp(), path = join(dir, 'stock.sqlite'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(child(path, 'init-stock').status, 0);
  const contenders = ['stock-a', 'stock-b'].map(id => spawnSync(process.execPath, [worker, path, 'stock', id], { encoding: 'utf8' }));
  assert.ok(contenders.every(x => x.status === 0), contenders.map(x => x.stderr).join('\n'));
  assert.equal(contenders[0].stdout.trim(), 'committed:');
  const db = await run(makeDurableStore(path)), rt = makeDurableRuntime(inventoryModel);
  const state = await run(durableState(rt, db));
  assert.equal(state.records.stock.camera.values.available, 2, JSON.stringify(contenders.map(x => ({ status: x.status, stdout: x.stdout, stderr: x.stderr }))));
  assert.equal(Object.values(state.records.reservation).filter(x => x.values.status === 'active').length, 1);
  assert.equal((await run(pullOutbox(db))).length, 5);
  await run(closeDurableStore(db));
});

test('process death before commit rolls back; death after commit survives restart', async t => {
  const dir = temp(), path = join(dir, 'store.sqlite'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(child(path, 'init').status, 0);
  const killed = child(path, 'crash-before');
  assert.equal(killed.signal, 'SIGKILL');
  let db = await run(makeDurableStore(path)), rt = makeDurableRuntime(issueModel);
  assert.deepEqual(await run(durableState(rt, db)), issueState);
  await run(closeDurableStore(db));
  assert.equal(child(path, 'crash-after', 'after-crash').status, 0);
  db = await run(makeDurableStore(path));
  assert.equal((await run(durableExecute(rt, db, invoke('after-crash')))).status, 'duplicate');
  assert.equal((await run(pullOutbox(db))).length, 4);
  await run(closeDurableStore(db));
});

test('malformed persisted JSON fails closed on recovery', async t => {
  const dir = temp(), path = join(dir, 'store.sqlite'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = await run(makeDurableStore(path)), rt = makeDurableRuntime(issueModel);
  await run(initializeDurableState(rt, db, issueState));
  db.prepare("UPDATE durable_meta SET value='{' WHERE key='state_json'").run();
  await assert.rejects(run(durableState(rt, db)));
  await run(closeDurableStore(db));
});
