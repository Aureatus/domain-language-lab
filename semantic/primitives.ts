import type { Invocation, InvocationInput } from "./types.ts";
import type { Expr, FieldSchema, Scalar } from "./v2/types.ts";

export const own = <T extends object>(o: T, k: PropertyKey) =>
  Object.hasOwn(o, k);

export function ownValue<T>(
  table: Readonly<Record<string, T>> | undefined,
  key: unknown
): T | undefined {
  return table !== undefined &&
    typeof key === "string" &&
    Object.hasOwn(table, key)
    ? table[key]
    : undefined;
}

export const obj = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);

export function fail(code: string, message?: string): never {
  throw Object.assign(new Error(message), { code });
}

export function assert(
  p: unknown,
  message: string | undefined,
  code = "invalid"
): asserts p {
  if (!p) {
    fail(code, message);
  }
}

export const safeKey = (k: unknown): k is string =>
  typeof k === "string" &&
  /^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(k) &&
  !["__proto__", "constructor", "prototype"].includes(k);

export function keys(
  x: unknown,
  names: readonly string[]
): Record<string, unknown> {
  assert(
    obj(x) &&
      Object.keys(x).length === names.length &&
      names.every((k) => own(x, k)),
    `Expected exactly ${names.join(", ")}`
  );

  return x;
}

