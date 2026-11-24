import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {inventoryModel, initialState, invocation} from '../../inventory/model.mjs';
import {createInterpreter} from '../../semantic/core.mjs';
import {generate, hash, Unsupported} from './generate.mjs';
import {PINNED_LEAN} from './check.mjs';
import {projectInventory, generateInventory, checkInventory, obligation} from './inventory.mjs';

const out = '/tmp/opencode/inventory-evidence';
const action = m => m.actions['reservation.reserve'];
const update = m => action(m).updates.find(u => u.id === 'reservation.reserve.set.available');
const record = (available, revision = 0, version = 0) => `{ capacity := 5, available := ${available}, revision := ${revision}, version := ${version} }`;

function crossCheck(name, source, cases) {
  mkdirSync(out, {recursive: true});
  const {code} = generateInventory(source);
  let lean = code.split('-- Independent source obligation:')[0];
  for (const [index, c] of cases.entries()) {
    const pre = structuredClone(initialState);
    pre.records.stock.camera.values.available = c.available ?? 5;
    const call = invocation(`cross${index}`, 'reserve', 'slotA', 'alice', 10, c.quantity ?? 3);
    const actual = createInterpreter(source).execute(pre, call);
    assert.equal(actual.status === 'committed' ? 'committed' : actual.code, c.expected);
    const expected = actual.status === 'committed'
      ? `.committed ${record(actual.state.records.stock.camera.values.available, actual.state.revision, actual.state.records.stock.camera.version)}`
      : `.${actual.code}`;
    if (c.post !== undefined) assert.equal(actual.state.records.stock.camera.values.available, c.post);
    lean += `example : step ${record(c.available ?? 5)} { quantity := ${c.quantity ?? 3}, clock := 10 } = ${expected} := by decide\n`;
  }
  lean += 'end Generated\n';
  const file = resolve(out, `${name}.lean`);
  writeFileSync(file, lean);
  const run = spawnSync(PINNED_LEAN, [file], {encoding: 'utf8', timeout: 120000});
  writeFileSync(resolve(out, `${name}.log`), (run.stdout || '') + (run.stderr || ''));
  assert.equal(run.status, 0, `${run.error || ''}\n${run.stdout}\n${run.stderr}`);
}

test('extracts actual numeric schemas and ASTs with complete original content binding', () => {
  const {model, metadata} = projectInventory();
  const original = action(inventoryModel), projected = action(model);
  assert.deepEqual(projected.updates, [update(inventoryModel)]);
  assert.deepEqual(projected.preconditions, original.preconditions.filter(p => p.id === 'reservation.reserve.capacity'));
  assert.deepEqual(model.resources.stock.fields, {capacity: inventoryModel.resources.stock.fields.capacity, available: inventoryModel.resources.stock.fields.available});
  assert.deepEqual(projected.inputs, {quantity: original.inputs.quantity});
  assert.deepEqual(projected.bindings[0].key, {op: 'literal', value: 'camera'});
  assert.deepEqual(metadata.source, inventoryModel);
  assert.equal(metadata.source_sha256, hash(inventoryModel));
  assert.equal(metadata.projected_sha256, hash(model));
  assert.deepEqual(metadata.retained_ids, ['inventory.v1', 'reservation.reserve', 'reservation.reserve.capacity', 'reservation.reserve.set.available', 'reservation.reserve.stock', 'stock']);
  const all = [inventoryModel.id, ...Object.keys(inventoryModel.resources), ...inventoryModel.relationships.map(r => r.id)];
  for (const [id, a] of Object.entries(inventoryModel.actions)) {
    all.push(id, ...a.bindings.map(x => x.id), ...a.preconditions.map(x => x.id), ...a.policies.map(x => x.id), ...a.updates.map(x => x.id));
  }
  assert.deepEqual([...metadata.retained_ids, ...metadata.excluded_ids].sort(), all.sort());
  assert.ok(metadata.excluded_ids.includes('reservation.reserve.ownership'));
  assert.ok(metadata.excluded_ids.includes('reservation.reserve.futureExpiry'));
  assert.ok(metadata.excluded_ids.includes('reservation.reserve.slot'));
  assert.ok(metadata.excluded_ids.includes('stock.watchers'));
  // Numeric-only projection is deliberately not a full executable authorization model.
  assert.equal(createInterpreter(model).execute({revision: 0, records: {stock: {camera: {version: 0, values: {capacity: 5, available: 5}}}}},
    {id: 'notAuthorized', action: 'reservation.reserve', args: {quantity: 3}, actor: 'alice', clock: 10}).code, 'denied');
  assert.throws(() => generate(inventoryModel, obligation), Unsupported);
});

test('structural drift and unretained dependencies fail closed', () => {
  for (const edit of [
    m => {m.resources.stock.fields.extra = {type: 'integer'};},
    m => {action(m).inputs.quantity.min = 0;},
    m => {action(m).preconditions.push({id: 'new.guard', when: {op: 'literal', value: true}});},
    m => {action(m).policies[0].effect = 'deny';},
    m => {action(m).bindings[0].key = {op: 'literal', value: 'camera'};},
    m => {update(m).value = {op: 'field', binding: 'reservation.reserve.slot', field: 'quantity'};},
    m => {update(m).value = {op: 'input', name: 'expiresAt'};},
    m => {update(m).value = {op: 'clock'};},
    m => {update(m).value.op = 'mul';},
  ]) {
    const mutant = structuredClone(inventoryModel); edit(mutant);
    assert.throws(() => projectInventory(mutant), Unsupported);
  }
});

test('pinned Lean proves independent law and actual 5-to-2 witness', () => {
  const report = checkInventory(resolve(out, 'positive'));
  assert.equal(report.status, 'proof_checked', report.detail);
  assert.deepEqual(report.theorem_axioms.positive_witness, []);
  assert.deepEqual(Object.keys(report.theorem_axioms), ['preserves', 'positive_witness']);
  crossCheck('actual-reserve', inventoryModel, [
    {expected: 'committed', post: 2},
    {available: 3, expected: 'committed', post: 0},
    {available: 2, expected: 'precondition'},
    {quantity: 5, expected: 'committed', post: 0},
  ]);
});

test('changed original reserve update changes projection; unchanged law rejects correct mutant witness', () => {
  const mutant = structuredClone(inventoryModel);
  update(mutant).value.right = {op: 'add', left: {op: 'input', name: 'quantity'}, right: {op: 'literal', value: 1}};
  const before = generateInventory(), after = generateInventory(mutant);
  assert.notEqual(before.code, after.code);
  assert.notEqual(before.inventory.source_sha256, after.inventory.source_sha256);
  assert.notEqual(before.inventory.projected_sha256, after.inventory.projected_sha256);
  assert.deepEqual(action(projectInventory(mutant).model).updates, [update(mutant)]);
  const law = structuredClone(obligation); law.witness.post.available = 1;
  assert.deepEqual(law.ensures, obligation.ensures);
  const report = checkInventory(resolve(out, 'overselling'), mutant, law);
  assert.equal(report.status, 'not_checked');
  const log = readFileSync(resolve(out, 'overselling/check.log'), 'utf8');
  assert.match(log, /omega could not prove the goal/);
  assert.match(log, /'Generated.positive_witness' does not depend on any axioms/);
  crossCheck('actual-mutant', mutant, [{expected: 'committed', post: 1}]);
});
