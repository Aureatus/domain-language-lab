import test from 'node:test';
import assert from 'node:assert/strict';
// Resolve the adapter-owned dependency without adding a root dependency.
import * as SynchronizedRef from '../adapters/effect/node_modules/effect/dist/SynchronizedRef.js';
import {Effect, execute, makeStore} from '../adapters/effect/index.ts';
import type {Event, State} from '../semantic/types.ts';
import {runtime, initialState, invocation} from './model.ts';

const run = Effect.runPromise;
const stock = (state: State) => {
  const available = state.records['stock']['camera'].values['available'];
  assert.ok(typeof available === 'number');
  return available;
};

test('actual inventory reserve/cancel/expire match interpreter state and routed events', async () => {
  const store = await run(makeStore(initialState));
  let state = initialState;
  const events: Event[] = [];
  const calls = [invocation('reserveA', 'reserve'), invocation('cancelA', 'cancel'),
    invocation('reserveB', 'reserve', 'slotB', 'bob', 10, 2, 30),
    invocation('early', 'expire', 'slotB', 'warehouse', 29),
    invocation('expireB', 'expire', 'slotB', 'warehouse', 30)];
  for (const [i, call] of calls.entries()) {
    const expected = runtime.execute(state, call);
    const actual = await run(execute(runtime, store, call));
    assert.deepEqual(actual, expected);
    if (actual.status === 'committed') { state = actual.state; events.push(...actual.events); }
    const published = await run(SynchronizedRef.get(store));
    assert.deepEqual(published.state, state); assert.deepEqual(published.events, events);
    assert.equal(stock(state), [2, 5, 3, 3, 5][i]);
    assert.equal(actual.status, i === 3 ? 'rejected' : 'committed');
    if (i === 3) { assert.equal(actual.status, 'rejected'); assert.equal(actual.code, 'precondition'); }
  }
  assert.equal(state.records['reservation']['slotA'].values['status'], 'cancelled');
  assert.equal(state.records['reservation']['slotB'].values['status'], 'expired');
  assert.equal(state.revision, 4);
  assert.ok(events.some(e => e.recipients.some(r => r.recipient === 'warehouse')));
});

test('competing reservation fibers satisfy independent capacity oracle in either order', async () => {
  for (const reverse of [false, true]) {
    const store = await run(makeStore(initialState));
    const calls = [invocation('raceA', 'reserve'), invocation('raceB', 'reserve', 'slotB', 'bob')];
    if (reverse) calls.reverse();
    const outcomes = await run(Effect.all(calls.map(call => execute(runtime, store, call)), {concurrency: 'unbounded'}));
    assert.equal(outcomes.filter(r => r.status === 'committed').length, 1);
    assert.equal(outcomes.filter(r => r.status === 'rejected' && r.code === 'precondition').length, 1);
    const published = await run(SynchronizedRef.get(store));
    const winner = outcomes.findIndex(r => r.status === 'committed');
    const slot = calls[winner].args.slotId, loser = calls[1 - winner].args.slotId;
    // Independent domain oracle: 5 units cannot satisfy two requests of 3.
    assert.equal(stock(published.state), 2);
    assert.equal(published.state.revision, 1);
    assert.equal(published.state.records['stock']['camera'].version, 1);
    assert.equal(published.state.records['reservation'][slot].values['status'], 'active');
    assert.equal(published.state.records['reservation'][slot].values['quantity'], 3);
    assert.equal(published.state.records['reservation'][loser].values['status'], 'free');
    assert.equal(published.state.records['reservation'][loser].version, 0);
    const allocated = Object.values(published.state.records['reservation'])
      .filter(r => r.values['status'] === 'active').reduce((sum, r) => {
        assert.ok(typeof r.values['quantity'] === 'number');
        return sum + r.values['quantity'];
      }, 0);
    assert.equal(stock(published.state) + allocated, 5);
    const committed = outcomes[winner];
    assert.equal(committed.status, 'committed');
    assert.deepEqual(published.events, committed.events);
    assert.ok(published.events.every(e => e.invocationId === calls[winner].id));
    const before = published;
    assert.equal((await run(execute(runtime, store, calls[winner]))).status, 'duplicate');
    assert.equal(await run(SynchronizedRef.get(store)), before);
  }
});

test('inventory publication failure rolls back state, events and invocation ledger', async () => {
  const store = await run(makeStore(initialState)), call = invocation('retry', 'reserve');
  const before = await run(SynchronizedRef.get(store));
  await assert.rejects(run(execute(runtime, store, call, {beforePublish: () => { throw Error('publication failure'); }})));
  assert.equal(await run(SynchronizedRef.get(store)), before);
  assert.equal((await run(execute(runtime, store, call))).status, 'committed');
});
