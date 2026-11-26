/** semantic-core/v1: browser-safe, data-only, bounded reference interpreter. */
import { errorMessage } from "../errors.ts";
import {
  assert,
  binary,
  canonical,
  checkInvocation,
  checkRecords,
  evaluate,
  fail,
  fields,
  increment,
  keys,
  obj,
  own,
  ownValue,
  routeRecipients,
  safeKey,
  value,
} from "./primitives.ts";
import type { Kind } from "./primitives.ts";
import type {
  Committed,
  Event,
  Expr,
  Interpreter,
  InvocationInput,
  Model,
  Preparation,
  Prepared,
  Rejected,
  State,
} from "./types.ts";

export type * from "./types.ts";

type Patch = Pick<
  Extract<Event, { kind: "change" }>,
  "semanticId" | "resource" | "key" | "field" | "before" | "after"
>;

type Snapshot = State["records"][string][string];

type Bound = { resource: string; key: string; record: Snapshot };

type Token = { readonly kind: "semantic-prepared/v1" };

type Plan = { before: string; state: State; events: Event[] };

export { ownValue };

const freeze = <T>(x: T): T => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }

  return x;
};

/** Reject accessors, cycles, exotic objects, sparse arrays and non-safe JSON numbers. */
export function jsonSnapshot<T>(value: T): T {
  let nodes = 0;
  const seen = new Set<object>();

  function visit(x: unknown, depth: number): unknown {
    assert(++nodes <= 100000 && depth <= 40, "JSON complexity limit");

    if (x === null || typeof x === "boolean") {
      return x;
    }

    if (typeof x === "string") {
      assert(x.length <= 100000, "String limit");

      return x;
    }

    if (typeof x === "number") {
      assert(
        Number.isSafeInteger(x) && !Object.is(x, -0),
        "Expected safe integer"
      );

      return x;
    }

    assert(x && typeof x === "object" && !seen.has(x), "Expected acyclic JSON");
    const array = Array.isArray(x);
    assert(
      array || [Object.prototype, null].includes(Object.getPrototypeOf(x)),
      "Expected plain JSON"
    );
    const names = Reflect.ownKeys(x).filter((k) => !(array && k === "length"));
    assert(
      !array ||
        (names.length === x.length && names.every((k, i) => k === String(i))),
      "Expected dense array"
    );
    seen.add(x);
    const result: unknown[] | Record<string, unknown> = array ? [] : {};

    for (const k of names) {
      const d = Object.getOwnPropertyDescriptor(x, k);
      assert(
        typeof k === "string" &&
          d?.enumerable &&
          own(d, "value") &&
          (array || safeKey(k)),
        "Unsafe JSON property"
      );
      const child = visit(d.value, depth + 1);

      if (Array.isArray(result)) {
        result[Number(k)] = child;
      } else {
        result[k] = child;
      }
    }

    seen.delete(x);

    return result;
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- The walker copies every permitted value and key without coercion.
  return freeze(visit(value, 0)) as T;
}

/** Validate the entire declaration, including unreachable expressions. Returns frozen JSON. */
export function validateModel(source: unknown): Model {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- The checks below validate the frozen declaration before returning it.
  const m = jsonSnapshot(source) as Model;
  keys(m, ["format", "id", "resources", "relationships", "actions"]);
  assert(m.format === "semantic-core/v1", "Unsupported semantic profile");
  const ids = new Set<string>();

  const id = (x: unknown) => {
    assert(safeKey(x) && !ids.has(x), `Invalid/duplicate semantic ID: ${x}`);
    ids.add(x);
  };

  id(m.id);
  assert(
    obj(m.resources) && obj(m.actions) && Array.isArray(m.relationships),
    "Invalid model collections"
  );

  for (const [rid, r] of Object.entries(m.resources)) {
    id(rid);
    keys(r, ["fields"]);
    fields(r.fields);
  }

  const relationships = new Map<string, Model["relationships"][number]>();

  for (const r of m.relationships) {
    keys(r, ["id", "resource", "field"]);
    id(r.id);
    const spec = ownValue(ownValue(m.resources, r.resource)?.fields, r.field);
    assert(
      spec && (spec.type === "string" || spec.type === "ids"),
      "Invalid relationship field"
    );
    relationships.set(r.id, r);
  }

  for (const [aid, a] of Object.entries(m.actions)) {
    id(aid);
    keys(a, [
      "inputs",
      "bindings",
      "preconditions",
      "policies",
      "updates",
      "observe",
    ]);
    fields(a.inputs);

    const collections: readonly (keyof Omit<typeof a, "inputs">)[] = [
      "bindings",
      "preconditions",
      "policies",
      "updates",
      "observe",
    ];

    for (const k of collections) {
      assert(Array.isArray(a[k]), `Expected ${k} array`);
    }

    const bindings = new Map<string, string>();

    function type(e: Expr, allowFields = true): Kind {
      assert(obj(e) && typeof e.op === "string", "Invalid expression");

      if (e.op === "literal") {
        keys(e, ["op", "value"]);
        const t = typeof e.value;
        assert(
          t === "string" || t === "number" || t === "boolean",
          "Unsupported literal"
        );

        return t === "number" ? "integer" : t;
      }

      if (e.op === "input") {
        keys(e, ["op", "name"]);
        const spec = ownValue(a.inputs, e.name);
        assert(spec, "Unknown input");

        return spec.type;
      }

      if (e.op === "actor" || e.op === "clock") {
        keys(e, ["op"]);

        return e.op === "actor" ? "string" : "integer";
      }

      if (e.op === "field") {
        keys(e, ["op", "binding", "field"]);

        const spec = ownValue(
          ownValue(m.resources, bindings.get(e.binding))?.fields,
          e.field
        );

        assert(allowFields && spec, "Unknown field binding");

        return spec.type;
      }

      if (e.op === "eq") {
        keys(e, ["op", "left", "right"]);
        const t = type(e.left, allowFields);
        assert(
          t !== "ids" && t === type(e.right, allowFields),
          "Equality type mismatch"
        );

        return "boolean";
      }

      if (e.op === "not") {
        keys(e, ["op", "value"]);
        assert(type(e.value, allowFields) === "boolean", "Unary type mismatch");

        return "boolean";
      }

      const operator = ownValue(binary, e.op);
      assert(operator, `Unsupported operator ${e.op}`);
      keys(e, ["op", "left", "right"]);
      const [input, output] = operator;
      assert("left" in e && "right" in e, "Missing binary operands");
      assert(
        type(e.left, allowFields) === input &&
          type(e.right, allowFields) === input,
        "Binary type mismatch"
      );

      return output;
    }

    for (const b of a.bindings) {
      keys(b, ["id", "resource", "key"]);
      id(b.id);
      assert(
        own(m.resources, b.resource) && type(b.key, false) === "string",
        "Invalid record binding"
      );
      bindings.set(b.id, b.resource);
    }

    for (const p of a.preconditions) {
      keys(p, ["id", "when"]);
      id(p.id);
      assert(type(p.when) === "boolean", "Precondition must be boolean");
    }

    for (const p of a.policies) {
      keys(p, ["id", "when", "effect"]);
      id(p.id);
      assert(
        ["allow", "deny", "approval-required"].includes(p.effect) &&
          type(p.when) === "boolean",
        "Invalid policy"
      );
    }

    for (const u of a.updates) {
      keys(u, ["id", "target", "field", "value"]);
      id(u.id);

      const spec = ownValue(
        ownValue(m.resources, bindings.get(u.target))?.fields,
        u.field
      );

      assert(spec && type(u.value) === spec.type, "Update type mismatch");
    }

    for (const o of a.observe) {
      keys(o, ["binding", "relationship"]);
      const relationship = relationships.get(o.relationship);
      assert(
        relationship && bindings.get(o.binding) === relationship.resource,
        "Invalid observation"
      );
    }
  }

  return m;
}

export function validateState(model: Model, source: unknown): State {
  return checkState(validateModel(model), source);
}

function checkState(model: Model, source: unknown): State {
  const s = jsonSnapshot(source);
  assertState(model, s);

  return s;
}

function assertState(model: Model, s: unknown): asserts s is State {
  const { revision, records } = keys(s, ["revision", "records"]);
  assert(
    typeof revision === "number" &&
      Number.isSafeInteger(revision) &&
      revision >= 0,
    "Invalid revision"
  );
  assert(
    obj(records) &&
      Object.keys(records).length === Object.keys(model.resources).length,
    "Resource collection mismatch"
  );

  for (const [rid, r] of Object.entries(model.resources)) {
    const collection = ownValue(records, rid);
    assert(collection && obj(collection), "Missing resource collection");
    checkRecords(collection, r.fields);
  }
}

const rejection = (state: State, error: unknown): Rejected =>
  Object.freeze({
    status: "rejected",
    code:
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "invalid",
    reason: errorMessage(error),
    state,
  });

/** Tokens are opaque interpreter-owned capabilities, not serializable commands. */
export function createInterpreter(source: unknown): Readonly<Interpreter> {
  const model = validateModel(source);
  const tokens = new WeakMap<Token, Plan>();

  const isPrepared = (token: Token): token is Prepared => tokens.has(token);
  const relations = new Map(model.relationships.map((r) => [r.id, r]));

  function prepare(state: State, invocation: InvocationInput): Preparation {
    try {
      const before = checkState(model, state);
      const input = jsonSnapshot(invocation);

      const { a, inv } = checkInvocation(
        model.actions,
        input,
        "Invalid invocation identity/clock"
      );

      const bound = new Map<string, Bound>();
      const ctx = { inv, bound };

      for (const b of a.bindings) {
        const key = evaluate(b.key, ctx);
        const record = ownValue(ownValue(before.records, b.resource), key);

        assert(
          safeKey(key) && record,
          "Missing bound record",
          "missing-record"
        );
        bound.set(b.id, { resource: b.resource, key, record });
      }

      const matches = a.policies.filter((p) => evaluate(p.when, ctx));

      if (
        matches.some((p) => p.effect === "deny") ||
        !matches.some(
          (p) => p.effect === "allow" || p.effect === "approval-required"
        )
      ) {
        fail("denied", "Policy denied");
      }

      const failed = a.preconditions.find((p) => !evaluate(p.when, ctx));

      if (failed) {
        fail("precondition", failed.id);
      }

      if (matches.some((p) => p.effect === "approval-required")) {
        return Object.freeze({
          status: "pending",
          policyIds: Object.freeze(
            matches
              .filter((p) => p.effect === "approval-required")
              .map((p) => p.id)
          ),
          state,
        });
      }

      // Every RHS reads ctx.bound, which contains only immutable prestate records.
      const patches: Patch[] = [];
      const writes = new Set();

      for (const u of a.updates) {
        const b = bound.get(u.target);
        assert(b, "Missing update binding");
        const address = JSON.stringify([b.resource, b.key, u.field]);
        assert(
          !writes.has(address),
          "Aliased grouped write",
          "conflicting-update"
        );
        writes.add(address);

        const spec = ownValue(
          ownValue(model.resources, b.resource)?.fields,
          u.field
        );

        assert(spec, "Unknown update field");
        const next = evaluate(u.value, ctx);
        value(spec, next);
        const prior = ownValue(b.record.values, u.field);
        assert(prior !== undefined, "Missing update field");
        patches.push({
          semanticId: u.id,
          resource: b.resource,
          key: b.key,
          field: u.field,
          before: prior,
          after: next,
        });
      }

      const candidate: State = JSON.parse(JSON.stringify(before));
      const touched = new Set<string>();

      for (const p of patches) {
        const r = ownValue(ownValue(candidate.records, p.resource), p.key);
        assert(r, "Missing candidate record");
        r.values[p.field] = p.after;
        const address = JSON.stringify([p.resource, p.key]);

        if (!touched.has(address)) {
          r.version = increment(r.version);
          touched.add(address);
        }
      }

      candidate.revision = increment(candidate.revision);
      const nextState = checkState(model, candidate);

      const routing = routeRecipients(a.observe, inv.actor, (o) => {
        const b = bound.get(o.binding);
        const r = relations.get(o.relationship);

        assert(b && r, "Missing observation declaration", "routing");
        const record = ownValue(ownValue(nextState.records, b.resource), b.key);
        assert(record, "Missing observation record", "routing");

        return {
          path: { relationship: r.id, resource: b.resource, key: b.key },
          raw: ownValue(record.values, r.field),
        };
      });

      const eventBase = {
        modelId: model.id,
        actionId: inv.action,
        invocationId: inv.id,
        actor: inv.actor,
        clock: inv.clock,
        revision: nextState.revision,
        recipients: routing,
      };

      const eventPrefix = `event:${encodeURIComponent(inv.id)}`;

      const events: Event[] = [
        {
          ...eventBase,
          id: `${eventPrefix}:action`,
          kind: "action",
          semanticId: inv.action,
        },
        ...patches
          .filter((p) => canonical(p.before) !== canonical(p.after))
          .map((p): Event => ({
            ...eventBase,
            id: `${eventPrefix}:change:${encodeURIComponent(p.semanticId)}`,
            kind: "change",
            ...p,
          })),
      ];

      const token: Token = freeze({ kind: "semantic-prepared/v1" });
      tokens.set(token, {
        before: canonical(before),
        state: nextState,
        events: jsonSnapshot(events),
      });
      assert(isPrepared(token), "Unregistered preparation token");

      return freeze({ status: "prepared", prepared: token });
    } catch (error) {
      return rejection(state, error);
    }
  }

  function commit(state: State, token: Token): Committed | Rejected {
    try {
      const plan = tokens.get(token);
      assert(plan, "Foreign or serialized token", "invalid-token");
      const current = checkState(model, state);
      assert(
        canonical(current) === plan.before,
        "Prestate changed; prepare again",
        "stale"
      );

      return freeze({
        status: "committed",
        state: plan.state,
        events: plan.events,
      });
    } catch (error) {
      return rejection(state, error);
    }
  }

  return Object.freeze({
    model,
    prepare,
    commit,
    execute(state: State, inv: InvocationInput) {
      const p = prepare(state, inv);

      return p.status === "prepared" ? commit(state, p.prepared) : p;
    },
  });
}
