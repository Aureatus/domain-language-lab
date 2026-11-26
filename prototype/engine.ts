import { createHash } from 'node:crypto';
import type { Actor, Decision, Model, Priority, Role, Ticket } from './model.ts';

// Hash semantic JSON independent of object-key insertion order. Arrays retain order.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

type Invocation = {
  id: string; actor: Actor; summary: string;
  state: 'pending' | 'ready' | 'completed'; approval?: string;
};
export type Event = {
  id: string; kind: string; source: string; parents: string[]; details: Record<string, unknown>;
};
export type Result = { status: 'pending' | 'ready' | 'completed' | 'rejected'; reason?: string };

export class Runtime {
  model: Model;
  ticket: Ticket;
  invocation?: Invocation;
  events: Event[] = [];
  deliveries: { key: string; recipient: string; event: string }[] = [];
  private clock: () => number;
  private mutantUsed = false;

  constructor(model: Model, ticket: Ticket, clock: () => number) {
    this.model = structuredClone(model);
    this.ticket = structuredClone(ticket);
    this.clock = clock;
  }

  private record(kind: string, details: Record<string, unknown>, parents?: string[]): Event {
    const previous = this.events.at(-1);
    const event = { id: `e${this.events.length + 1}`, kind, source: this.model.resolve.source,
      parents: parents ?? (previous ? [previous.id] : []), details };
    this.events.push(event);
    return event;
  }

  private reject(reason: string): Result {
    this.record('rejected', { reason });
    return { status: 'rejected', reason };
  }

  decision(actor: Actor): Decision { return this.model.policy[actor.role][this.ticket.priority]; }

  private approvalSubject() {
    const i = this.invocation;
    if (!i) throw new Error('Missing approval invocation');
    return structuredClone({ invocation: i.id, actor: i.actor, summary: i.summary,
      ticket: this.ticket, model: this.model });
  }

  private binding(): string { return hash(this.approvalSubject()); }

  request(actor: Actor, summary: string): Result {
    if (this.invocation) return this.reject('invocation-already-exists');
    if (!summary.trim()) return this.reject('summary-required');
    if (this.ticket.status !== this.model.resolve.precondition.status) return this.reject('ticket-not-open');
    const decision = this.decision(actor);
    if (decision === 'deny') return this.reject('policy-denied');
    this.invocation = { id: 'invocation-1', actor: structuredClone(actor), summary,
      state: decision === 'approval' ? 'pending' : 'ready' };
    this.record('requested', { decision, summary, modelHash: hash(this.model) });
    return { status: this.invocation.state };
  }

  approve(actor: Actor): Result {
    const i = this.invocation;
    if (!i || i.state === 'completed') return this.reject('no-active-invocation');
    if (actor.role !== 'reviewer') return this.reject('reviewer-required');
    i.approval = this.binding();
    i.state = 'ready';
    this.record('approved', { reviewer: actor.id, binding: i.approval, subject: this.approvalSubject() });
    return { status: 'ready' };
  }

  editSummary(summary: string): Result {
    const i = this.invocation;
    if (!i || i.state === 'completed') return this.reject('no-active-invocation');
    if (!summary.trim()) return this.reject('summary-required');
    i.summary = summary;
    this.record('arguments-edited', { summary });
    return { status: i.state };
  }

  replaceModel(model: Model): void {
    const before = hash(this.model);
    this.model = structuredClone(model);
    this.record('model-replaced', { before, after: hash(this.model) });
  }

  execute(options: { staleApprovalMutant?: boolean } = {}): Result {
    this.mutantUsed ||= options.staleApprovalMutant === true;
    const i = this.invocation;
    if (!i) return this.reject('no-active-invocation');
    // Stable identity makes repeated execution observationally idempotent here.
    if (i.state === 'completed') return { status: 'completed' };
    if (this.ticket.status !== this.model.resolve.precondition.status) return this.reject('ticket-not-open');
    const decision = this.decision(i.actor);
    if (decision === 'deny') return this.reject('policy-denied');
    const approvalMatches = i.approval === this.binding();
    if (decision === 'approval' && !(options.staleApprovalMutant ? Boolean(i.approval) : approvalMatches)) {
      return this.reject(i.approval ? 'stale-approval' : 'approval-required');
    }
    const before = structuredClone(this.ticket);
    const subject = this.approvalSubject();
    // The deliberately small IR supports these three update terms only.
    this.ticket = { ...before, status: this.model.resolve.set.status,
      resolution: i.summary, resolvedAt: this.clock(), version: before.version + 1 };
    i.state = 'completed';
    const commit = this.record('committed', { before, after: structuredClone(this.ticket),
      decision, approvalMatches, subject, invocation: i.id });
    this.route(commit.id);
    return { status: 'completed' };
  }

  private route(eventId: string): void {
    const recipients = new Set(this.model.resolve.activity.recipients.flatMap(path => {
      const value = this.ticket[path];
      return Array.isArray(value) ? value : [value];
    }));
    for (const recipient of [...recipients].sort()) {
      const key = `${eventId}:${recipient}:${this.model.resolve.activity.channel}`;
      if (!this.deliveries.some(item => item.key === key)) {
        this.deliveries.push({ key, recipient, event: eventId });
        this.record('delivery-intent', { key, recipient }, [eventId]);
      }
    }
  }

  export() {
    return { format: 'prototype-trace/0', kind: 'simulated', modelHash: hash(this.model),
      interpreter: { id: 'reference-interpreter/0', staleApprovalMutantUsed: this.mutantUsed },
      model: structuredClone(this.model), events: structuredClone(this.events),
      deliveryIntents: structuredClone(this.deliveries),
      assumptions: ['In-memory synchronous atomic commit', 'Trusted supplied actor roles',
        'One ticket and one invocation', 'No real external delivery',
        'Conservative approval binding includes entire model and ticket snapshot'] };
  }
}

export function policyDiff(before: Model, after: Model) {
  const changes: {witness:{role:Role;priority:Priority};before:Decision;after:Decision}[] = [];
  for (const role of ['support', 'reviewer', 'viewer'] as const) {
    for (const priority of ['normal', 'high'] as const) {
      if (before.policy[role][priority] !== after.policy[role][priority]) {
        changes.push({ witness: { role, priority }, before: before.policy[role][priority],
          after: after.policy[role][priority] });
      }
    }
  }
  return { scope: 'policy decisions over all 3 roles × 2 priorities; not full behavior equivalence',
    before: hash(before), after: hash(after), cases: 6, changes };
}
