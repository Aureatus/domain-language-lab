import test from 'node:test';
import assert from 'node:assert/strict';
import { generateHistory, replayHistory, runProperties, shrinkHistory } from './property.ts';
import type { Action, ReplayData } from './property.ts';

const request: Action = { kind: 'request', actor: { id: 'support-1', role: 'support' }, summary: 'Original resolution' };
const approve: Action = { kind: 'approve', actor: { id: 'reviewer-1', role: 'reviewer' } };
const execute: Action = { kind: 'execute' };
const data = (history: Action[], mutant = false): ReplayData => ({
  format: 'approval-property-replay/1', clock: 1000, staleApprovalMutant: mutant, history,
});

test('generated sampled reports are deterministic, serializable and non-vacuous', () => {
  const options = { seed: 12345, samples: 150, maxSteps: 24 };
  const first = runProperties(options);
  assert.deepEqual(first, runProperties(options));
  assert.deepEqual(first, JSON.parse(JSON.stringify(first)));
  assert.equal(first.result, 'sampled_pass');
  assert.equal(first.sampleCount, 150);
  assert.equal(first.skipped, 0);
  assert.ok(first.coverage.approvalRequiredCommits > 0);
  assert.ok(first.coverage.staleRejections > 0);
  for (const kind of ['request', 'approve', 'edit', 'execute', 'policy', 'revision', 'resource']) {
    assert.ok((first.coverage.actions[kind] ?? 0) > 0, kind);
  }
  assert.match(first.engine.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.engine.oracle, 'independent-snapshot-state-machine/1');
});

test('seed zero is reproducible; seeds vary values, order and lengths inside bounds', () => {
  const histories = Array.from({ length: 100 }, (_, seed) => generateHistory(seed, 20));
  assert.deepEqual(generateHistory(0, 20), histories[0]);
  assert.ok(new Set(histories.map(h => JSON.stringify(h))).size > 90);
  assert.ok(new Set(histories.map(h => h.length)).size > 10);
  assert.ok(histories.every(h => h.length >= 1 && h.length <= 20));
  assert.equal(generateHistory(0, 1).length, 1);
});

test('known stale-binding mutant is found by generated samples and replayed exactly', () => {
  const report = runProperties({ seed: 12345, samples: 40, maxSteps: 24, staleApprovalMutant: true });
  assert.equal(report.result, 'counterexample');
  assert.ok(report.failures.length > 0);
  for (const failure of report.failures) {
    assert.equal(failure.originalFailure.kind, 'stale-approval-commit');
    assert.deepEqual(generateHistory(failure.sampleSeed, 24), failure.originalHistory);
    assert.deepEqual(replayHistory(JSON.parse(JSON.stringify(failure.replay))), failure.minimized);
    assert.equal(failure.minimized.trace.interpreter.staleApprovalMutantUsed, true);
    assert.equal(replayHistory({ ...failure.replay, staleApprovalMutant: false }).result, 'sampled_pass');
    assert.ok(failure.minimalHistory.length <= failure.originalHistory.length);
  }
});

test('shrinking removes noise, simplifies values, is deterministic and reaches a deletion-minimal reproducer', () => {
  const history: Action[] = [execute, { kind: 'approve', actor: { id: 'bad', role: 'viewer' } },
    request, approve, { kind: 'edit', summary: 'Changed resolution' }, execute, execute];
  const shrunk = shrinkHistory(history, true);
  assert.deepEqual(shrunk, shrinkHistory(history, true));
  assert.equal(shrunk.minimality, 'single-deletion-and-listed-values');
  assert.equal(shrunk.budgetExhausted, false);
  assert.deepEqual(shrunk.minimalHistory.map(a => a.kind), ['request', 'approve', 'edit', 'execute']);
  assert.ok(JSON.stringify(shrunk.minimalHistory).length < JSON.stringify(history.slice(2, 6)).length);
  assert.equal(replayHistory(shrunk.replay).failure?.kind, 'stale-approval-commit');
  for (let index = 0; index < shrunk.minimalHistory.length; index++) {
    assert.equal(replayHistory(data(shrunk.minimalHistory.filter((_, i) => i !== index), true)).failure, null);
  }
  assert.equal(replayHistory(data(shrunk.minimalHistory)).failure, null);
});

test('argument, resource and whole-model changes invalidate snapshots; reapproval repairs them', () => {
  const changes: Action[] = [
    { kind: 'edit', summary: 'Different' }, { kind: 'revision', value: 2 },
    { kind: 'resource', field: 'version', value: 2 },
    { kind: 'resource', field: 'watchers', value: [] },
    { kind: 'policy', role: 'viewer', priority: 'normal', decision: 'allow' },
  ];
  for (const change of changes) {
    const history = [request, approve, change, execute];
    assert.equal(replayHistory(data(history)).coverage.staleRejections, 1);
    assert.equal(replayHistory(data(history, true)).failure?.kind, 'stale-approval-commit');
    const repaired = replayHistory(data([request, approve, change, approve, execute, execute]));
    assert.equal(repaired.failure, null);
    assert.equal(repaired.coverage.commits, 1);
  }
});

test('oracle handles denial, current-policy allow, no-op changes and restoring exact snapshots', () => {
  const deny: Action = { kind: 'policy', role: 'support', priority: 'high', decision: 'deny' };
  const allow: Action = { ...deny, decision: 'allow' };
  for (const mutant of [false, true]) {
    assert.equal(replayHistory(data([request, approve, deny, execute], mutant)).coverage.commits, 0);
    assert.equal(replayHistory(data([request, allow, execute], mutant)).coverage.commits, 1);
    assert.equal(replayHistory(data([request, approve, { kind: 'revision', value: 1 }, execute], mutant)).failure, null);
    const restored = replayHistory(data([request, approve, { kind: 'edit', summary: 'temporary' },
      { kind: 'edit', summary: 'Original resolution' }, execute], mutant));
    assert.equal(restored.failure, null);
    assert.equal(restored.coverage.commits, 1);
  }
});

test('budget exhaustion is explicit and invalid inputs cannot silently pass', () => {
  const history: Action[] = [request, approve, { kind: 'edit', summary: 'b' }, execute];
  const shrunk = shrinkHistory(history, true, 0);
  assert.equal(shrunk.budgetExhausted, true);
  assert.equal(shrunk.minimality, 'budget-limited');
  assert.deepEqual(shrunk.minimalHistory, history);
  assert.throws(() => shrinkHistory(history, false), /passing/);
  for (const options of [{ seed: -1 }, { seed: 2 ** 32 }, { samples: 0 }, { maxSteps: 0 },
    { shrinkBudget: -1 }, { seed: NaN }, { samples: 1.5 }]) assert.throws(() => runProperties(options), RangeError);
  assert.throws(() => replayHistory({ ...data([]), clock: 2 } as unknown as ReplayData), /Unsupported/);
  assert.throws(() => replayHistory(data([{ kind: 'unknown' } as unknown as Action])), /Invalid replay action/);
  assert.throws(() => replayHistory(data([{ kind: 'approve', actor: { id: 'x', role: 'admin' } } as unknown as Action])), /Invalid replay action/);
});
