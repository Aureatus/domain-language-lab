import { Runtime } from './engine.ts';
import { isDeepStrictEqual } from 'node:util';
import { model, reviewer, support, ticket } from './model.ts';

export type Step = 'approve' | 'edit' | 'execute';
export function permutations<T>(items: T[]): T[][] {
  if (!items.length) return [[]];
  return items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map(rest => [item, ...rest]));
}

export function replay(schedule: Step[], mutant = false) {
  const runtime = new Runtime(model, ticket(), () => 1000);
  runtime.request(support, 'Original resolution');
  for (const step of schedule) {
    if (step === 'approve') runtime.approve(reviewer);
    if (step === 'edit') runtime.editSummary('Changed resolution');
    if (step === 'execute') runtime.execute({ staleApprovalMutant: mutant });
  }
  return runtime;
}

export function explore(mutant = false) {
  const schedules = permutations<Step>(['approve', 'edit', 'execute']);
  const failures = schedules.flatMap(schedule => {
    const runtime = replay(schedule, mutant);
    // Compare recorded subjects independently of the runtime's hash/match diagnostic.
    // Trace completeness and fidelity still belong to the interpreter's trusted boundary.
    let approvedSubject: unknown;
    const invalid = runtime.events.find(event => {
      if (event.kind === 'approved') approvedSubject = event.details.subject;
      return event.kind === 'committed' && event.details.decision === 'approval'
        && !isDeepStrictEqual(approvedSubject, event.details.subject);
    });
    return invalid ? [{ schedule, event: invalid.id, trace: runtime.export() }] : [];
  });
  return { method: 'finite-schedule-enumeration',
    result: failures.length ? 'counterexample' : 'bounded_pass',
    scope: { initialState: 'one high-priority open ticket; support invocation already requested',
      actions: ['approve', 'edit', 'execute'], occurrencesPerAction: 1, schedules: schedules.length,
      clock: 1000, property: 'Every approval-required commit matches its current invocation binding' },
    mutant, failures };
}

export function storyboard(runtime: Runtime) {
  const trace = runtime.export();
  return { format: 'prototype-storyboard/0', kind: 'simulated-explanation',
    trace, timing: 'editorial-not-measured',
    scenes: trace.events.map(event => ({ id: `scene-${event.id}`, eventIds: [event.id],
      caption: event.kind === 'rejected' ? `Rejected: ${event.details.reason}` : event.kind,
      durationMs: 1500, source: event.source })) };
}
