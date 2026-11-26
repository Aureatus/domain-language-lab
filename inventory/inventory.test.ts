import assert from "node:assert/strict";
import test from "node:test";

import { present } from "../semantic/test-support.ts";
import { createHost, competition, replay } from "./host.ts";
import { runtime, inventoryModel, initialState, invocation } from "./model.ts";
import { inspectInventory } from "./oracle.ts";

const run = (
  host: ReturnType<typeof createHost>,
  command: ReturnType<typeof invocation>
) => host.step({ type: "execute", invocation: command });

test("reserve is grouped, routed and conserved; cancel returns stock", () => {
  const h = createHost();
  const r = run(h, invocation("reserveA", "reserve"));
  assert.equal(r.status, "committed");
  assert.equal(
    present(present(h.state.records["stock"])["camera"]).values["available"],
    2
  );
  assert.equal(
    present(present(h.state.records["reservation"])["slotA"]).values[
      "quantity"
    ],
    3
  );
  assert.equal(
    present(present(h.state.records["reservation"])["slotA"]).version,
    1
  );
  assert.equal(r.events.length, 5);
  assert.deepEqual(
    present(r.events[0]).recipients.map((entry2) => entry2.recipient),
    ["bob", "warehouse"]
  );
  const cancelled = run(h, invocation("cancelA", "cancel"));
  assert.equal(cancelled.status, "committed");
  assert.equal(
    present(present(h.state.records["stock"])["camera"]).values["available"],
    5
  );
  assert.ok(h.oracle.ok);
  assert.equal(
    run(h, invocation("cancelAgain", "cancel")).code,
    "precondition"
  );
});

test("expiry boundary is inclusive; owner receives operator event with both supporting paths", () => {
  const h = createHost();
  run(h, invocation("reserveA", "reserve"));
  const before = h.state;
  assert.equal(
    run(h, invocation("early", "expire", "slotA", "warehouse", 29)).code,
    "precondition"
  );
  assert.equal(h.state, before);
  const r = run(h, invocation("boundary", "expire", "slotA", "warehouse", 30));
  assert.equal(r.status, "committed");
  assert.ok(h.oracle.ok);
  assert.equal(
    present(
      present(r.events[0]).recipients.find(
        (entry) => entry.recipient === "alice"
      )
    ).paths.length,
    2
  );
  assert.equal(
    present(present(h.state.records["reservation"])["slotA"]).values["status"],
    "expired"
  );
});

test("all ownership policies reject atomically, including expiration by owner", () => {
  for (const kind of ["reserve", "cancel", "expire"]) {
    const h = createHost();

    if (kind !== "reserve") {
      run(h, invocation("seed", "reserve"));
    }

    const before = h.state;
    const events = h.events.length;

    const r = run(
      h,
      invocation(
        `deny${kind}`,
        kind,
        "slotA",
        kind === "expire" ? "alice" : "bob",
        30
      )
    );

    assert.equal(r.code, "denied");
    assert.equal(h.state, before);
    assert.deepEqual(r.events, []);
    assert.equal(h.events.length, events);
  }
});

test("invalid quantities, clock, expiry, slot/stock pairing and capacity reject unchanged", () => {
  const bad = [
    invocation("zero", "reserve", "slotA", "alice", 10, 0),
    invocation("fraction", "reserve", "slotA", "alice", 10, 1.5),
    invocation("full", "reserve", "slotA", "alice", 10, 6),
    invocation("past", "reserve", "slotA", "alice", 30, 1, 30),
    invocation("clock", "reserve", "slotA", "alice", -1),
    invocation("missing", "reserve", "unknown"),
  ];

  for (const inv of bad) {
    const result = runtime.execute(initialState, inv);
    assert.equal(result.status, "rejected");
    assert.equal(result.state, initialState);
    assert.equal("events" in result, false);
  }

  const paired = structuredClone(initialState);
  present(present(paired.records["reservation"])["slotA"]).values["stockId"] =
    "other";
  const pair = runtime.execute(paired, invocation("pair", "reserve"));
  assert.equal(pair.status, "rejected");
  assert.equal(pair.code, "precondition");
});

