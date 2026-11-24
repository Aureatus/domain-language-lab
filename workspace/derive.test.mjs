import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveTools, deriveDependencies, deriveChange} from './derive.mjs';
import {inventoryModel, runtime as v1, initialState as initialV1, invocation as invokeV1} from '../inventory/model.mjs';
import {inventoryV2Model, runtime as v2, initialState as initialV2, invocation as invokeV2} from '../inventory/v2/model.mjs';
import {issueModel, issueState} from '../semantic/issues.mjs';
import {createInterpreter} from '../semantic/core.mjs';

test('tools preserve exact schema/policy/precondition declarations in both profiles', () => {
  for (const model of [inventoryModel, inventoryV2Model, issueModel]) {
    for (const tool of deriveTools(model)) {
      assert.deepEqual(tool.inputs, model.actions[tool.name].inputs);
      assert.deepEqual(tool.policyIds, model.actions[tool.name].policies.map(x => x.id));
      assert.deepEqual(tool.preconditionIds, model.actions[tool.name].preconditions.map(x => x.id));
    }
    const tools = deriveTools(model); tools[0].inputs = {};
    assert.notDeepEqual(tools, deriveTools(model));
  }
});

test('action declarations and facts route views, independently of actor-excluded human recipients', () => {
  for (const [model, runtime, state, invocation] of [
    [inventoryModel, v1, initialV1, invokeV1('derive1', 'reserve')],
    [inventoryV2Model, v2, initialV2, invokeV2('derive2', 'reserve', {reservationId: 'res1'})],
  ]) {
    const result = runtime.execute(state, invocation); assert.equal(result.status, 'committed');
    const change = deriveChange(model, result.events, {sequence: 1});
    assert(change.invalidations.some(x => x.resource === 'reservation'));
    assert(change.invalidations.some(x => x.relationship === 'reservation.owner'));
    assert(!change.recipients.some(x => x.recipient === 'alice'));
    assert(change.recipients.some(x => x.recipient === 'bob'));
    const dependencies = deriveDependencies(model);
    assert(dependencies.find(x => x.actionId === invocation.action).writes.length > 0);
  }
});

test('routing is generic across renamed actions and other domains; pending is explicit', () => {
  const model = structuredClone(issueModel);
  model.actions['ticket.finish'] = model.actions['issue.resolve']; delete model.actions['issue.resolve'];
  const runtime = createInterpreter(model);
  const result = runtime.execute(issueState, {id: 'generic', action: 'ticket.finish', args: {issueId: 'i1'}, actor: 'maya', clock: 1});
  assert.equal(result.status, 'committed');
  assert(deriveChange(model, result.events).invalidations.some(x => x.resource === 'issues'));
  assert.deepEqual(deriveChange(model, [], {sequence: 4, pending: true, reason: 'approval-ledger'}), {
    sequence: 4, invalidations: [{view: 'pending'}], recipients: [], reason: 'approval-ledger',
  });
});
