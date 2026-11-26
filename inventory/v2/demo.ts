import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeDurableRuntime,
  makeDurableStore,
  initializeDurableState,
  durableExecute,
  durableApprove,
  durableResume,
  durablePending,
  durableState,
  pullOutbox,
  closeDurableStore,
} from "../../adapters/effect/durable.ts";
import { Effect } from "../../adapters/effect/index.ts";
import { encodeJsonPretty } from "../../adapters/effect/json.ts";
import { inventoryV2Model, initialState, invocation } from "./model.ts";

const here = dirname(fileURLToPath(import.meta.url));

// Effect is intentionally installed in the adapter package, not at repository root.
const adapterRequire = createRequire(
  new URL("../../adapters/effect/package.json", import.meta.url)
);

const run = Effect.runPromise;

export const durableApprovalFixture = Object.freeze({
  modelId: "inventory.v2",
  initialRevision: 0,
  invocation: invocation("durable-reserve-1", "reserve", {
    reservationId: "durable-reservation",
    clock: 100,
    quantity: 3,
    expiresAt: 200,
  }),
  policyId: "reserve.warehouse-approval",
  approver: "warehouse",
  resumeClock: 101,
});

/** One open/close lifetime; also usable from a fresh child process. No direct state/ledger writes. */
export async function runDurablePhase(
  databasePath: string,
  scenario: string,
  phase: string
) {
  if (!["lifecycle", "stale", "expired"].includes(scenario)) {
    throw new Error("Unknown scenario");
  }

  const runtime = makeDurableRuntime(inventoryV2Model);
  const db = await run(makeDurableStore(databasePath));
  const command = durableApprovalFixture.invocation;

  const resume = {
    id: "resume-1",
    invocationId: command.id,
    clock: scenario === "expired" ? 200 : 101,
  };

  const snapshot = async () => ({
    state: await run(durableState(runtime, db)),
    outbox: await run(pullOutbox(db)),
    pending: await run(durablePending(runtime, db, command.id)),
  });

  try {
    if (phase === "start") {
      await run(initializeDurableState(runtime, db, initialState));
    }

    const before = await snapshot();

    const results: Array<
      | Awaited<ReturnType<typeof execute>>
      | Awaited<ReturnType<typeof approve>>
      | Awaited<ReturnType<typeof resumeRequest>>
    > = [];

    const execute = (invocation: Parameters<typeof durableExecute>[2]) =>
      run(durableExecute(runtime, db, invocation));

    const approve = () =>
      run(
        durableApprove(
          runtime,
          db,
          {
            id: "grant-1",
            invocationId: command.id,
            policyId: durableApprovalFixture.policyId,
          },
          { authenticatedApprover: durableApprovalFixture.approver }
        )
      );

    const resumeRequest = (request: typeof resume) =>
      run(durableResume(runtime, db, request));

    if (phase === "start") {
      results.push(await execute(command));
    } else if (phase === "grant") {
      results.push(await approve());
    } else if (phase === "intervene") {
      results.push(
        await execute(
          invocation("small-reserve", "reserve", {
            reservationId: "small-reservation",
            actor: "bob",
            quantity: 1,
            clock: 100,
            expiresAt: 200,
          })
        )
      );
    } else if (phase === "resume") {
      results.push(await resumeRequest(resume));
    } else if (phase === "retry") {
      results.push(await resumeRequest(resume));
      results.push(await execute(command));
      results.push(await resumeRequest({ ...resume, id: "resume-again" }));
    } else if (phase === "finish") {
      results.push(
        await execute(
          invocation("cancel-1", "cancel", {
            reservationId: "durable-reservation",
            clock: 102,
          })
        )
      );
      results.push(
        await execute(
          invocation("delete-1", "delete-terminal", {
            reservationId: "durable-reservation",
            clock: 103,
          })
        )
      );
    } else {
      throw new Error("Unknown phase");
    }

    return {
      scenario,
      phase,
      databasePath,
      before,
      results,
      after: await snapshot(),
    };
  } finally {
    await run(closeDurableStore(db));
  }
}