test("late grouped failure and bad routing never partially publish", () => {
  const overflow = structuredClone(initialState);
  present(present(overflow.records["reservation"])["slotA"]).version =
    Number.MAX_SAFE_INTEGER;
  const r = runtime.execute(overflow, invocation("overflow", "reserve"));
  assert.equal(r.status, "rejected");
  assert.equal(r.code, "overflow");
  assert.equal(r.state, overflow);
  assert.equal(
    present(present(overflow.records["stock"])["camera"]).values["available"],
    5
  );
  const bad = structuredClone(initialState);
  present(present(bad.records["stock"])["camera"]).values["watchers"] = [
    "not an id",
  ];
  assert.equal(
    runtime.execute(bad, invocation("badRoute", "reserve")).status,
    "rejected"
  );
  assert.equal(bad.revision, 0);
});

test("both competing commit orders reject stale; retry 3 rejects, retry 2 fits", () => {
  for (const order of [
    ["A", "B"],
    ["B", "A"],
  ]) {
    const h = competition(false, order);
    assert.deepEqual(
      h.steps.map((s) => s.observation.code ?? s.observation.status),
      [
        "prepared",
        "prepared",
        "committed",
        "stale",
        "precondition",
        "committed",
      ]
    );
    assert.equal(
      present(present(h.state.records["stock"])["camera"]).values["available"],
      0
    );
    assert.ok(h.oracle.ok);
    assert.deepEqual(
      replay(JSON.parse(JSON.stringify(h.export()))).export(),
      h.export()
    );
  }
});

test("both mutant schedules actually lose accepted reservation and oversell; deterministic replay preserves failure", () => {
  for (const order of [
    ["A", "B"],
    ["B", "A"],
  ]) {
    const h = competition(true, order);
    assert.equal(present(h.steps[3]).observation.status, "committed");
    assert.equal(h.state.revision, 1);
    assert.equal(h.oracle.ok, false);
    assert.match(h.oracle.failures.join(" "), /oversold/u);
    assert.match(h.oracle.failures.join(" "), /lost reservation/u);

    // Snapshot-only conservation cannot expose the overwritten promise.
    const { available } = present(
      present(h.state.records["stock"])["camera"]
    ).values;

    assert.ok(typeof available === "number");
    assert.equal(
      available +
        Object.values(present(h.state.records["reservation"]))
          .filter((r) => r.values["status"] === "active")
          .reduce((n, r) => {
            assert.ok(typeof r.values["quantity"] === "number");

            return n + r.values["quantity"];
          }, 0),
      5
    );
    assert.deepEqual(
      replay(JSON.parse(JSON.stringify(h.export()))).oracle,
      h.oracle
    );
  }
});

test("JSON replay includes declarations; tampered observations fail closed", () => {
  const b = competition().export();
  assert.deepEqual(b.model, inventoryModel);
  assert.throws(
    () =>
      replay({
        ...b,
        steps: [
          { operation: { type: "prepare", invocation: {} }, observation: {} },
        ],
      }),
    /Invalid replay operation/
  );
  present(b.steps[0]).observation.status = "committed";
  assert.throws(() => replay(b), /mismatch/u);
});

