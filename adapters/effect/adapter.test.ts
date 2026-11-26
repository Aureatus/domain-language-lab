import assert from "node:assert/strict";
import test from "node:test";

import * as Effect from "effect/Effect";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { createInterpreter } from "../../semantic/core.ts";
import { issueModel, issueState } from "../../semantic/issues.ts";
import { present } from "../../semantic/test-support.ts";
import { execute, makeStore } from "./index.ts";

const invocation = {
  id: "effect1",
  action: "issue.resolve",
  args: { issueId: "i1" },
  actor: "maya",
  clock: 1_730_000_000_000,
};

const run = Effect.runPromise;

test("committed retry identity ignores key order and retains detached invocation/model content", async () => {
  const runtime = createInterpreter(issueModel);
  const source = structuredClone(issueState);

  const store = await run(makeStore(source));
  source.revision = 99;
  const command = structuredClone(invocation);
  assert.equal(
    (await run(execute(runtime, store, command))).status,
    "committed"
  );
  command.args.issueId = "i2";

  const reordered = {
    clock: invocation.clock,
    actor: invocation.actor,
    args: { issueId: "i1" },
    action: invocation.action,
    id: invocation.id,
  };

  assert.equal(
    (await run(execute(runtime, store, reordered))).status,
    "duplicate"
  );
  const conflict = await run(execute(runtime, store, command));
  assert.equal(conflict.status, "rejected");
  assert.equal(conflict.code, "invocation-conflict");
  const changed = structuredClone(issueModel);
  changed.id = "issues.changed";

  const modelConflict = await run(
    execute(createInterpreter(changed), store, invocation)
  );

  assert.equal(modelConflict.status, "rejected");
  assert.equal(modelConflict.code, "invocation-conflict");
});

test("real Effect execution publishes interpreter state and events atomically", async () => {
  const runtime = createInterpreter(issueModel);
  const store = await run(makeStore(issueState));

  const result = await run(execute(runtime, store, invocation));
  assert.equal(result.status, "committed");
  const published = await run(SynchronizedRef.get(store));
  assert.deepEqual(published.state, result.state);
  assert.deepEqual(published.events, result.events);
});

test("pending publishes nothing; failure before publication leaves both unchanged", async () => {
  const pendingModel = structuredClone(issueModel);
  present(present(pendingModel.actions["issue.resolve"]).policies[0]).effect =
    "approval-required";

  const runtime = createInterpreter(pendingModel);
  const store = await run(makeStore(issueState));

  const pending = { ...invocation, id: "pending" };
  const before = await run(SynchronizedRef.get(store));
  const out = await run(execute(runtime, store, pending));
  assert.equal(out.status, "pending");
  assert.equal(await run(SynchronizedRef.get(store)), before);
  await assert.rejects(
    run(
      execute(createInterpreter(issueModel), store, invocation, {
        beforePublish: () => {
          throw new Error("injected");
        },
      })
    )
  );
  assert.equal(await run(SynchronizedRef.get(store)), before);
});

test("competing fibers serialize stale-state execution; duplicate IDs do not double commit", async () => {
  const runtime = createInterpreter(issueModel);
  const store = await run(makeStore(issueState));

  const outcomes = await run(
    Effect.all(
      [
        execute(runtime, store, invocation),
        execute(runtime, store, invocation),
      ],
      { concurrency: "unbounded" }
    )
  );

  assert.equal(outcomes.filter((x) => x.status === "committed").length, 1);
  assert.equal(outcomes.filter((x) => x.status === "duplicate").length, 1);
  const final = await run(SynchronizedRef.get(store));
  const committed = outcomes.find((x) => x.status === "committed");
  assert.ok(committed);
  assert.equal(
    final.events.filter((x) => x.invocationId === invocation.id).length,
    committed.events.length
  );
});
