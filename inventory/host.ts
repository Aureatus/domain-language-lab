import { createInterpreter, validateState } from "../semantic/core.ts";
import type {
  Committed,
  Event,
  Invocation,
  Preparation,
  Prepared,
  State,
} from "../semantic/core.ts";
import { inventoryModel, initialState, invocation } from "./model.ts";
import { inspectInventory } from "./oracle.ts";

const HOST_VERSION = "inventory-host/v1";

type Operation =
  | { type: "prepare"; token: string; invocation: Invocation }
  | { type: "commit"; token: string; mutant?: boolean }
  | { type: "execute"; invocation: Invocation };

function isOperation(operation: unknown): operation is Operation {
  if (!operation || typeof operation !== "object" || !("type" in operation)) {
    return false;
  }

  if (operation.type === "commit") {
    return (
      "token" in operation &&
      typeof operation.token === "string" &&
      (!("mutant" in operation) || typeof operation.mutant === "boolean")
    );
  }

  if (operation.type !== "prepare" && operation.type !== "execute") {
    return false;
  }

  if (
    operation.type === "prepare" &&
    (!("token" in operation) || typeof operation.token !== "string")
  ) {
    return false;
  }

  const invocation =
    "invocation" in operation ? operation.invocation : undefined;

  return (
    !!invocation &&
    typeof invocation === "object" &&
    "id" in invocation &&
    typeof invocation.id === "string" &&
    "action" in invocation &&
    typeof invocation.action === "string" &&
    "actor" in invocation &&
    typeof invocation.actor === "string" &&
    "clock" in invocation &&
    typeof invocation.clock === "number" &&
    "args" in invocation &&
    !!invocation.args &&
    typeof invocation.args === "object" &&
    !Array.isArray(invocation.args) &&
    Object.values(invocation.args).every(
      (v: unknown) =>
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        (Array.isArray(v) && v.every((x) => typeof x === "string"))
    )
  );
}

type Observation = {
  status: Preparation["status"] | Committed["status"];
  code?: string;
  reason?: string;
  revision: number;
  oracle: ReturnType<typeof inspectInventory>;
  events: Event[];
};

type Step = { operation: Operation; observation: Observation };

interface ReplayBundle {
  format: string;
  host: string;
  model: unknown;
  initial: unknown;
  steps: readonly unknown[];
  final: unknown;
}

export function createHost(
  modelSource: unknown = inventoryModel,
  initialSource: unknown = initialState
) {
  const runtime = createInterpreter(modelSource);

  const tokens = new Map<
    string,
    { token: Prepared; snapshot: State; invocation: Invocation }
  >();

  const steps: Step[] = [];
  const accepted: Invocation[] = [];
  const events: Event[] = [];

  const usedIds = new Set<string>();

  const model = runtime.model;
  const initial = validateState(model, initialSource);

  let state = initial;

  function step(operation: Operation): Observation {
    let result: Preparation | Committed;

    if (
      (operation.type === "prepare" || operation.type === "execute") &&
      usedIds.has(operation.invocation.id)
    ) {
      result = {
        status: "rejected",
        code: "invalid",
        reason: "duplicate-invocation",
        state,
      };
    } else if (operation.type === "prepare") {
      usedIds.add(operation.invocation.id);
      result = runtime.prepare(state, operation.invocation);

      if (result.status === "prepared") {
        tokens.set(operation.token, {
          token: result.prepared,
          snapshot: state,
          invocation: operation.invocation,
        });
      }
    } else if (operation.type === "commit") {
      const saved = tokens.get(operation.token);

      if (!saved) {
        throw new Error("Unknown preparation token");
      }

      result = runtime.commit(
        operation.mutant ? saved.snapshot : state,
        saved.token
      );

      if (result.status === "committed") {
        accepted.push(saved.invocation);
      }
    } else if (operation.type === "execute") {
      usedIds.add(operation.invocation.id);
      result = runtime.execute(state, operation.invocation);

      if (result.status === "committed") {
        accepted.push(operation.invocation);
      }
    } else {
      throw new Error("Unsupported host operation");
    }

    if (result.status === "committed") {
      state = result.state;
      events.push(...result.events);
    }

    const observation = {
      status: result.status,
      ...(result.status === "rejected" && result.code
        ? { code: result.code, reason: result.reason }
        : {}),
      revision: state.revision,
      oracle: inspectInventory(state, accepted),
      events: result.status === "committed" ? result.events : [],
    };

    steps.push({ operation: structuredClone(operation), observation });

    return observation;
  }

  return {
    step,
    get state() {
      return state;
    },
    get steps() {
      return steps;
    },
    get events() {
      return events;
    },
    get oracle() {
      return inspectInventory(state, accepted);
    },
    export() {
      return {
        format: "inventory-replay/v1",
        host: HOST_VERSION,
        model,
        initial,
        steps: structuredClone(steps),
        final: state,
      };
    },
  };
}

export function replay(bundle: ReplayBundle) {
  if (bundle.format !== "inventory-replay/v1" || bundle.host !== HOST_VERSION) {
    throw new Error("Unsupported replay");
  }

  const host = createHost(bundle.model, bundle.initial);

  for (const row of bundle.steps) {
    if (
      !row ||
      typeof row !== "object" ||
      !("operation" in row) ||
      !("observation" in row)
    ) {
      throw new Error("Invalid replay step");
    }

    const { operation, observation } = row;

    if (!isOperation(operation)) {
      throw new Error("Invalid replay operation");
    }

    const actual = host.step(operation);

    if (JSON.stringify(actual) !== JSON.stringify(observation)) {
      throw new Error("Replay observation mismatch");
    }
  }

  if (JSON.stringify(host.state) !== JSON.stringify(bundle.final)) {
    throw new Error("Replay final mismatch");
  }

  return host;
}

export function competition(mutant = false, order = ["A", "B"]) {
  const host = createHost();

  for (const name of ["A", "B"]) {
    host.step({
      type: "prepare",
      token: name,
      invocation: invocation(
        `race${name}`,
        "reserve",
        `slot${name}`,
        name === "A" ? "alice" : "bob"
      ),
    });
  }

  for (const token of order) {
    host.step({ type: "commit", token, mutant });
  }

  if (!mutant) {
    const loser = order[1];
    host.step({
      type: "execute",
      invocation: invocation(
        `retry${loser}`,
        "reserve",
        `slot${loser}`,
        loser === "A" ? "alice" : "bob"
      ),
    });
    host.step({
      type: "execute",
      invocation: invocation(
        `fit${loser}`,
        "reserve",
        `slot${loser}`,
        loser === "A" ? "alice" : "bob",
        10,
        2
      ),
    });
  }

  return host;
}
