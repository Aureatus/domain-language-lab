import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";

import { Runtime } from "./engine.ts";
import { model, ticket } from "./model.ts";
import type {
  Actor,
  Decision,
  Model,
  Priority,
  Role,
  Ticket,
} from "./model.ts";

export type Action =
  | { kind: "request"; actor: Actor; summary: string }
  | { kind: "approve"; actor: Actor }
  | { kind: "edit"; summary: string }
  | { kind: "execute" }
  | { kind: "policy"; role: Role; priority: Priority; decision: Decision }
  | { kind: "revision"; value: number }
  | { kind: "resource"; field: "version"; value: number }
  | { kind: "resource"; field: "priority"; value: Priority }
  | { kind: "resource"; field: "watchers"; value: string[] };

export interface PropertyOptions {
  seed?: number;
  samples?: number;
  maxSteps?: number;
  shrinkBudget?: number;
  staleApprovalMutant?: boolean;
}

export interface ReplayData {
  format: "approval-property-replay/1";
  clock: 1000;
  staleApprovalMutant: boolean;
  history: Action[];
}

const roles: Role[] = ["support", "reviewer", "viewer"];
const priorities: Priority[] = ["normal", "high"];
const decisions: Decision[] = ["allow", "deny", "approval"];
const summaries = ["", " ", "a", "b", "Fixed issue", "Different resolution"];
const CLOCK = 1000;
const VERSION = "seeded-approval-histories/1";
const clone = <T>(value: T): T => structuredClone(value);

function integer(
  name: string,
  value: number,
  min: number,
  max: number
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  }

  return value;
}

// Mulberry32: unsigned 32-bit state, explicit seed (including zero), no ambient randomness.
function random(seed: number) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);

    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** One reproducible sample. Half the samples bias toward an approval/change/execute motif. */
export function generateHistory(seed: number, maxSteps = 32): Action[] {
  integer("seed", seed, 0, 0xff_ff_ff_ff);
  integer("maxSteps", maxSteps, 1, 1000);
  const next = random(seed);

  const pick = <T>(items: readonly T[]): T => {
    const item = items[next() % items.length];

    if (item === undefined) {
      throw new Error("Expected a nonempty selection pool");
    }

    return item;
  };

  const actor = (): Actor => ({
    id: pick(["actor-1", "actor-2"]),
    role: pick(roles),
  });

  const mutation = (): Action =>
    pick<Action>([
      { kind: "edit", summary: pick(summaries) },
      { kind: "revision", value: next() % 4 },
      {
        kind: "policy",
        role: pick(roles),
        priority: pick(priorities),
        decision: pick(decisions),
      },
      { kind: "resource", field: "version", value: next() % 4 },
      { kind: "resource", field: "priority", value: pick(priorities) },
      {
        kind: "resource",
        field: "watchers",
        value: pick([[], ["user-1"], ["user-2", "user-2"]]),
      },
    ]);

  const action = (): Action => {
    switch (next() % 7) {
      case 0: {
        return { kind: "request", actor: actor(), summary: pick(summaries) };
      }

      case 1: {
        return { kind: "approve", actor: actor() };
      }

      case 2: {
        return { kind: "edit", summary: pick(summaries) };
      }

      case 3: {
        return { kind: "execute" };
      }

      default: {
        return mutation();
      }
    }
  };

  const history: Action[] = [];

  if (maxSteps >= 4 && next() % 2 === 0) {
    history.push(
      {
        kind: "request",
        actor: { id: "actor-1", role: "support" },
        summary: "Fixed issue",
      },
      { kind: "approve", actor: { id: "actor-2", role: "reviewer" } },
      mutation(),
      { kind: "execute" }
    );
  }

  const length = history.length + (next() % (maxSteps - history.length + 1));

  while (history.length < Math.max(1, length)) {
    history.push(action());
  }

  return clone(history);
}

interface Invocation {
  id: string;
  actor: Actor;
  summary: string;
  state: "pending" | "ready" | "completed";
}

interface Subject {
  invocation: string;
  actor: Actor;
  summary: string;
  ticket: Ticket;
  model: Model;
}

type Outcome = { status: string; reason?: string } | null;

