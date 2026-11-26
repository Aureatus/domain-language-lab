import assert from "node:assert/strict";
import test from "node:test";

import { present } from "../../semantic/test-support.ts";
import { createInterpreter } from "../../semantic/v2/core.ts";
import type { State } from "../../semantic/v2/types.ts";
import { inventoryV2Model, initialState, invocation } from "./model.ts";

type Mutable<T> = T extends object
  ? { -readonly [K in keyof T]: Mutable<T[K]> }
  : T;

const copy = <T>(value: T): Mutable<T> => JSON.parse(JSON.stringify(value));

const stock = (state: State) => {
  const available = state.records["stock"]?.["camera"]?.values["available"];
  assert.ok(typeof available === "number");

  return available;
};

type Operation =
  | {
      kind: "reserve";
      id: string;
      owner: string;
      quantity: number;
      expiresAt: number;
    }
  | { kind: "cancel" | "expire" | "delete-terminal"; id: string };

const oracle = (before: State, operations: Operation[]) => {
  // Independent capacity/accounting model: deliberately does not inspect the IR or events.
  let available = stock(before);
  const reservations = copy(present(before.records["reservation"]));

  for (const op of operations) {
    if (op.kind === "reserve") {
      available -= op.quantity;
      reservations[op.id] = {
        version: 0,
        values: {
          stockId: "camera",
          owner: op.owner,
          quantity: op.quantity,
          expiresAt: op.expiresAt,
          status: "active",
        },
      };
    } else if (op.kind === "cancel" || op.kind === "expire") {
      const reservation = present(reservations[op.id]);
      const quantity = reservation.values["quantity"];

      assert.ok(typeof quantity === "number");
      available += quantity;
      reservation.values["status"] =
        op.kind === "cancel" ? "cancelled" : "expired";
      reservation.version++;
    } else if (op.kind === "delete-terminal") {
      delete reservations[op.id];
    }
  }

  return { available, reservations };
};

const run = (
  rt: ReturnType<typeof createInterpreter>,
  state: State,
  id: string,
  kind: string,
  options: Parameters<typeof invocation>[2]
) => rt.execute(state, invocation(id, kind, options));

test("actual inserts, stock decrement, approval, cancellation, expiry and terminal deletion", () => {
  const rt = createInterpreter(inventoryV2Model);
  let state = initialState;

  const expected = oracle(state, [
    {
      kind: "reserve",
      id: "res-small",
      owner: "alice",
      quantity: 2,
      expiresAt: 30,
    },
    {
      kind: "reserve",
      id: "res-large",
      owner: "bob",
      quantity: 3,
      expiresAt: 40,
    },
    { kind: "cancel", id: "res-small" },
    { kind: "expire", id: "res-large" },
    { kind: "delete-terminal", id: "res-small" },
    { kind: "delete-terminal", id: "res-large" },
  ]);

  let result = run(rt, state, "reserve-small", "reserve", {
    reservationId: "res-small",
    quantity: 2,
  });

  assert.equal(result.status, "committed");
  assert.deepEqual(
    result.events.map((x) => x.kind),
    ["action", "change", "create"]
  );
  assert.equal(result.state.records["reservation"]?.["res-small"]?.version, 0);
  state = result.state;

  const large = invocation("reserve-large", "reserve", {
    reservationId: "res-large",
    actor: "bob",
    quantity: 3,
    expiresAt: 40,
  });

  const pending = rt.execute(state, large);
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.policyIds, ["reserve.warehouse-approval"]);
  assert.equal(stock(pending.state), 6);
  assert.equal(
    present(pending.state.records["reservation"])["res-large"],
    undefined
  );

  const grant = rt.approve(pending.request, {
    policyId: "reserve.warehouse-approval",
    approver: "warehouse",
  });

  assert.equal(grant.status, "approved");
  result = rt.resume(state, large, pending.request, [grant.receipt], {
    clock: 11,
  });
  assert.equal(result.status, "committed");
  state = result.state;

  result = run(rt, state, "cancel-small", "cancel", {
    reservationId: "res-small",
    actor: "alice",
  });
  assert.equal(result.status, "committed");
  state = result.state;
  const beforeExpiry = state;
  result = run(rt, state, "expire-large-early", "expire", {
    reservationId: "res-large",
    actor: "warehouse",
    clock: 39,
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "precondition");
  assert.strictEqual(result.state, beforeExpiry);
  result = run(rt, state, "expire-large", "expire", {
    reservationId: "res-large",
    actor: "warehouse",
    clock: 40,
  });
  assert.equal(result.status, "committed");
  state = result.state;
  result = run(rt, state, "delete-small", "delete-terminal", {
    reservationId: "res-small",
    actor: "alice",
  });
  assert.equal(result.status, "committed");
  assert.equal(
    present(result.state.records["reservation"])["res-small"],
    undefined
  );
  state = result.state;
  result = run(rt, state, "delete-large", "delete-terminal", {
    reservationId: "res-large",
    actor: "bob",
  });
  assert.equal(result.status, "committed");
  state = result.state;
  assert.equal(stock(state), expected.available);
  assert.deepEqual(state.records["reservation"], expected.reservations);
});

