import assert from "node:assert/strict";
import test from "node:test";

import { createHost, competition, replay } from "../../inventory/host.ts";
import { createApp } from "../../live/core.ts";
import { present } from "../../semantic/test-support.ts";
import {
  decodeJson,
  decodeStrictJson,
  decodeJsonValue,
  decodeJsonObject,
  encodeJson,
  encodeJsonPretty,
  encodeCanonicalJson,
  DurableOutcomeSchema,
  DurableOperationOutcomeSchema,
  DurableReceiptSchema,
  ApplicationExecuteRequestSchema,
  ApplicationGrantRequestSchema,
  ActionEventsTraceSchema,
  SubmissionTraceSchema,
  WorkspaceExecuteRequestSchema,
  WorkspaceApproveRequestSchema,
  WorkspaceResumeRequestSchema,
  ApplicationSavedSubmissionsSchema,
  ApplicationSnapshotSchema,
  ReviewEventSchema,
  WorkspaceChangeSchema,
  LiveWorkspaceDocumentSchema,
  InventoryReplaySchema,
} from "./json.ts";

test("encodeCanonicalJson sorts keys lexicographically and rejects non-JSON values", () => {
  assert.equal(
    encodeCanonicalJson({
      b: 1,
      "10": 2,
      "2": 3,
      a: { z: true, m: [null, "x"] },
    }),
    '{"10":2,"2":3,"a":{"m":[null,"x"],"z":true},"b":1}'
  );
  assert.throws(() => encodeCanonicalJson(undefined));
  assert.throws(() => encodeCanonicalJson(Number.NaN));
  assert.throws(() => encodeCanonicalJson(Number.POSITIVE_INFINITY));
});

