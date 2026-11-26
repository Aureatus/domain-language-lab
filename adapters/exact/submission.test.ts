import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveApplication } from "../../application/derive.ts";
import { fixture } from "../../application/fixture.ts";
import { createClient, submissionDriver } from "./client.ts";

const { contract } = deriveApplication(fixture);

test("only a bound 400 no-write disposition unlocks an Exact submission", async () => {
  for (const fault of [
    "none",
    "http",
    "contract",
    "id",
    "disposition",
    "json",
  ]) {
    let calls = 0;

    const client = createClient(
      { contract, contractId: "c" },
      "http://127.0.0.1:1",
      async (_, options) => {
        calls += 1;
        assert.ok(typeof options?.body === "string");
        const { submissionId } = JSON.parse(options.body);
        const status = fault === "http" ? 500 : 400;

        if (fault === "json") {
          return new Response("invalid JSON", { status });
        }

        return Response.json(
          {
            error: "Fix the input.",
            disposition: fault === "disposition" ? "other" : "not-submitted",
            contractId: fault === "contract" ? "other" : "c",
            submissionId: fault === "id" ? "other" : submissionId,
          },
          { status }
        );
      }
    );

    const driver = submissionDriver(client, "a", "x");
    const result = await driver.run("submit", { n: 7 });
    assert.equal(result.phase, fault === "none" ? "editing" : "unknown", fault);

    if (fault === "none") {
      assert.equal(result.message, "Fix the input.");
    }

    await driver.run("submit", { n: 8 });
    assert.equal(calls, fault === "none" ? 2 : 1, fault);
  }
});

test("Exact submission recovery retries the captured command, not the latest draft", async () => {
  const commands: Record<string, unknown>[] = [];

  const client = createClient(
    { contract, contractId: "c" },
    "http://127.0.0.1:1",
    async (url, options) => {
      assert.ok(typeof options?.body === "string");
      const body = JSON.parse(options.body);
      commands.push(body);
      assert.equal(body.expectedContractId, "c");

      if (commands.length === 1) {
        throw new Error("No response");
      }

      const receipt = { contractId: "c", submissionId: body.submissionId };

      if (String(url).endsWith("/reconcile")) {
        return Response.json(
          commands.length === 2
            ? { ...receipt, status: "not-found" }
            : { ...receipt, status: "committed", message: "Saved." }
        );
      }

      return Response.json({
        ...receipt,
        status: "committed",
        message: "Saved.",
      });
    }
  );

  const driver = submissionDriver(client, "nora", "supply.take");
  assert.equal((await driver.run("retry")).phase, "editing");
  assert.deepEqual(commands, []);
  assert.equal((await driver.run("submit", { quantity: 1 })).phase, "unknown");
  assert.equal((await driver.run("check")).phase, "retryable");
  assert.deepEqual(await driver.run("retry", { quantity: 2 }), {
    phase: "known",
    message: "Saved.",
  });
  assert.deepEqual(commands[0], commands[2]);
  assert.deepEqual(commands[1], {
    actor: "nora",
    expectedContractId: "c",
    submissionId: commands[0]?.["submissionId"],
  });
  const reconciled = await client.request("actions/reconcile", commands[1]);
  assert.equal(reconciled.message, "Original submission outcome: Saved.");
});

test("an Exact receipt for another submission cannot unlock the draft", async () => {
  const client = createClient(
    { contract, contractId: "c" },
    "http://127.0.0.1:1",
    async () =>
      Response.json({
        contractId: "c",
        submissionId: "different",
        status: "committed",
      })
  );

  const driver = submissionDriver(client, "nora", "supply.take");
  assert.equal((await driver.run("submit", { quantity: 1 })).phase, "unknown");
  assert.equal((await driver.run("check")).phase, "unknown");
  await assert.rejects(
    client.request("actions/execute", { submissionId: "original" }),
    /receipt identity mismatch/
  );
});

test("Exact reports a failed completion without implying an approval was rolled back", async () => {
  const client = createClient(
    { contract, contractId: "c" },
    "http://127.0.0.1:1",
    async () =>
      Response.json({
        contractId: "c",
        status: "rejected",
        message: "Request is stale.",
      })
  );

  assert.deepEqual(
    await client.command("approvals/resume", { requestId: "original" }),
    {
      ok: false,
      message: "Approval is saved, but completion failed. Request is stale.",
    }
  );
  assert.deepEqual(
    await client.command("approvals/grant", { requestId: "original" }),
    { ok: false, message: "Request is stale." }
  );

  const badSnapshot = createClient(
    { contract, contractId: "c" },
    "http://127.0.0.1:1",
    async () => Response.json({ contractId: "c", snapshotVersion: "1" })
  );

  await assert.rejects(badSnapshot.snapshot(), /Unsupported snapshot version/);
});
