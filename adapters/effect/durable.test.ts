import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as Effect from "effect/Effect";

import { inventoryModel } from "../../inventory/model.ts";
import { issueModel, issueState } from "../../semantic/issues.ts";
import { present } from "../../semantic/test-support.ts";
import {
  makeDurableRuntime,
  makeDurableStore,
  initializeDurableState,
  durableExecute,
  durableState,
  pullOutbox,
  acknowledgeOutbox,
  closeDurableStore,
  DurableStore,
  durableStoreLayer,
} from "./durable.ts";

const invoke = (id: string, args = { issueId: "i1" }) => ({
  id,
  action: "issue.resolve",
  args,
  actor: "maya",
  clock: 1730000000000,
});

const run = Effect.runPromise;

function withStatus<T extends { status: string }, S extends T["status"]>(
  value: T,
  status: S
): Extract<T, { status: S }> {
  const matches = (candidate: T): candidate is Extract<T, { status: S }> =>
    candidate.status === status;

  assert.ok(matches(value), `Expected ${status}, got ${value.status}`);

  return value;
}

const temp = () => mkdtempSync(join(tmpdir(), "effect-durable-"));
const worker = new URL("./durable-worker.ts", import.meta.url).pathname;

const child = (path: string, mode: string, id?: string) =>
  spawnSync(
    process.execPath,
    [worker, path, mode, ...(id === undefined ? [] : [id])],
    { encoding: "utf8" }
  );

test("durable store layer supplies a SQLite handle and closes it when its scope ends", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = await run(
    Effect.provide(DurableStore, durableStoreLayer(join(dir, "layer.sqlite")))
  );

  assert.throws(() => db.prepare("SELECT 1"), /not open/i);
});

test("restart keeps outcomes and immutable command identity", async (t) => {
  const dir = temp();
  const path = join(dir, "store.sqlite");

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let db = await run(makeDurableStore(path));
  let runtime = makeDurableRuntime(issueModel);

  await run(initializeDurableState(runtime, db, issueState));
  const source = invoke("durable1");
  assert.equal(
    (await run(durableExecute(runtime, db, source))).status,
    "committed"
  );
  source.args.issueId = "mutated";
  await run(closeDurableStore(db));
  db = await run(makeDurableStore(path));
  const replay = await run(durableExecute(runtime, db, invoke("durable1")));
  assert.equal(replay.status, "duplicate");
  assert.equal(replay.result.status, "committed");

  const reordered = {
    clock: 1730000000000,
    actor: "maya",
    args: { issueId: "i1" },
    action: "issue.resolve",
    id: "durable1",
  };

  assert.equal(
    (await run(durableExecute(runtime, db, reordered))).status,
    "duplicate"
  );
  assert.equal(
    withStatus(
      await run(
        durableExecute(runtime, db, invoke("durable1", { issueId: "i2" }))
      ),
      "rejected"
    ).code,
    "invocation-conflict"
  );
  await run(closeDurableStore(db));
});

test("pending and rejected outcomes reserve IDs; changed model/input conflicts after reopen", async (t) => {
  const dir = temp();
  const path = join(dir, "store.sqlite");

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = await run(makeDurableStore(path));
  const rt = makeDurableRuntime(issueModel);

  const pendingModel = structuredClone(issueModel);
  present(present(pendingModel.actions["issue.resolve"]).policies[0]).effect =
    "approval-required";
  const pendingRuntime = makeDurableRuntime(pendingModel);
  await run(initializeDurableState(pendingRuntime, db, issueState));
  const p = await run(durableExecute(pendingRuntime, db, invoke("p")));
  assert.equal(p.status, "pending");
  assert.equal(
    withStatus(await run(durableExecute(rt, db, invoke("p"))), "rejected").code,
    "invocation-conflict"
  );

  const denied = await run(
    durableExecute(pendingRuntime, db, invoke("bad", { issueId: "missing" }))
  );

  assert.equal(denied.status, "rejected");
  assert.equal(
    withStatus(
      await run(durableExecute(pendingRuntime, db, invoke("bad"))),
      "rejected"
    ).code,
    "invocation-conflict"
  );
  await run(closeDurableStore(db));
});

test("failure injection rolls back state, ledger, and outbox in one transaction", async (t) => {
  const dir = temp();
  const path = join(dir, "store.sqlite");

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = await run(makeDurableStore(path));
  const rt = makeDurableRuntime(issueModel);

  await run(initializeDurableState(rt, db, issueState));
  await assert.rejects(
    run(
      durableExecute(rt, db, invoke("rollback"), {
        beforeCommit: () => {
          throw Error("injected");
        },
      })
    )
  );
  assert.deepEqual(await run(durableState(rt, db)), issueState);
  assert.equal((await run(pullOutbox(db))).length, 0);
  assert.equal(
    (await run(durableExecute(rt, db, invoke("rollback")))).status,
    "committed"
  );
  await run(closeDurableStore(db));
});

test("outbox pull is ordered and ack is explicit at-least-once", async (t) => {
  const dir = temp();
  const path = join(dir, "store.sqlite");

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = await run(makeDurableStore(path));
  const rt = makeDurableRuntime(issueModel);

  await run(initializeDurableState(rt, db, issueState));
  await run(durableExecute(rt, db, invoke("outbox")));
  const first = await run(pullOutbox(db));
  assert.ok(first.length > 0);
  assert.deepEqual(await run(pullOutbox(db)), first);
  assert.equal(
    await run(acknowledgeOutbox(db, present(first[0]).sequence)),
    true
  );
  await run(closeDurableStore(db));
});