test("denial, failed preconditions, duplicate ID, ownership and stale approvals are distinct", () => {
  const rt = createInterpreter(inventoryV2Model);
  const state = initialState;

  const tooLate = run(rt, state, "late", "reserve", {
    reservationId: "late-res",
    clock: 30,
    expiresAt: 30,
    quantity: 1,
  });

  assert.equal(tooLate.status, "rejected");
  assert.equal(tooLate.code, "precondition");

  const largeInvocation = invocation("pending-call", "reserve", {
    reservationId: "approved-res",
    actor: "bob",
    quantity: 3,
  });

  const pending = rt.execute(state, largeInvocation);
  assert.equal(pending.status, "pending");

  const grant = rt.approve(pending.request, {
    policyId: "reserve.warehouse-approval",
    approver: "warehouse",
  });

  assert.equal(grant.status, "approved");

  const changed = copy(state);
  const watchers = changed.records["stock"]?.["camera"]?.values["watchers"];

  assert.ok(Array.isArray(watchers));
  watchers.push("carol");

  const stale = rt.resume(
    changed,
    largeInvocation,
    pending.request,
    [grant.receipt],
    { clock: 11 }
  );

  assert.equal(stale.status, "rejected");
  assert.equal(stale.code, "stale");

  const expired = rt.resume(
    state,
    largeInvocation,
    pending.request,
    [grant.receipt],
    { clock: 30 }
  );

  assert.equal(expired.status, "rejected");
  assert.equal(expired.code, "precondition");

  const unauthorized = rt.approve(pending.request, {
    policyId: "reserve.warehouse-approval",
    approver: "alice",
  });

  assert.equal(unauthorized.status, "rejected");
  assert.equal(unauthorized.code, "unauthorized-approval");

  const committed = rt.resume(
    state,
    largeInvocation,
    pending.request,
    [grant.receipt],
    { clock: 11 }
  );

  assert.equal(committed.status, "committed");

  const duplicate = run(rt, committed.state, "same-id", "reserve", {
    reservationId: "approved-res",
    quantity: 1,
  });

  assert.equal(duplicate.status, "rejected");
  assert.equal(duplicate.code, "existing-record");

  const owner = run(rt, committed.state, "wrong-owner", "cancel", {
    reservationId: "approved-res",
    actor: "alice",
  });

  assert.equal(owner.status, "rejected");
  assert.equal(owner.code, "denied");

  const remove = run(rt, committed.state, "wrong-delete", "delete-terminal", {
    reservationId: "approved-res",
    actor: "bob",
  });

  assert.equal(remove.status, "rejected");
  assert.equal(remove.code, "precondition");
});

test("multiple named reservations independently obey a capacity oracle", () => {
  const rt = createInterpreter(inventoryV2Model);
  let state = initialState;

  const reservations: [string, string, number][] = [
    ["alice-camera-a", "alice", 2],
    ["bob-camera-b", "bob", 2],
    ["alice-camera-c", "alice", 1],
  ];

  for (const [id, owner, quantity] of reservations) {
    const result = run(rt, state, `create-${id}`, "reserve", {
      reservationId: id,
      actor: owner,
      quantity,
      expiresAt: 50,
    });

    assert.equal(result.status, "committed");
    state = result.state;
  }

  assert.equal(stock(state), 3);

  const capacityFailure = run(rt, state, "over-capacity", "reserve", {
    reservationId: "too-many",
    quantity: 4,
    expiresAt: 50,
  });

  assert.equal(capacityFailure.status, "rejected");
  assert.equal(capacityFailure.code, "precondition");
  assert.equal(stock(capacityFailure.state), 3);

  const expected = oracle(initialState, [
    {
      kind: "reserve",
      id: "alice-camera-a",
      owner: "alice",
      quantity: 2,
      expiresAt: 50,
    },
    {
      kind: "reserve",
      id: "bob-camera-b",
      owner: "bob",
      quantity: 2,
      expiresAt: 50,
    },
    {
      kind: "reserve",
      id: "alice-camera-c",
      owner: "alice",
      quantity: 1,
      expiresAt: 50,
    },
  ]);

  assert.equal(stock(state), expected.available);
  assert.deepEqual(state.records["reservation"], expected.reservations);
});
