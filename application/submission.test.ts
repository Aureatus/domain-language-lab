import assert from "node:assert/strict";
import test from "node:test";

import { createApplicationClient } from "./client.ts";
import {
  submissionStep as step,
  submissionControls,
  submissionWireBody,
} from "./submission.ts";
import type { SubmissionEvent } from "./submission.ts";

const contract = {
  format: "derived-application/v1",
  title: "Test",
  eyebrow: "",
  subtitle: "",
  scope: "Local",
  actors: [],
  actions: {},
  views: [],
  resources: {},
  relationships: [],
};

test("oversized UTF-8 payloads never dispatch; wrong receipt IDs never resolve the draft", async () => {
  let calls = 0;

  const client = createApplicationClient("http://localhost", {
    fetch: async () =>
      Response.json(
        ++calls === 1
          ? { contractId: "c", contract }
          : { contractId: "c", submissionId: "wrong", status: "committed" }
      ),
  });

  await client.contract();

  const body = {
    actor: "person",
    action: "reserve",
    args: { note: "❄".repeat(6000) },
    submissionId: "expected",
  };

  await assert.rejects(
    client.execute(body),
    (e) => e instanceof Error && "notSubmitted" in e && e.notSubmitted === true
  );
  assert.equal(calls, 1);
  body.args.note = "ok";
  await assert.rejects(client.execute(body), /identity mismatch/);
  assert.equal(calls, 2);
});

test("submission size counts two-, three- and four-byte characters at the wire limit", () => {
  const command = (input: string) => ({ args: { input } });

  const remaining =
    16384 - Buffer.byteLength(submissionWireBody(command(""), "c"));

  const mixed = "Aé雪🙂";
  const input = mixed + "x".repeat(remaining - Buffer.byteLength(mixed));
  const wire = submissionWireBody(command(input), "c");
  assert.equal(Buffer.byteLength(wire), 16384);
  assert.deepEqual(JSON.parse(wire), {
    ...command(input),
    expectedContractId: "c",
  });
  assert.throws(
    () => submissionWireBody(command(input + "🙂"), "c"),
    /Submission is too large/
  );
});

test("a lost response locks resubmission; absence permits replay only of the captured command", () => {
  const body = { actor: "person", action: "reserve", args: { units: 2 } };
  const sent = step({ phase: "editing" }, { type: "submit", id: "one", body });
  body.args.units = 3;
  const unknown = step(sent, { type: "lost" });
  assert.deepEqual(submissionControls(unknown), {
    submit: false,
    check: true,
    retry: false,
  });

  const invalid: SubmissionEvent[] = [
    { type: "submit", id: "two", body },
    { type: "retry" },
    { type: "missing" },
    { type: "found", result: { status: "committed" } },
  ];

  for (const event of invalid) {
    assert.throws(() => step(unknown, event));
  }

  const checking = step(unknown, { type: "check" });
  assert.deepEqual(step(checking, { type: "lost" }), unknown);
  const retry = { type: "retry", id: "two", body } as const;
  const retried = step(step(checking, { type: "missing" }), retry);
  assert.deepEqual(retried, sent);
  assert.equal(retried.body?.args["units"], 2);

  for (const status of ["pending", "committed", "rejected"]) {
    const receipt = { status };
    assert.deepEqual(
      step(checking, { type: "found", result: receipt }),
      step(retried, { type: "found", result: receipt })
    );
  }
});