export async function runDurableDemo() {
  await mkdir("/tmp/opencode", { recursive: true });
  // Exclusive fresh directory on every run: never remove or overwrite a user's database.
  const directory = await mkdtemp("/tmp/opencode/inventory-v2-demo-");

  const scenarios: {
    scenario: string;
    databasePath: string;
    steps: Awaited<ReturnType<typeof runDurablePhase>>[];
    checks: "passed";
  }[] = [];

  for (const scenario of ["lifecycle", "stale", "expired"]) {
    const databasePath = resolve(directory, `${scenario}.sqlite`);

    const phases = [
      "start",
      "grant",
      ...(scenario === "stale" ? ["intervene"] : []),
      "resume",
      ...(scenario === "lifecycle" ? ["retry", "finish"] : []),
    ];

    const steps: Awaited<ReturnType<typeof runDurablePhase>>[] = [];

    for (const phase of phases) {
      steps.push(await runDurablePhase(databasePath, scenario, phase));
    }

    const start = steps[0];
    const grant = steps[1];
    const resumed = steps.find((x) => x.phase === "resume");

    assert.ok(start && grant && resumed);
    assert.equal(start.results[0]?.status, "pending");
    assert.deepEqual(start.after.state, initialState);
    assert.deepEqual(start.after.outbox, []);
    assert.equal(grant.results[0]?.status, "approved");
    assert.ok(resumed.before.pending);
    assert.equal(resumed.before.pending.grants[0]?.approver, "warehouse");

    if (scenario === "lifecycle") {
      assert.equal(resumed.results[0]?.status, "committed");
      assert.equal(
        resumed.after.state.records["stock"]?.["camera"]?.values["available"],
        8 - 3
      );
      const reservations = resumed.after.state.records["reservation"];
      assert.ok(reservations);
      assert.deepEqual(Object.keys(reservations), ["durable-reservation"]);
      assert.deepEqual(
        resumed.after.outbox.map((x) => x.event["kind"]),
        ["action", "change", "create"]
      );
      assert.ok(resumed.after.outbox.every((x) => x.event["clock"] === 101));
      assert.ok(resumed.after.pending);
      assert.equal(resumed.after.pending.status, "consumed");
      const retry = steps.find((x) => x.phase === "retry");
      assert.ok(retry);
      assert.deepEqual(
        retry.results.map((x) => x.status),
        ["duplicate", "duplicate", "rejected"]
      );
      const consumed = retry.results[2];
      assert.ok(consumed?.status === "rejected");
      assert.equal(consumed.code, "consumed");
      assert.deepEqual(retry.after, retry.before);
      const finish = steps.at(-1);
      assert.ok(finish);
      assert.deepEqual(
        finish.results.map((x) => x.status),
        ["committed", "committed"]
      );
      assert.equal(
        finish.after.state.records["stock"]?.["camera"]?.values["available"],
        8
      );
      assert.deepEqual(finish.after.state.records["reservation"], {});
    } else {
      assert.equal(resumed.results[0]?.status, "rejected");
      assert.equal(
        resumed.results[0]?.code,
        scenario === "stale" ? "stale" : "precondition"
      );
      assert.deepEqual(resumed.after, resumed.before);

      if (scenario === "stale") {
        assert.equal(steps[2]?.results[0]?.status, "committed");
        assert.equal(
          resumed.after.state.records["stock"]?.["camera"]?.values["available"],
          8 - 1
        );
      }
    }

    scenarios.push({ scenario, databasePath, steps, checks: "passed" });
  }

  return {
    format: "inventory-v2-execution-report/2",
    modelId: inventoryV2Model.id,
    execution: "executed",
    runtime: {
      node: process.version,
      effect: adapterRequire("effect/package.json").version,
      storage: "node:sqlite DatabaseSync",
    },
    scope:
      "Actual SQLite inventory API executions; each phase closes and reopens the database. Explicit deterministic host identities/clocks; not authentication, power-loss, concurrent-writer or delivery certification. Separate-process recovery is tested in inventory/v2/durable.test.ts, not asserted by this demo.",
    paths: {
      model: "inventory/v2/model.ts",
      adapter: "adapters/effect/durable.ts",
      tests: "inventory/v2/durable.test.ts",
      contract: "docs/durable-execution.md",
      databaseDirectory: directory,
    },
    durableApprovalIntegration: { status: "executed" },
    scenarios,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = await runDurableDemo();

  const target = resolve(
    process.argv[2] ?? resolve(here, "../../artifacts/inventory-v2-report.json")
  );

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${encodeJsonPretty(report)}\n`);
  process.stdout.write(
    `${encodeJsonPretty({
      report: target,
      execution: report.execution,
      scenarios: report.scenarios.map(({ scenario, checks, databasePath }) => ({
        scenario,
        checks,
        databasePath,
      })),
    })}\n`
  );
}
