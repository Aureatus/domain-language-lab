import assert from "node:assert/strict";
import test from "node:test";

import { hash, policyDiff, Runtime } from "./engine.ts";
import { model, reviewer, support, ticket } from "./model.ts";
import { explore, replay, storyboard } from "./scenarios.ts";

test("policy derives pending; invalid approval and denied actor cannot commit", () => {
  const r = new Runtime(model, ticket(), () => 42);
  assert.equal(r.request(support, "Fixed").status, "pending");
  assert.equal(r.approve(support).reason, "reviewer-required");
  assert.equal(r.execute().reason, "approval-required");
  assert.equal(
    r.events.some((e) => e.kind === "committed"),
    false
  );
  const denied = new Runtime(model, ticket(), () => 42);
  assert.equal(
    denied.request({ id: "v", role: "viewer" }, "Fixed").reason,
    "policy-denied"
  );
  assert.equal(denied.invocation, undefined);
});

test("authorized execution updates atomically and derives deduplicated relationship recipients", () => {
  const r = new Runtime(model, ticket(), () => 42);
  r.request(support, "Fixed");
  r.approve(reviewer);
  assert.equal(r.execute().status, "completed");
  assert.equal(r.ticket.status, "resolved");
  assert.equal(r.ticket.resolution, "Fixed");
  assert.equal(r.ticket.resolvedAt, 42);
  assert.equal(r.ticket.version, 2);
  assert.equal(r.ticket.openedBy, "user-1");
  assert.deepEqual(
    r.deliveries.map((d) => d.recipient),
    ["user-1", "user-2"]
  );
  const snapshot = r.export();
  r.execute();
  assert.deepEqual(r.export(), snapshot);
});

test("edits, resource changes and model changes invalidate approval", () => {
  for (const change of ["arguments", "resource", "model"]) {
    const r = new Runtime(model, ticket(), () => 42);
    r.request(support, "Fixed");
    r.approve(reviewer);

    if (change === "arguments") {
      r.editSummary("Different");
    }

    if (change === "resource") {
      r.ticket.version += 1;
    }

    if (change === "model") {
      const next = structuredClone(model);
      next.revision += 1;
      r.replaceModel(next);
    }

    assert.equal(r.execute().reason, "stale-approval");
    assert.equal(r.ticket.status, "open");
    assert.equal(r.deliveries.length, 0);
    r.approve(reviewer);
    assert.equal(r.execute().status, "completed");
  }
});

test("current policy denial wins over a previous approval", () => {
  const r = new Runtime(model, ticket(), () => 42);
  r.request(support, "Fixed");
  r.approve(reviewer);
  const next = structuredClone(model);
  next.policy.support.high = "deny";
  r.replaceModel(next);
  assert.equal(r.execute().reason, "policy-denied");
});

test("normal priority completes without approval; failed preconditions never mutate", () => {
  const t = ticket();
  t.priority = "normal";
  const r = new Runtime(model, t, () => 42);
  assert.equal(r.request(support, " ").reason, "summary-required");
  assert.deepEqual(r.ticket, t);
  assert.equal(r.request(support, "Fixed").status, "ready");
  assert.equal(r.execute().status, "completed");
  const closed = new Runtime(model, r.ticket, () => 42);
  assert.equal(closed.request(support, "Again").reason, "ticket-not-open");
});

test("finite schedule exploration detects the deliberate stale-binding mutant", () => {
  const safe = explore();
  const broken = explore(true);
  assert.equal(safe.scope.schedules, 6);
  assert.equal(safe.result, "bounded_pass");
  assert.equal(broken.result, "counterexample");
  const [failure] = broken.failures;
  assert.ok(failure);
  assert.equal(failure.trace.interpreter.staleApprovalMutantUsed, true);
  assert.deepEqual(
    broken.failures.map((f) => f.schedule),
    [["approve", "edit", "execute"]]
  );
  assert.equal(replay(failure.schedule).execute().reason, "stale-approval");
});

test("policy diff supplies the exact changed context, not a full-equivalence claim", () => {
  const next = structuredClone(model);
  next.policy.support.high = "allow";
  assert.deepEqual(policyDiff(model, next).changes, [
    {
      witness: { role: "support", priority: "high" },
      before: "approval",
      after: "allow",
    },
  ]);
  assert.deepEqual(policyDiff(model, model).changes, []);
});

test("simulation and storyboards are deterministic and preserve causal references", () => {
  const first = storyboard(replay(["approve", "edit", "execute"]));
  assert.equal(first.trace.interpreter.staleApprovalMutantUsed, false);
  assert.equal(
    storyboard(replay(["approve", "edit", "execute"], true)).trace.interpreter
      .staleApprovalMutantUsed,
    true
  );
  assert.deepEqual(first, storyboard(replay(["approve", "edit", "execute"])));

  const positions = new Map(
    first.scenes.flatMap((s, i) => s.eventIds.map((id) => [id, i] as const))
  );

  for (const event of first.trace.events) {
    for (const parent of event.parents) {
      const before = positions.get(parent);
      const after = positions.get(event.id);

      assert.ok(before !== undefined && after !== undefined && before < after);
    }
  }

  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});
