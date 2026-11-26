import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { runDurableDemo } from "./demo.ts";

const demoURL = new URL("./demo.ts", import.meta.url).href;

test("the durable demo publishes separate, inspectable SQLite evidence for all three scenarios", async (t) => {
  const output = await database();

  const directory = dirname(output);
  const target = resolve(directory, "reports", "demo.json");

  t.after(() => rm(directory, { recursive: true, force: true }));

  const summary = JSON.parse(
    execFileSync(process.execPath, [fileURLToPath(demoURL), target], {
      encoding: "utf8",
    })
  );

  const report: Awaited<ReturnType<typeof runDurableDemo>> = JSON.parse(
    await readFile(target, "utf8")
  );

  const evidenceDirectory = report.paths.databaseDirectory;
  assert.equal(dirname(evidenceDirectory), "/tmp/opencode");
  assert.match(basename(evidenceDirectory), /^inventory-v2-demo-/);
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  assert.equal(report.format, "inventory-v2-execution-report/2");
  assert.equal(report.runtime.storage, "node:sqlite DatabaseSync");
  assert.deepEqual(summary, {
    report: target,
    execution: "executed",
    scenarios: report.scenarios.map(({ scenario, checks, databasePath }) => ({
      scenario,
      checks,
      databasePath,
    })),
  });
  assert.deepEqual(
    report.scenarios.map((s) => s.scenario),
    ["lifecycle", "stale", "expired"]
  );
  assert.deepEqual(
    report.scenarios.map((s) => s.steps.at(-1)?.after.state.revision),
    [3, 1, 0]
  );

  for (const { databasePath, scenario, steps } of report.scenarios) {
    assert.equal(
      databasePath,
      resolve(evidenceDirectory, scenario + ".sqlite")
    );
    assert.match(
      (await readFile(databasePath)).subarray(0, 16).toString(),
      /^SQLite format 3/
    );

    for (const [index, step] of steps.entries()) {
      if (index > 0) {
        assert.deepEqual(step.before, steps[index - 1]?.after);
      }
    }
  }
});

async function database() {
  await mkdir("/tmp/opencode", { recursive: true });

  return resolve(
    await mkdtemp("/tmp/opencode/inventory-v2-test-"),
    "inventory.sqlite"
  );
}

// Every phase is a different OS process: no retained interpreter, token, receipt or DB handle.
function phase(path: string, scenario: string, name: string) {
  const script = `import {runDurablePhase} from ${JSON.stringify(demoURL)};
    console.log(JSON.stringify(await runDurablePhase(...JSON.parse(process.argv[1]))));`;

  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        JSON.stringify([path, scenario, name]),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )
  );
}

// Independent quantity oracle; does not interpret declarations, results, or event deltas.
function inventory(
  snapshot: {
    state: {
      records: {
        stock: { camera: { values: { available: number } } };
        reservation: Record<
          string,
          { values: { quantity: number; status: string } }
        >;
      };
    };
  },
  active: Record<string, number>,
  terminal = {}
) {
  assert.equal(
    snapshot.state.records.stock.camera.values.available,
    8 - Object.values(active).reduce((sum, quantity) => sum + quantity, 0)
  );
  assert.deepEqual(
    Object.keys(snapshot.state.records.reservation).sort(),
    [...Object.keys(active), ...Object.keys(terminal)].sort()
  );

  for (const [id, quantity] of Object.entries(active)) {
    assert.equal(
      snapshot.state.records.reservation[id]?.values.quantity,
      quantity
    );
    assert.equal(
      snapshot.state.records.reservation[id]?.values.status,
      "active"
    );
  }
}