export const canonical = (x: unknown): string =>
  Array.isArray(x)
    ? `[${x.map(canonical).join(",")}]`
    : obj(x)
      ? `{${Object.keys(x)
          .toSorted()
          .map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`)
          .join(",")}}`
      : JSON.stringify(x);

const types = new Set(["integer", "string", "boolean", "ids"]);

function schema(s: unknown) {
  assert(
    obj(s) && typeof s["type"] === "string" && types.has(s["type"]),
    "Unsupported schema"
  );

  const allowed =
    s["type"] === "integer"
      ? ["type", "min", "max"]
      : s["type"] === "string"
        ? ["type", "enum"]
        : ["type"];

  assert(
    Object.keys(s).every((k) => allowed.includes(k)),
    "Unknown schema member"
  );

  const { min } = s;
  const { max } = s;
  const choices = s["enum"];

  if (own(s, "min")) {
    assert(
      typeof min === "number" && Number.isSafeInteger(min),
      "Invalid minimum"
    );
  }

  if (own(s, "max")) {
    assert(
      typeof max === "number" && Number.isSafeInteger(max),
      "Invalid maximum"
    );
  }

  if (typeof min === "number" && typeof max === "number") {
    assert(min <= max, "Inverted bounds");
  }

  if (own(s, "enum")) {
    assert(
      Array.isArray(choices) &&
        choices.length > 0 &&
        choices.every((x) => typeof x === "string") &&
        new Set(choices).size === choices.length,
      "Invalid enum"
    );
  }
}

export function value(
  s: FieldSchema,
  x: unknown
): asserts x is Scalar | string[] {
  const valid =
    s.type === "integer"
      ? typeof x === "number" &&
        Number.isSafeInteger(x) &&
        !Object.is(x, -0) &&
        (s.min === undefined || x >= s.min) &&
        (s.max === undefined || x <= s.max)
      : s.type === "string"
        ? typeof x === "string" && (!s.enum || s.enum.includes(x))
        : s.type === "boolean"
          ? typeof x === "boolean"
          : Array.isArray(x) &&
            x.every((id) => typeof id === "string" && safeKey(id));

  assert(valid, `Value violates ${s.type} schema`, "schema");
}

export function fields(o: unknown) {
  assert(obj(o), "Expected field map");

  for (const item of Object.values(o)) {
    schema(item);
  }
}

function checkArgs(
  inputs: Readonly<Record<string, FieldSchema>>,
  args: unknown
): asserts args is Invocation["args"] {
  const record = keys(args, Object.keys(inputs));

  for (const [name, spec] of Object.entries(inputs)) {
    value(spec, record[name]);
  }
}

export function checkInvocation<
  A extends { inputs: Readonly<Record<string, FieldSchema>> },
>(
  actions: Readonly<Record<string, A>>,
  input: InvocationInput,
  invalidIdentity: string
): { a: A; inv: Invocation } {
  keys(input, ["id", "action", "args", "actor", "clock"]);
  assert(
    safeKey(input.id) &&
      safeKey(input.actor) &&
      Number.isSafeInteger(input.clock) &&
      input.clock >= 0,
    invalidIdentity
  );
  const a = ownValue(actions, input.action);
  assert(a, "Unknown action");
  const { args } = input;
  checkArgs(a.inputs, args);

  return { a, inv: { ...input, args } };
}

export type Kind = FieldSchema["type"];

export const binary: Readonly<Record<string, readonly [Kind, Kind]>> = {
  add: ["integer", "integer"],
  sub: ["integer", "integer"],
  lt: ["integer", "boolean"],
  le: ["integer", "boolean"],
  and: ["boolean", "boolean"],
  or: ["boolean", "boolean"],
};

interface EvalContext<V> {
  inv: { args: Readonly<Record<string, V>>; actor: string; clock: number };
  bound: ReadonlyMap<
    string,
    { record: { values: Readonly<Record<string, V>> } }
  >;
}

export function evaluate<V extends Scalar | readonly string[]>(
  e: Expr,
  ctx: EvalContext<V>
): Scalar | V {
  if (e.op === "literal") {
    return e.value;
  }

  if (e.op === "input") {
    const arg = ownValue(ctx.inv.args, e.name);
    assert(arg !== undefined, "Missing input");

    return arg;
  }

  if (e.op === "actor") {
    return ctx.inv.actor;
  }

  if (e.op === "clock") {
    return ctx.inv.clock;
  }

  if (e.op === "field") {
    const field = ownValue(ctx.bound.get(e.binding)?.record.values, e.field);
    assert(field !== undefined, "Missing bound field");

    return field;
  }

  if (e.op === "not") {
    return !evaluate(e.value, ctx);
  }

  assert("left" in e && "right" in e, "Missing binary operands");

  const l = evaluate(e.left, ctx);
  const r = evaluate(e.right, ctx);

  switch (e.op) {
    case "add":
    case "sub": {
      assert(
        typeof l === "number" && typeof r === "number",
        "Expected integer operands"
      );
      const n = e.op === "add" ? BigInt(l) + BigInt(r) : BigInt(l) - BigInt(r);
      assert(
        n >= -9_007_199_254_740_991n && n <= 9_007_199_254_740_991n,
        "Integer overflow",
        "overflow"
      );

      return Number(n);
    }

    case "eq": {
      return l === r;
    }

    case "lt":
    case "le": {
      assert(
        typeof l === "number" && typeof r === "number",
        "Expected integer operands"
      );

      return e.op === "lt" ? l < r : l <= r;
    }

    case "and": {
      return l && r;
    }

    case "or": {
      return l || r;
    }

    default: {
      fail("unsupported", "Unknown expression");
    }
  }
}

export const increment = (x: number) => {
  assert(x < Number.MAX_SAFE_INTEGER, "Version overflow", "overflow");

  return x + 1;
};

export function checkRecords(
  records: Readonly<Record<string, unknown>>,
  innerFields: Readonly<Record<string, FieldSchema>>
) {
  for (const record of Object.values(records)) {
    const { version, values } = keys(record, ["version", "values"]);
    assert(
      typeof version === "number" &&
        Number.isSafeInteger(version) &&
        version >= 0,
      "Invalid record version"
    );
    const entries = keys(values, Object.keys(innerFields));

    for (const [field, spec] of Object.entries(innerFields)) {
      value(spec, entries[field]);
    }
  }
}

interface Observation {
  readonly binding: string;
  readonly relationship: string;
}

interface Path {
  relationship: string;
  resource: string;
  key: string;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function routeRecipients(
  observations: readonly Observation[],
  actor: string,
  resolve: (observation: Observation) => { path: Path; raw: unknown }
) {
  const recipients = new Map<string, Map<string, Path>>();

  for (const observation of observations) {
    const { path, raw } = resolve(observation);

    for (const recipient of Array.isArray(raw) ? raw : [raw]) {
      if (!safeKey(recipient)) {
        fail("routing", "Invalid relationship recipient");
      }

      if (recipient === actor) {
        continue;
      }

      let paths = recipients.get(recipient);

      if (!paths) {
        paths = new Map();
        recipients.set(recipient, paths);
      }

      paths.set(canonical(path), path);
    }
  }

  return [...recipients]
    .toSorted(([a], [b]) => compare(a, b))
    .map(([recipient, paths]) => ({
      recipient,
      paths: [...paths.values()].toSorted((a, b) =>
        compare(canonical(a), canonical(b))
      ),
    }));
}
