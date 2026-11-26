import assert from "node:assert/strict";
import test from "node:test";

import {
  inventoryModel,
  runtime as v1,
  initialState as initialV1,
  invocation as invokeV1,
} from "../inventory/model.ts";
import {
  inventoryV2Model,
  runtime as v2,
  initialState as initialV2,
  invocation as invokeV2,
} from "../inventory/v2/model.ts";
import { createInterpreter } from "../semantic/core.ts";
import { issueModel, issueState } from "../semantic/issues.ts";
import type { Model as V1Model } from "../semantic/types.ts";
import type { Model as V2Model } from "../semantic/v2/types.ts";
import { deriveTools, deriveDependencies, deriveChange } from "./derive.ts";

test("tools preserve exact schema/policy/precondition declarations in both profiles", () => {
  const models: (V1Model | V2Model)[] = [
    inventoryModel,
    inventoryV2Model,
    issueModel,
  ];

  for (const model of models) {
    for (const tool of deriveTools(model)) {
      const action = model.actions[tool.name];
      assert.ok(action);
      assert.deepEqual(tool.inputs, action.inputs);
      assert.deepEqual(
        tool.policyIds,
        action.policies.map((x) => x.id)
      );
      assert.deepEqual(
        tool.preconditionIds,
        action.preconditions.map((x) => x.id)
      );
    }

    const tools = deriveTools(model);
    const [first] = tools;

    assert.ok(first);
    first.inputs = {};
    assert.notDeepEqual(tools, deriveTools(model));
  }
});

test("action declarations and facts route views, independently of actor-excluded human recipients", () => {
  const invocation1 = invokeV1("derive1", "reserve");
  const invocation2 = invokeV2("derive2", "reserve", { reservationId: "res1" });

  const cases = [
    {
      model: inventoryModel,
      invocation: invocation1,
      result: v1.execute(initialV1, invocation1),
    },
    {
      model: inventoryV2Model,
      invocation: invocation2,
      result: v2.execute(initialV2, invocation2),
    },
  ];

  for (const { model, invocation, result } of cases) {
    assert.equal(result.status, "committed");
    const change = deriveChange(model, result.events, { sequence: 1 });
    assert(change.invalidations.some((x) => x.resource === "reservation"));
    assert(
      change.invalidations.some((x) => x.relationship === "reservation.owner")
    );
    assert(!change.recipients.some((x) => x.recipient === "alice"));
    assert(change.recipients.some((x) => x.recipient === "bob"));
    const dependencies = deriveDependencies(model);

    const dependency = dependencies.find(
      (x) => x.actionId === invocation.action
    );

    assert(dependency && dependency.writes.length > 0);
  }
});

test("routing is generic across renamed actions and other domains; pending is explicit", () => {
  const { "issue.resolve": resolveIssue, ...actions } = issueModel.actions;
  assert.ok(resolveIssue);

  const model = {
    ...issueModel,
    actions: { ...actions, "ticket.finish": resolveIssue },
  };

  const runtime = createInterpreter(model);

  const result = runtime.execute(issueState, {
    id: "generic",
    action: "ticket.finish",
    args: { issueId: "i1" },
    actor: "maya",
    clock: 1,
  });

  assert.equal(result.status, "committed");
  assert(
    deriveChange(model, result.events).invalidations.some(
      (x) => x.resource === "issues"
    )
  );
  assert.deepEqual(
    deriveChange(model, [], {
      sequence: 4,
      pending: true,
      reason: "approval-ledger",
    }),
    {
      sequence: 4,
      invalidations: [{ view: "pending" }],
      recipients: [],
      reason: "approval-ledger",
    }
  );
});

test("view invalidations fail closed on facts not backed by the declared write", () => {
  const result = v1.execute(initialV1, invokeV1("unknown-write", "reserve"));
  assert.equal(result.status, "committed");
  const change = result.events.find((event) => event.kind === "change");
  assert.ok(change);
  assert.throws(
    () => deriveChange(inventoryModel, [{ ...change, actionId: "missing" }]),
    /Unknown event action/
  );
  assert.throws(
    () => deriveChange(inventoryModel, [{ ...change, semanticId: "missing" }]),
    /Unknown event write/
  );
  assert.throws(
    () =>
      deriveChange(inventoryModel, [{ ...change, resource: "reservation" }]),
    /Unknown event write/
  );
});