test("separate processes serialize contenders against one SQLite state", async (t) => {
  const dir = temp();
  const path = join(dir, "store.sqlite");

  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(child(path, "init").status, 0);

  const outcomes = await Promise.all(
    ["a", "b"].map(
      (id) =>
        new Promise<ReturnType<typeof child>>((resolve) => {
          const p = spawnSync(process.execPath, [worker, path, "execute", id], {
            encoding: "utf8",
          });

          resolve(p);
        })
    )
  );

  assert.ok(
    outcomes.every((x) => x.status === 0),
    outcomes.map((x) => x.stderr).join("\n")
  );
  const db = await run(makeDurableStore(path));
  const state = await run(durableState(makeDurableRuntime(issueModel), db));
  assert.equal(
    present(present(state.records["issues"])["i1"]).values["status"],
    "resolved"
  );
  assert.equal((await run(pullOutbox(db))).length, 4);
  await run(closeDurableStore(db));
});

test("two processes competing to reserve 3 from stock 5 admit only one", async (t) => {
  const dir = temp();
  const path = join(dir, "stock.sqlite");

  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(child(path, "init-stock").status, 0);

  const contenders = ["stock-a", "stock-b"].map((id) =>
    spawnSync(process.execPath, [worker, path, "stock", id], {
      encoding: "utf8",
    })
  );

  assert.ok(
    contenders.every((x) => x.status === 0),
    contenders.map((x) => x.stderr).join("\n")
  );
  assert.equal(present(contenders[0]).stdout.trim(), "committed:");

  const db = await run(makeDurableStore(path));
  const rt = makeDurableRuntime(inventoryModel);

  const state = await run(durableState(rt, db));
  assert.equal(
    present(present(state.records["stock"])["camera"]).values["available"],
    2,
    JSON.stringify(
      contenders.map((x) => ({
        status: x.status,
        stdout: x.stdout,
        stderr: x.stderr,
      }))
    )
  );
  assert.equal(
    Object.values(present(state.records["reservation"])).filter(
      (x) => x.values["status"] === "active"
    ).length,
    1
  );
  assert.equal((await run(pullOutbox(db))).length, 5);
  await run(closeDurableStore(db));
});

test("process death before commit rolls back; death after commit survives restart", async (t) => {
  const dir = temp();
  const path = join(dir, "store.sqlite");

  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(child(path, "init").status, 0);
  const killed = child(path, "crash-before");
  assert.equal(killed.signal, "SIGKILL");

  let db = await run(makeDurableStore(path));
  let rt = makeDurableRuntime(issueModel);

  assert.deepEqual(await run(durableState(rt, db)), issueState);
  await run(closeDurableStore(db));
  assert.equal(child(path, "crash-after", "after-crash").status, 0);
  db = await run(makeDurableStore(path));
  assert.equal(
    (await run(durableExecute(rt, db, invoke("after-crash")))).status,
    "duplicate"
  );
  assert.equal((await run(pullOutbox(db))).length, 4);
  await run(closeDurableStore(db));
});

test("malformed persisted JSON fails closed on recovery", async (t) => {
  const dir = temp();
  const path = join(dir, "store.sqlite");

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = await run(makeDurableStore(path));
  const rt = makeDurableRuntime(issueModel);

  await run(initializeDurableState(rt, db, issueState));
  db.prepare("UPDATE durable_meta SET value='{' WHERE key='state_json'").run();
  await assert.rejects(run(durableState(rt, db)));
  await run(closeDurableStore(db));
});

test("only initialized canonical stores can be read or executed, and bounds cannot advance the outbox", async (t) => {
  const dir = temp();
  const db = await run(makeDurableStore(join(dir, "boundaries.sqlite")));

  t.after(async () => {
    await run(closeDurableStore(db));
    rmSync(dir, { recursive: true, force: true });
  });
  const runtime = makeDurableRuntime(issueModel);
  await assert.rejects(run(durableState(runtime, db)), /not initialized/);
  await assert.rejects(
    run(durableExecute(runtime, db, invoke("unused"))),
    /has not been initialized/
  );
  await run(initializeDurableState(runtime, db, issueState));
  await assert.rejects(
    run(initializeDurableState(runtime, db, issueState)),
    /already initialized/
  );
  assert.deepEqual(await run(durableState(runtime, db)), issueState);
  assert.equal(
    (await run(durableExecute(runtime, db, invoke("published")))).status,
    "committed"
  );
  const before = await run(pullOutbox(db));
  assert.ok(before.length > 0);

  for (const limit of [0, 1.5, 1001]) {
    await assert.rejects(run(pullOutbox(db, { limit })), /1 to 1000/);
  }

  for (const sequence of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      run(acknowledgeOutbox(db, sequence)),
      /positive safe integer/
    );
  }

  assert.deepEqual(await run(pullOutbox(db)), before);
  const meta = db.prepare("UPDATE durable_meta SET value=? WHERE key=?");

  const format = db
    .prepare("SELECT value FROM durable_meta WHERE key='format'")
    .get()?.["value"];

  assert.ok(typeof format === "string");
  meta.run("unsupported", "format");
  await assert.rejects(
    run(durableState(runtime, db)),
    /Unsupported durable store format/
  );
  meta.run(format, "format");
  const state = await run(durableState(runtime, db));
  meta.run(JSON.stringify(state, null, 2), "state_json");
  await assert.rejects(
    run(durableExecute(runtime, db, invoke("ambiguous"))),
    /not canonical/
  );
  assert.deepEqual(await run(pullOutbox(db)), before);
});