// Independent specification state: no Runtime helpers, hashes, event subjects or diagnostics.
class SnapshotOracle {
  model = clone(model);
  ticket = ticket();
  invocation?: Invocation;
  approved?: Subject;
  subject(): Subject {
    const i = this.invocation;

    if (!i) {
      throw new Error("Missing approval invocation");
    }

    return clone({
      invocation: i.id,
      actor: i.actor,
      summary: i.summary,
      ticket: this.ticket,
      model: this.model,
    });
  }
  apply(action: Action): Outcome {
    const i = this.invocation;
    const reject = (reason: string) => ({ status: "rejected", reason });

    switch (action.kind) {
      case "request": {
        if (i) {
          return reject("invocation-already-exists");
        }

        if (!action.summary.trim()) {
          return reject("summary-required");
        }

        if (this.ticket.status !== "open") {
          return reject("ticket-not-open");
        }

        const decision =
          this.model.policy[action.actor.role][this.ticket.priority];

        if (decision === "deny") {
          return reject("policy-denied");
        }

        this.invocation = {
          id: "invocation-1",
          actor: clone(action.actor),
          summary: action.summary,
          state: decision === "approval" ? "pending" : "ready",
        };

        return { status: this.invocation.state };
      }

      case "approve": {
        if (!i || i.state === "completed") {
          return reject("no-active-invocation");
        }

        if (action.actor.role !== "reviewer") {
          return reject("reviewer-required");
        }

        this.approved = this.subject();
        i.state = "ready";

        return { status: "ready" };
      }

      case "edit": {
        if (!i || i.state === "completed") {
          return reject("no-active-invocation");
        }

        if (!action.summary.trim()) {
          return reject("summary-required");
        }

        i.summary = action.summary;

        return { status: i.state };
      }

      case "execute": {
        if (!i) {
          return reject("no-active-invocation");
        }

        if (i.state === "completed") {
          return { status: "completed" };
        }

        if (this.ticket.status !== "open") {
          return reject("ticket-not-open");
        }

        const decision = this.model.policy[i.actor.role][this.ticket.priority];

        if (decision === "deny") {
          return reject("policy-denied");
        }

        if (decision === "approval" && !equal(this.approved, this.subject())) {
          return reject(this.approved ? "stale-approval" : "approval-required");
        }

        this.ticket = {
          ...this.ticket,
          status: "resolved",
          resolution: i.summary,
          resolvedAt: CLOCK,
          version: this.ticket.version + 1,
        };
        i.state = "completed";

        return { status: "completed" };
      }

      case "policy": {
        this.model.policy[action.role][action.priority] = action.decision;

        return null;
      }

      case "revision": {
        this.model.revision = action.value;

        return null;
      }

      case "resource": {
        if (action.field === "version") {
          this.ticket.version = action.value;
        }

        if (action.field === "priority") {
          this.ticket.priority = action.value;
        }

        if (action.field === "watchers") {
          this.ticket.watchers = clone(action.value);
        }

        return null;
      }
      // no default: the cases cover every action.kind variant.
    }
  }
}

function apply(runtime: Runtime, action: Action, mutant: boolean): Outcome {
  switch (action.kind) {
    case "request": {
      return runtime.request(action.actor, action.summary);
    }

    case "approve": {
      return runtime.approve(action.actor);
    }

    case "edit": {
      return runtime.editSummary(action.summary);
    }

    case "execute": {
      return runtime.execute({ staleApprovalMutant: mutant });
    }

    case "policy": {
      const next = clone(runtime.model);
      next.policy[action.role][action.priority] = action.decision;
      runtime.replaceModel(next);

      return null;
    }

    case "revision": {
      const next = clone(runtime.model);
      next.revision = action.value;
      runtime.replaceModel(next);

      return null;
    }

    case "resource": {
      if (action.field === "version") {
        runtime.ticket.version = action.value;
      }

      if (action.field === "priority") {
        runtime.ticket.priority = action.value;
      }

      if (action.field === "watchers") {
        runtime.ticket.watchers = clone(action.value);
      }

      return null;
    }
    // no default: the cases cover every action.kind variant.
  }
}