test("decodeJsonObject and encodeJson/encodeJsonPretty round-trip JSON cleanly", () => {
  assert.deepEqual(decodeJsonObject('{"days":3,"reason":"rest"}'), {
    days: 3,
    reason: "rest",
  });
  assert.throws(() => decodeJsonObject("[1,2,3]"));
  assert.throws(() => decodeJsonObject('"hello"'));
  assert.throws(() => decodeJsonObject("{broken"));
  assert.equal(encodeJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(encodeJsonPretty({ a: 1 }), '{\n  "a": 1\n}');
  assert.deepEqual(decodeJsonValue('[1,true,null,"ok"]'), [
    1,
    true,
    null,
    "ok",
  ]);
});

test("browser submission storage round-trips unresolved commands and rejects corrupt entries", () => {
  const saved = [
    {
      phase: "checking",
      id: "request-1",
      body: { actor: "maya", action: "leave.request", args: { days: 3 } },
    },
  ];

  const decode = (text: string) =>
    decodeStrictJson(ApplicationSavedSubmissionsSchema, text);

  assert.deepEqual(
    decode(encodeJson(saved, ApplicationSavedSubmissionsSchema)),
    saved
  );
  assert.deepEqual(decode("[]"), []);

  for (const raw of [
    "",
    "{}",
    "[null]",
    '[{"phase":"known","id":"request-1","body":{"actor":"maya","action":"leave.request","args":{}}}]',
  ]) {
    assert.throws(() => decode(raw));
  }
});

test("browser SSE codecs require snapshot and change envelopes without discarding JSON payloads", () => {
  const snapshot = {
    contractId: "contract",
    snapshotVersion: 0,
    state: { revision: 0, records: {} },
    pending: [],
    defaults: {},
    availability: {},
  };

  const change = {
    sequence: 0,
    invalidations: [{ view: "snapshot" }],
    recipients: [],
    reason: "resync",
  };

  for (const [schema, value] of [
    [ApplicationSnapshotSchema, snapshot],
    [WorkspaceChangeSchema, change],
  ] as const) {
    assert.deepEqual(decodeJson(schema, encodeJson(value)), value);

    for (const raw of ["", "{}", "{broken"]) {
      assert.throws(() => decodeJson(schema, raw));
    }
  }

  assert.deepEqual(
    decodeJson(
      WorkspaceChangeSchema,
      encodeJson({
        ...change,
        sequence: 1,
        invalidations: [],
        reason: "outcome",
      })
    ).invalidations,
    []
  );
});

test("action review replay validates variant fields and nested receipts", () => {
  const grant = {
    type: "grant",
    actor: "reviewer",
    policyId: "policy",
    result: {
      contractId: "contract",
      status: "approved",
      evidence: {
        phase: "grant",
        invocation: {
          id: "inv",
          actor: "writer",
          action: "request",
          args: { amount: null },
        },
        outcome: { status: "approved", events: [] },
      },
    },
  };

  const decode = (event: unknown) =>
    decodeJson(ReviewEventSchema, encodeJson(event));

  assert.deepEqual(decode(grant), grant);
  assert.throws(() => decode({ ...grant, actor: undefined }));
  assert.throws(() =>
    decode({
      ...grant,
      result: { ...grant.result, snapshot: { contractId: "contract" } },
    })
  );
  assert.throws(() =>
    decode({
      ...grant,
      result: {
        ...grant.result,
        evidence: { ...grant.result.evidence, invocation: { id: 1 } },
      },
    })
  );
});

test("browser Live workspace codec round-trips empty and populated journals without bypassing replay", () => {
  const app = createApp({ clock: () => 0 });

  const decode = (text: string) =>
    decodeStrictJson(LiveWorkspaceDocumentSchema, text);

  const empty = app.exportWorkspace();
  assert.deepEqual(
    decode(encodeJson(empty, LiveWorkspaceDocumentSchema)),
    empty
  );
  assert.equal(
    app.dispatch("comment", { issueId: "i1", body: "Saved draft" }, "u1").ok,
    true
  );
  const document = app.exportWorkspace();

  const loaded = decode(
    encodeJsonPretty(document, LiveWorkspaceDocumentSchema)
  );

  assert.deepEqual(loaded, document);
  assert.deepEqual(createApp().restoreWorkspace(loaded), { ok: true });

  for (const raw of [
    "",
    '{"format":"live-issue-workspace/v1","seedVersion":1,"journal":[],"extra":true}',
  ]) {
    assert.throws(() => decode(raw));
  }

  assert.equal(
    app.restoreWorkspace(
      decode(encodeJson({ ...document, journal: [{ kind: "unsupported" }] }))
    ).ok,
    false
  );
  assert.deepEqual(app.exportWorkspace(), document);
});

test("browser Inventory replay codec preserves exact observation and final-state verification", () => {
  const decode = (text: string) => decodeJson(InventoryReplaySchema, text);

  for (const host of [createHost(), competition(true)]) {
    const bundle = host.export();
    assert.deepEqual(
      replay(decode(encodeJsonPretty(bundle, InventoryReplaySchema))).export(),
      bundle
    );
  }

  const bundle = competition(false).export();
  assert.throws(() => decode(""));
  assert.throws(() => decode(encodeJson({ ...bundle, steps: null })));
  assert.throws(
    () =>
      replay(
        decode(
          encodeJson({ ...bundle, final: { ...bundle.final, revision: 0 } })
        )
      ),
    /Replay final mismatch/u
  );

  const reordered = {
    ...bundle,
    final: Object.fromEntries(Object.entries(bundle.final).toReversed()),
  };

  assert.throws(
    () => replay(decode(encodeJson(reordered))),
    /Replay final mismatch/u
  );
});

test("DurableOutcomeSchema and DurableOperationOutcomeSchema validate discriminated unions and preserve extra fields", () => {
  const committed = decodeJson(
    DurableOutcomeSchema,
    encodeJson({
      status: "committed",
      state: { revision: 1, records: {} },
      events: [{ id: "e1", kind: "created" }],
      extra: 42,
    })
  );

  assert.equal(committed.status, "committed");
  assert.equal(present(committed.events[0])["kind"], "created");
  assert.equal(committed["extra"], 42);

  assert.throws(() =>
    decodeJson(
      DurableOutcomeSchema,
      '{"status":"committed","state":{},"events":[{"id":123}]}'
    )
  );
  assert.throws(() =>
    decodeJson(DurableOutcomeSchema, '{"status":"pending","state":{}}')
  );
  assert.throws(() =>
    decodeJson(DurableOutcomeSchema, '{"status":"rejected","state":{}}')
  );

  const approved = decodeJson(
    DurableOperationOutcomeSchema,
    encodeJson({
      status: "approved",
      receipt: {
        format: "semantic-approval-receipt/v2",
        request: { id: "r1" },
        policyId: "p1",
        approver: "bob",
        sig: "ok",
      },
    })
  );

  assert.equal(approved.status, "approved");
  assert.equal(approved.receipt["sig"], "ok");
  assert.throws(() =>
    decodeJson(
      DurableReceiptSchema,
      '{"format":"wrong","request":{},"policyId":"p1","approver":"bob"}'
    )
  );
});

test("Application and Workspace request schemas enforce strict keys, bounded identities, and safe clocks", () => {
  const execReq = decodeStrictJson(
    ApplicationExecuteRequestSchema,
    encodeJson({
      actor: "maya",
      action: "leave.request",
      args: { days: 2 },
      submissionId: "sub-1",
    })
  );

  assert.equal(execReq.submissionId, "sub-1");
  assert.throws(() =>
    decodeStrictJson(
      ApplicationExecuteRequestSchema,
      '{"actor":"maya","action":"a","args":{},"extra":1}'
    )
  );
  assert.throws(() =>
    decodeStrictJson(
      ApplicationExecuteRequestSchema,
      '{"actor":"maya","action":"a","args":{},"submissionId":"   "}'
    )
  );
  assert.throws(() =>
    decodeStrictJson(
      ApplicationGrantRequestSchema,
      '{"actor":"bob","requestId":"","policyId":"p1"}'
    )
  );

  const wsExec = decodeStrictJson(
    WorkspaceExecuteRequestSchema,
    encodeJson({
      profile: "v2",
      invocation: {
        id: "inv-1",
        action: "reserve",
        args: {},
        actor: "alice",
        clock: 0,
      },
    })
  );

  assert.equal(wsExec.invocation.clock, 0);
  assert.throws(() =>
    decodeStrictJson(
      WorkspaceExecuteRequestSchema,
      '{"profile":"v2","invocation":{"id":"constructor","action":"reserve","args":{},"actor":"alice","clock":0}}'
    )
  );
  assert.throws(() =>
    decodeStrictJson(
      WorkspaceExecuteRequestSchema,
      '{"profile":"v2","invocation":{"id":"inv-1","action":"reserve","args":{},"actor":"alice","clock":-1}}'
    )
  );
  assert.throws(() =>
    decodeStrictJson(
      WorkspaceApproveRequestSchema,
      '{"profile":"v1","command":{"id":"c1","invocationId":"i1","policyId":"p1"},"actor":"bob"}'
    )
  );
  assert.throws(() =>
    decodeStrictJson(
      WorkspaceResumeRequestSchema,
      '{"profile":"v2","command":{"id":"c1","invocationId":"i1","clock":1.5}}'
    )
  );
});

test("ActionEventsTraceSchema and SubmissionTraceSchema validate replay traces", () => {
  const trace = decodeJson(
    ActionEventsTraceSchema,
    encodeJson({
      format: "action-events/v1",
      contractId: "c1",
      action: "leave.request",
      actor: "maya",
      args: {},
      events: [{ type: "open" }],
    })
  );

  assert.equal(trace.events.length, 1);

  const nonObjectArgsTrace = decodeJson(
    ActionEventsTraceSchema,
    encodeJson({
      format: "action-events/v1",
      contractId: "c1",
      action: "leave.request",
      actor: "maya",
      args: null,
      events: [{ type: "open" }],
    })
  );

  assert.equal(nonObjectArgsTrace.args, null);
  assert.throws(() =>
    decodeJson(
      ActionEventsTraceSchema,
      '{"format":"wrong","contractId":"c1","action":"a","actor":"b","args":{},"events":[]}'
    )
  );

  const subTrace = decodeJson(
    SubmissionTraceSchema,
    '[{"type":"submit","id":"s1","body":{"actor":"maya"}},{"type":"lost"}]'
  );

  assert.equal(subTrace.length, 2);
  assert.throws(() => decodeJson(SubmissionTraceSchema, '[{"type":"bogus"}]'));
});