test("inventory replay rejects malformed operations before comparing observations", () => {
  const bundle = competition().export();
  const command = invocation("valid", "reserve");
  const execute = { type: "execute", invocation: command };

  for (const [operation, field] of [
    [null, "operation"],
    ["execute", "operation"],
    [{ invocation: command }, "type"],
    [{ ...execute, type: "unknown" }, "type"],
    [{ type: "commit" }, "token"],
    [{ type: "commit", token: 1 }, "token type"],
    [{ type: "commit", token: "A", mutant: "false" }, "mutant type"],
    [{ type: "prepare", token: 1, invocation: command }, "prepare token"],
    [{ type: "execute" }, "invocation"],
    [{ ...execute, invocation: "reserve" }, "invocation type"],
    [{ ...execute, invocation: { ...command, id: 1 } }, "id"],
    [{ ...execute, invocation: { ...command, action: null } }, "action"],
    [{ ...execute, invocation: { ...command, actor: false } }, "actor"],
    [{ ...execute, invocation: { ...command, clock: "10" } }, "clock"],
    [{ ...execute, invocation: { ...command, args: null } }, "null args"],
    [{ ...execute, invocation: { ...command, args: 1 } }, "scalar args"],
    [{ ...execute, invocation: { ...command, args: [] } }, "array args"],
    [
      { ...execute, invocation: { ...command, args: { watchers: [1] } } },
      "array value",
    ],
    [
      {
        ...execute,
        invocation: { ...command, args: { quantity: { value: 3 } } },
      },
      "object value",
    ],
  ] satisfies [unknown, string][]) {
    const tampered = { ...bundle, steps: [{ operation, observation: {} }] };
    assert.throws(
      () => replay(JSON.parse(JSON.stringify(tampered))),
      /Invalid replay operation/,
      field
    );
  }
});

test("oracle independently detects bad stock and lost reservations", () => {
  const bad = structuredClone(initialState);
  present(present(bad.records["stock"])["camera"]).values["available"] = 4;
  assert.equal(inspectInventory(bad, []).ok, false);
  assert.equal(
    inspectInventory(initialState, [invocation("promise", "reserve")]).ok,
    false
  );
});

test("the inventory oracle distinguishes incomplete evidence from unsupported and duplicate commands", () => {
  const accepted = invocation("accepted", "reserve");
  const missingCounts = structuredClone(initialState);
  Reflect.deleteProperty(
    present(present(missingCounts.records["stock"])["camera"]).values,
    "available"
  );
  assert.throws(() => inspectInventory(missingCounts, []), /safe integer/);
  assert.throws(
    () => inspectInventory({ ...initialState, records: {} }, []),
    /Missing inventory resource collection/
  );
  assert.throws(
    () => inspectInventory(initialState, [{ ...accepted, args: {} }]),
    /Missing reservation slot ID/
  );

  const report = inspectInventory(initialState, [
    accepted,
    { ...accepted, id: "duplicate" },
    { ...accepted, action: "reservation.adjust" },
  ]);

  assert.ok(
    report.failures.some((failure) => failure.includes("accepted twice"))
  );
  assert.ok(
    report.failures.includes("Unsupported oracle action: reservation.adjust")
  );
});

test("host snapshots declarations and initial state; duplicate IDs do not publish", () => {
  const m = structuredClone(inventoryModel);
  const s = structuredClone(initialState);
  const h = createHost(m, s);

  m.id = "edited";
  present(present(s.records["stock"])["camera"]).values["available"] = 0;
  const command = invocation("unique", "reserve");
  assert.equal(run(h, command).status, "committed");

  const before = h.state;
  const count = h.events.length;

  assert.equal(run(h, command).reason, "duplicate-invocation");
  assert.equal(h.state, before);
  assert.equal(h.events.length, count);
  assert.equal(h.export().model.id, "inventory.v1");
  assert.equal(
    present(present(h.export().initial.records["stock"])["camera"]).values[
      "available"
    ],
    5
  );
});

test("editing a declaration changes behavior in shared interpreter, not domain switches", () => {
  const m = structuredClone(inventoryModel);
  present(present(m.actions["reservation.reserve"]).policies[0]).when = {
    op: "eq",
    left: { op: "actor" },
    right: { op: "literal", value: "bob" },
  };
  const h = createHost(m);
  assert.equal(run(h, invocation("aliceDenied", "reserve")).code, "denied");
  assert.equal(
    run(h, invocation("bobAllowed", "reserve", "slotA", "bob")).status,
    "committed"
  );
});
