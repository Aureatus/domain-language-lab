import test from 'node:test';
import assert from 'node:assert/strict';
import {createInterpreter} from '../../semantic/v2/core.ts';
import {inventoryV2Model, initialState, invocation} from './model.ts';

const copy = value => JSON.parse(JSON.stringify(value));
const stock = state => state.records.stock.camera.values.available;
const oracle = (before, operations) => {
  // Independent capacity/accounting model: deliberately does not inspect the IR or events.
  let available = before.records.stock.camera.values.available;
  const reservations = copy(before.records.reservation);
  for (const op of operations) {
    if (op.kind === 'reserve') {
      available -= op.quantity;
      reservations[op.id] = {version: 0, values: {stockId: 'camera', owner: op.owner, quantity: op.quantity, expiresAt: op.expiresAt, status: 'active'}};
    } else if (op.kind === 'cancel' || op.kind === 'expire') {
      available += reservations[op.id].values.quantity;
      reservations[op.id].values.status = op.kind === 'cancel' ? 'cancelled' : 'expired';
      reservations[op.id].version++;
    } else if (op.kind === 'delete-terminal') delete reservations[op.id];
  }
  return {available, reservations};
};
const run = (rt, state, id, kind, options) => rt.execute(state, invocation(id, kind, options));

test('actual inserts, stock decrement, approval, cancellation, expiry and terminal deletion', () => {
  const rt = createInterpreter(inventoryV2Model);
  let state = initialState;
  const expected = oracle(state, [
    {kind: 'reserve', id: 'res-small', owner: 'alice', quantity: 2, expiresAt: 30},
    {kind: 'reserve', id: 'res-large', owner: 'bob', quantity: 3, expiresAt: 40},
    {kind: 'cancel', id: 'res-small'}, {kind: 'expire', id: 'res-large'}, {kind: 'delete-terminal', id: 'res-small'}, {kind: 'delete-terminal', id: 'res-large'},
  ]);

  let result = run(rt, state, 'reserve-small', 'reserve', {reservationId: 'res-small', quantity: 2});
  assert.equal(result.status, 'committed'); assert.deepEqual(result.events.map(x => x.kind), ['action', 'change', 'create']);
  assert.equal(result.state.records.reservation['res-small'].version, 0);
  state = result.state;

  const large = invocation('reserve-large', 'reserve', {reservationId: 'res-large', actor: 'bob', quantity: 3, expiresAt: 40});
  const pending = rt.execute(state, large);
  assert.equal(pending.status, 'pending'); assert.deepEqual(pending.policyIds, ['reserve.warehouse-approval']);
  assert.equal(stock(pending.state), 6); assert.equal(pending.state.records.reservation['res-large'], undefined);
  const grant = rt.approve(pending.request, {policyId: 'reserve.warehouse-approval', approver: 'warehouse'});
  assert.equal(grant.status, 'approved');
  result = rt.resume(state, large, pending.request, [grant.receipt], {clock: 11});
  assert.equal(result.status, 'committed'); state = result.state;

  result = run(rt, state, 'cancel-small', 'cancel', {reservationId: 'res-small', actor: 'alice'});
  assert.equal(result.status, 'committed'); state = result.state;
  const beforeExpiry = state;
  result = run(rt, state, 'expire-large-early', 'expire', {reservationId: 'res-large', actor: 'warehouse', clock: 39});
  assert.equal(result.status, 'rejected'); assert.equal(result.code, 'precondition'); assert.strictEqual(result.state, beforeExpiry);
  result = run(rt, state, 'expire-large', 'expire', {reservationId: 'res-large', actor: 'warehouse', clock: 40});
  assert.equal(result.status, 'committed'); state = result.state;
  result = run(rt, state, 'delete-small', 'delete-terminal', {reservationId: 'res-small', actor: 'alice'});
  assert.equal(result.status, 'committed'); assert.equal(result.state.records.reservation['res-small'], undefined); state = result.state;
  result = run(rt, state, 'delete-large', 'delete-terminal', {reservationId: 'res-large', actor: 'bob'});
  assert.equal(result.status, 'committed'); state = result.state;
  assert.equal(stock(state), expected.available);
  assert.deepEqual(state.records.reservation, expected.reservations);
});

test('denial, failed preconditions, duplicate ID, ownership and stale approvals are distinct', () => {
  const rt = createInterpreter(inventoryV2Model), state = initialState;
  const tooLate = run(rt, state, 'late', 'reserve', {reservationId: 'late-res', clock: 30, expiresAt: 30, quantity: 1});
  assert.equal(tooLate.status, 'rejected'); assert.equal(tooLate.code, 'precondition');
  const largeInvocation = invocation('pending-call', 'reserve', {reservationId: 'approved-res', actor: 'bob', quantity: 3});
  const pending = rt.execute(state, largeInvocation);
  const grant = rt.approve(pending.request, {policyId: 'reserve.warehouse-approval', approver: 'warehouse'});
  const changed = copy(state); changed.records.stock.camera.values.watchers.push('carol');
  assert.equal(rt.resume(changed, largeInvocation, pending.request, [grant.receipt], {clock: 11}).code, 'stale');
  assert.equal(rt.resume(state, largeInvocation, pending.request, [grant.receipt], {clock: 30}).code, 'precondition');
  assert.equal(rt.approve(pending.request, {policyId: 'reserve.warehouse-approval', approver: 'alice'}).code, 'unauthorized-approval');
  const committed = rt.resume(state, largeInvocation, pending.request, [grant.receipt], {clock: 11});
  assert.equal(committed.status, 'committed');
  assert.equal(run(rt, committed.state, 'same-id', 'reserve', {reservationId: 'approved-res', quantity: 1}).code, 'existing-record');
  assert.equal(run(rt, committed.state, 'wrong-owner', 'cancel', {reservationId: 'approved-res', actor: 'alice'}).code, 'denied');
  assert.equal(run(rt, committed.state, 'wrong-delete', 'delete-terminal', {reservationId: 'approved-res', actor: 'bob'}).code, 'precondition');
});

test('multiple named reservations independently obey a capacity oracle', () => {
  const rt = createInterpreter(inventoryV2Model);
  let state = initialState;
  for (const [id, owner, quantity] of [['alice-camera-a', 'alice', 2], ['bob-camera-b', 'bob', 2], ['alice-camera-c', 'alice', 1]]) {
    const result = run(rt, state, `create-${id}`, 'reserve', {reservationId: id, actor: owner, quantity, expiresAt: 50});
    assert.equal(result.status, 'committed'); state = result.state;
  }
  assert.equal(stock(state), 3);
  const capacityFailure = run(rt, state, 'over-capacity', 'reserve', {reservationId: 'too-many', quantity: 4, expiresAt: 50});
  assert.equal(capacityFailure.code, 'precondition'); assert.equal(stock(capacityFailure.state), 3);
  const expected = oracle(initialState, [
    {kind: 'reserve', id: 'alice-camera-a', owner: 'alice', quantity: 2, expiresAt: 50},
    {kind: 'reserve', id: 'bob-camera-b', owner: 'bob', quantity: 2, expiresAt: 50},
    {kind: 'reserve', id: 'alice-camera-c', owner: 'alice', quantity: 1, expiresAt: 50},
  ]);
  assert.equal(stock(state), expected.available); assert.deepEqual(state.records.reservation, expected.reservations);
});