test("SQLite inventory approval survives process restarts, commits once, cancels and deletes", async () => {
  const path = await database();
  const start = phase(path, "lifecycle", "start");
  assert.equal(start.results[0].status, "pending");
  assert.deepEqual(start.before.state, start.after.state);
  inventory(start.after, {});
  assert.deepEqual(start.after.outbox, []);
  const grant = phase(path, "lifecycle", "grant");
  assert.deepEqual(grant.before, start.after);
  assert.equal(grant.results[0].status, "approved");
  assert.deepEqual(grant.after.pending.grants, [
    { policyId: "reserve.warehouse-approval", approver: "warehouse" },
  ]);
  assert.deepEqual(grant.after.state, start.after.state);
  assert.deepEqual(grant.after.outbox, []);
  const resumed = phase(path, "lifecycle", "resume");
  assert.deepEqual(resumed.before, grant.after);
  assert.equal(resumed.results[0].status, "committed");
  inventory(resumed.after, { "durable-reservation": 3 });
  assert.equal(resumed.after.state.revision, 1);
  assert.equal(
    resumed.after.state.records.reservation["durable-reservation"].version,
    0
  );
  assert.equal(
    resumed.after.state.records.reservation["durable-reservation"].values.owner,
    "alice"
  );
  assert.deepEqual(
    resumed.after.outbox.map((x: { event: { kind: string } }) => x.event.kind),
    ["action", "change", "create"]
  );
  assert.ok(
    resumed.after.outbox.every(
      (x: { event: { clock: number } }) => x.event.clock === 101
    )
  );
  assert.equal(resumed.after.pending.status, "consumed");
  assert.equal(resumed.after.pending.resumeId, "resume-1");
  const retry = phase(path, "lifecycle", "retry");
  assert.deepEqual(retry.before, resumed.after);
  assert.equal(retry.results[0].status, "duplicate");
  assert.deepEqual(retry.results[0].result, resumed.results[0]);
  assert.equal(retry.results[1].status, "duplicate");
  assert.deepEqual(retry.results[1].result, start.results[0]);
  assert.equal(retry.results[2].code, "consumed");
  assert.deepEqual(retry.after, resumed.after);
  const finish = phase(path, "lifecycle", "finish");
  assert.deepEqual(finish.before, retry.after);
  assert.deepEqual(
    finish.results.map((x: { status: string }) => x.status),
    ["committed", "committed"]
  );
  inventory(
    { state: finish.results[0].state },
    {},
    { "durable-reservation": 3 }
  );
  assert.equal(
    finish.results[0].state.records.reservation["durable-reservation"].values
      .status,
    "cancelled"
  );
  inventory(finish.after, {});
  assert.equal(finish.after.state.revision, 3);
  assert.deepEqual(
    finish.after.outbox.map((x: { event: { kind: string } }) => x.event.kind),
    [
      "action",
      "change",
      "create",
      "action",
      "change",
      "change",
      "action",
      "delete",
    ]
  );
  assert.equal(
    new Set(finish.after.outbox.map((x: { eventId: string }) => x.eventId))
      .size,
    8
  );
});

for (const scenario of ["stale", "expired"]) {
  test(`SQLite ${scenario} approved request rejects after process reopen without state/events publication`, async () => {
    const path = await database();
    const start = phase(path, scenario, "start");
    assert.equal(start.results[0].status, "pending");
    const grant = phase(path, scenario, "grant");
    assert.equal(grant.results[0].status, "approved");
    let previous = grant;

    if (scenario === "stale") {
      previous = phase(path, scenario, "intervene");
      assert.deepEqual(previous.before, grant.after);
      assert.equal(previous.results[0].status, "committed");
      inventory(previous.after, { "small-reservation": 1 });
      assert.equal(previous.after.outbox.length, 3);
    }

    const resumed = phase(path, scenario, "resume");
    assert.deepEqual(resumed.before, previous.after);
    assert.equal(resumed.results[0].status, "rejected");
    assert.equal(
      resumed.results[0].code,
      scenario === "stale" ? "stale" : "precondition"
    );
    assert.deepEqual(resumed.after, resumed.before);
    assert.equal(resumed.after.pending.status, "pending");
    inventory(
      resumed.after,
      scenario === "stale" ? { "small-reservation": 1 } : {}
    );
    // A second process sees the durable rejection, not a new execution.
    const retry = phase(path, scenario, "resume");
    assert.equal(retry.results[0].status, "duplicate");
    assert.deepEqual(retry.results[0].result, resumed.results[0]);
    assert.deepEqual(retry.after, resumed.after);
  });
}