function observableInvocation(i: Runtime["invocation"] | Invocation) {
  return i
    ? { id: i.id, actor: i.actor, summary: i.summary, state: i.state }
    : null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const member = <T>(values: readonly T[], value: unknown): value is T =>
  values.some((v) => v === value);

const validActor = (value: unknown) =>
  object(value) &&
  typeof value["id"] === "string" &&
  member(roles, value["role"]);

const natural = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validateAction(action: unknown): asserts action is Action {
  if (!object(action)) {
    throw new Error("Invalid replay action");
  }

  const { kind, actor, summary, role, priority, decision, value, field } =
    action;

  let valid = false;

  switch (kind) {
    case "request": {
      valid = validActor(actor) && typeof summary === "string";
      break;
    }

    case "approve": {
      valid = validActor(actor);
      break;
    }

    case "edit": {
      valid = typeof summary === "string";
      break;
    }

    case "execute": {
      valid = true;
      break;
    }

    case "policy": {
      valid =
        member(roles, role) &&
        member(priorities, priority) &&
        member(decisions, decision);
      break;
    }

    case "revision": {
      valid = natural(value);
      break;
    }

    case "resource": {
      if (field === "version") {
        valid = natural(value) && value < Number.MAX_SAFE_INTEGER;
      }

      if (field === "priority") {
        valid = member(priorities, value);
      }

      if (field === "watchers") {
        valid =
          Array.isArray(value) &&
          value.every((item) => typeof item === "string");
      }

      break;
    }
    // no default: the cases cover every kind variant.
  }

  if (!valid) {
    throw new Error("Invalid replay action");
  }
}

/** Replay exact commands from the fixed initial model/ticket; stops at the first discrepancy. */
export function replayHistory(data: unknown) {
  if (!object(data)) {
    throw new Error("Unsupported replay contract");
  }

  const { format, clock, staleApprovalMutant, history } = data;

  if (
    format !== "approval-property-replay/1" ||
    clock !== CLOCK ||
    typeof staleApprovalMutant !== "boolean" ||
    !Array.isArray(history)
  ) {
    throw new Error("Unsupported replay contract");
  }

  // Validate the entire history, including commands beyond a potential first discrepancy.
  const raw: unknown[] = history;

  const actions = raw.map((action) => {
    validateAction(action);

    return action;
  });

  const runtime = new Runtime(model, ticket(), () => clock);
  const oracle = new SnapshotOracle();

  const coverage = {
    steps: 0,
    executes: 0,
    commits: 0,
    approvalRequiredCommits: 0,
    staleRejections: 0,
  };

  for (const [index, action] of actions.entries()) {
    const wasCompleted = oracle.invocation?.state === "completed";

    const approvalRequired = oracle.invocation
      ? oracle.model.policy[oracle.invocation.actor.role][
          oracle.ticket.priority
        ] === "approval"
      : false;

    const expected = oracle.apply(action);
    const actual = apply(runtime, action, staleApprovalMutant);
    coverage.steps += 1;

    if (action.kind === "execute") {
      coverage.executes += 1;

      if (expected?.reason === "stale-approval") {
        coverage.staleRejections += 1;
      }

      if (!wasCompleted && actual?.status === "completed") {
        coverage.commits += 1;

        if (approvalRequired) {
          coverage.approvalRequiredCommits += 1;
        }
      }
    }

    const expectedState = {
      ticket: oracle.ticket,
      model: oracle.model,
      invocation: observableInvocation(oracle.invocation),
    };

    const actualState = {
      ticket: runtime.ticket,
      model: runtime.model,
      invocation: observableInvocation(runtime.invocation),
    };

    if (!equal(expected, actual) || !equal(expectedState, actualState)) {
      return {
        result: "counterexample" as const,
        coverage,
        failure: {
          kind:
            expected?.reason === "stale-approval" &&
            actual?.status === "completed"
              ? "stale-approval-commit"
              : "snapshot-oracle-mismatch",
          index,
          expected,
          actual,
          expectedState: clone(expectedState),
          actualState: clone(actualState),
        },
        trace: runtime.export(),
      };
    }
  }

  return {
    result: "sampled_pass" as const,
    coverage,
    failure: null,
    trace: runtime.export(),
  };
}

function replayData(history: Action[], mutant: boolean): ReplayData {
  return {
    format: "approval-property-replay/1",
    clock: CLOCK,
    staleApprovalMutant: mutant,
    history: clone(history),
  };
}

function simpler(action: Action): Action[] {
  switch (action.kind) {
    case "request": {
      return [
        ...["", "a", "b"]
          .filter((s) => s.length < action.summary.length)
          .map((summary) => ({ ...action, summary })),
        ...(action.actor.id === "a"
          ? []
          : [{ ...action, actor: { ...action.actor, id: "a" } }]),
      ];
    }

    case "approve": {
      return action.actor.id === "a"
        ? []
        : [{ ...action, actor: { ...action.actor, id: "a" } }];
    }

    case "edit": {
      return ["", "a", "b"]
        .filter((s) => s.length < action.summary.length)
        .map((summary) => ({ ...action, summary }));
    }

    case "revision": {
      return action.value === 0 ? [] : [{ ...action, value: 0 }];
    }

    case "resource": {
      if (action.field === "version") {
        return action.value === 0 ? [] : [{ ...action, value: 0 }];
      }

      if (action.field === "watchers") {
        return action.value.length ? [{ ...action, value: [] }] : [];
      }

      return [];
    }

    default: {
      return [];
    }
  }
}

/** Deterministic chunk deletion, then single deletion/value simplification to a fixed point. */
export function shrinkHistory(
  history: Action[],
  mutant = false,
  budget = 2000
) {
  integer("shrinkBudget", budget, 0, 100_000);
  const original = replayHistory(replayData(history, mutant));

  if (!original.failure) {
    throw new Error("Cannot shrink a passing history");
  }

  const { kind } = original.failure;
  let minimal = clone(history);
  let attempts = 0;

  const accepts = (candidate: Action[]) => {
    if (attempts >= budget) {
      return false;
    }

    attempts += 1;

    return replayHistory(replayData(candidate, mutant)).failure?.kind === kind;
  };

  for (
    let size = Math.floor(minimal.length / 2);
    size >= 2 && attempts < budget;
    size = Math.floor(size / 2)
  ) {
    for (let start = 0; start + size <= minimal.length && attempts < budget;) {
      const candidate = [
        ...minimal.slice(0, start),
        ...minimal.slice(start + size),
      ];

      if (accepts(candidate)) {
        minimal = candidate;
      } else {
        start += 1;
      }
    }
  }

  let changed = true;

  while (changed && attempts < budget) {
    changed = false;

    for (
      let index = 0;
      index < minimal.length && attempts < budget;
      index += 1
    ) {
      const candidate = minimal.filter((_, i) => i !== index);

      if (accepts(candidate)) {
        minimal = candidate;
        changed = true;
        break;
      }

      const action = minimal[index];

      if (!action) {
        throw new Error("Missing action in shrink history");
      }

      for (const value of simpler(action)) {
        const innerCandidate = clone(minimal);
        innerCandidate[index] = value;

        if (accepts(innerCandidate)) {
          minimal = innerCandidate;
          changed = true;
          break;
        }

        if (attempts >= budget) {
          break;
        }
      }

      if (changed) {
        break;
      }
    }
  }

  return {
    minimalHistory: minimal,
    attempts,
    budgetExhausted: attempts >= budget,
    minimality:
      !changed && attempts < budget
        ? "single-deletion-and-listed-values"
        : "budget-limited",
    replay: replayData(minimal, mutant),
  };
}

function provenance() {
  const digest = (path: string) =>
    createHash("sha256")
      .update(readFileSync(new URL(path, import.meta.url)))
      .digest("hex");

  return {
    id: "reference-interpreter/0",
    source: "prototype/engine.ts",
    sha256: digest("./engine.ts"),
    modelSha256: digest("./model.ts"),
    adapterSha256: digest("./property.ts"),
    node: process.version,
    generator: VERSION,
    prng: "mulberry32-u32/1",
    oracle: "independent-snapshot-state-machine/1",
  };
}

/** Purely in-memory, synchronous sampled check. Infrastructure errors throw, never become passes. */
export function runProperties(options: PropertyOptions = {}) {
  const seed = integer("seed", options.seed ?? 0x5e_ed, 0, 0xff_ff_ff_ff);
  const samples = integer("samples", options.samples ?? 200, 1, 10_000);
  const maxSteps = integer("maxSteps", options.maxSteps ?? 32, 1, 1000);

  const shrinkBudget = integer(
    "shrinkBudget",
    options.shrinkBudget ?? 2000,
    0,
    100_000
  );

  const mutant = options.staleApprovalMutant ?? false;

  if (typeof mutant !== "boolean") {
    throw new TypeError("staleApprovalMutant must be boolean");
  }

  const next = random(seed);

  const failures: ({
    sample: number;
    sampleSeed: number;
    originalHistory: Action[];
    originalFailure: NonNullable<ReturnType<typeof replayHistory>["failure"]>;
    minimized: ReturnType<typeof replayHistory>;
  } & ReturnType<typeof shrinkHistory>)[] = [];

  const actions: Record<string, number> = {};

  const coverage = {
    steps: 0,
    executes: 0,
    commits: 0,
    approvalRequiredCommits: 0,
    staleRejections: 0,
    actions,
  };

  for (let sample = 0; sample < samples; sample += 1) {
    const sampleSeed = next();
    const history = generateHistory(sampleSeed, maxSteps);
    const observed = replayHistory(replayData(history, mutant));

    for (const key of [
      "steps",
      "executes",
      "commits",
      "approvalRequiredCommits",
      "staleRejections",
    ] as const) {
      coverage[key] += observed.coverage[key];
    }

    for (const action of history.slice(0, observed.coverage.steps)) {
      coverage.actions[action.kind] = (coverage.actions[action.kind] ?? 0) + 1;
    }

    if (observed.failure) {
      const shrunk = shrinkHistory(history, mutant, shrinkBudget);
      failures.push({
        sample,
        sampleSeed,
        originalHistory: history,
        originalFailure: observed.failure,
        ...shrunk,
        minimized: replayHistory(shrunk.replay),
      });
    }
  }

  return {
    format: "approval-property-report/1",
    method: "seeded-generated-action-histories",
    result: failures.length ? "counterexample" : "sampled_pass",
    property: "L2/current-approval-snapshot/1",
    seed,
    sampleCount: samples,
    skipped: 0,
    bounds: {
      maxSteps,
      shrinkBudget,
      clock: CLOCK,
      initialState:
        "prototype model and one high-priority open ticket; no invocation",
      roles: [...roles],
      priorities: [...priorities],
      decisions: [...decisions],
      summaries: [...summaries],
      actorIds: ["actor-1", "actor-2"],
      revisionAndVersionValues: [0, 1, 2, 3],
      watcherValues: [[], ["user-1"], ["user-2", "user-2"]],
      resourceFields: ["version", "priority", "watchers"],
    },
    staleApprovalMutant: mutant,
    engine: provenance(),
    coverage,
    failures,
    assumptions: [
      "One synchronous in-memory ticket/invocation",
      "Trusted actor roles and explicit harness edits",
      "Whole-model and whole-ticket conservative snapshot binding",
      "No external effects, scheduling or formal proof",
    ],
  };
}

// CLI intentionally separate from import: no files are written by runProperties().
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const options: PropertyOptions = {};
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];

    if (flag === "--mutant") {
      options.staleApprovalMutant = true;
      continue;
    }

    const names: Readonly<
      Record<string, keyof Omit<PropertyOptions, "staleApprovalMutant">>
    > = {
      "--seed": "seed",
      "--samples": "samples",
      "--max-steps": "maxSteps",
      "--shrink-budget": "shrinkBudget",
    };

    const value = args[i + 1];

    const option =
      flag !== undefined && Object.hasOwn(names, flag)
        ? names[flag]
        : undefined;

    if (!option || value === undefined || value.trim() === "") {
      throw new Error(`Invalid argument: ${flag}`);
    }

    options[option] = Number(value);
    i += 1;
  }

  const report = runProperties(options);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/property-report.json",
    `${JSON.stringify(report, null, 2)}\n`
  );
  console.log(
    `${report.result}: ${report.sampleCount} sampled histories, ${report.failures.length} failures. Wrote artifacts/property-report.json`
  );

  if (report.failures.length) {
    process.exitCode = 1;
  }
}
