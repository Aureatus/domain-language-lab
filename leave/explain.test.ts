import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import {
  present,
  withStatus,
  observedEvents,
} from "../semantic/test-support.ts";
import { explainEvaluation } from "./explain.ts";
import { initialState, runtime } from "./model.ts";
import { createLeaveServer } from "./server.ts";
import { requestInvocation } from "./test-support.ts";

test("multiline excerpts are exact contiguous authored source with complete declaration boundaries", () => {
  const lines = readFileSync(
    new URL("time-away.domain", import.meta.url),
    "utf-8"
  ).split("\n");

  const inv = requestInvocation({
    id: "source",
    actor: "maya",
    start: "2026-11-20",
    end: "2026-11-20",
    clock: 1,
  });

  const e = explainEvaluation(
    initialState,
    inv,
    runtime.prepare(initialState, inv)
  );

  for (const d of [...e.checks, ...e.group]) {
    assert.equal(
      d.excerpt,
      lines
        .slice(d.line - 1, d.line - 1 + d.excerpt.split("\n").length)
        .join("\n")
    );
    assert.ok(d.excerpt.includes(d.id));

    if (d.id === "leave.create") {
      assert.ok(d.excerpt.split("\n").length >= 5);
      assert.match(d.excerpt, /^\s*end$/mu);
    }
  }
});

test("diagnostic guards use interpreter semantics; evidence preserves actual outcomes", () => {
  for (const days of [1, 2, 3, 6] as const) {
    const inv = requestInvocation({
      id: `probe-${days}`,
      actor: "maya",
      start: "2026-11-23",
      end: {
        1: "2026-11-23",
        2: "2026-11-24",
        3: "2026-11-25",
        6: "2026-11-30",
      }[days],
      clock: 1,
    });

    const result = runtime.execute(initialState, inv);
    const before = JSON.stringify(initialState);

    const e = explainEvaluation(initialState, inv, result);
    assert.equal(e.outcome.status, result.status);
    assert.deepEqual(e.outcome.events, observedEvents(result) ?? []);
    assert.deepEqual(
      e.checks.map((c) => c.value),
      [false, days < 3, days >= 3, days <= 5]
    );
    assert.match(e.method, /not a live/u);
    assert.equal(JSON.stringify(initialState), before);

    for (const c of e.checks) {
      assert.ok(c.source.startsWith("leave/time-away.domain:"));
      assert.ok(c.excerpt.includes(c.id));

      const declaration = present(runtime.model.actions["leave.request"])[
        c.kind === "precondition" ? "preconditions" : "policies"
      ].find((p) => p.id === c.id);

      assert.ok(declaration);
      assert.deepEqual(c.ast.when, declaration.when);
    }
  }

  const inv = {
    ...requestInvocation({
      id: "deny",
      actor: "maya",
      start: "2026-11-20",
      end: "2026-11-20",
      clock: 1,
    }),
    actor: "leo",
  };

  const r = runtime.execute(initialState, inv);
  assert.equal(withStatus(r, "rejected").code, "denied");
  assert.equal(
    present(explainEvaluation(initialState, inv, r).checks[0]).value,
    true
  );

  const settings = present(
    present(initialState.records["settings"])["leave-rule"]
  );

  const maya = present(present(initialState.records["employee"])["maya"]);

  const changed = {
    ...initialState,
    records: {
      ...initialState.records,
      settings: {
        ...initialState.records["settings"],
        "leave-rule": {
          ...settings,
          values: { ...settings.values, threshold: 2 },
        },
      },
      employee: {
        ...initialState.records["employee"],
        maya: { ...maya, values: { ...maya.values, manager: "leo" } },
      },
    },
  };

  const two = requestInvocation({
    id: "changed-inputs",
    actor: "maya",
    start: "2026-11-26",
    end: "2026-11-27",
    clock: 1,
  });

  const pending = runtime.prepare(changed, two);
  const explanation = explainEvaluation(changed, two, pending);

  assert.deepEqual(
    explanation.checks.map((c) => c.value),
    [false, false, true, true]
  );
  assert.equal(explanation.inputs.manager, "leo");
  assert.deepEqual(present(explanation.outcome.requirements?.[0]).approvers, [
    "leo",
  ]);
});

test("generic evidence HTTP is nonmutating on preview, local-only and matches real saved results", async () => {
  const server = await createLeaveServer({
    directory: await mkdtemp("/tmp/opencode/leave-explain-test-"),
  });

  const post = async (
    path: string,
    body: object,
    headers: Record<string, string> = {}
  ) =>
    fetch(`${server.url}/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  try {
    const body = {
      actor: "maya",
      action: "leave.request",
      args: { start: "2026-11-23", end: "2026-11-25" },
    };

    let r = await (await post("actions/preview", body)).json();
    assert.equal(r.evidence.outcome.status, "pending");
    assert.equal(r.evidence.outcome.events.length, 0);
    const snapshot = await (await fetch(`${server.url}/api/snapshot`)).json();
    assert.equal(snapshot.pending.length, 0);
    r = await (await post("actions/execute", body)).json();
    assert.equal(r.status, "pending");
    assert.equal(r.evidence.outcome.status, r.status);
    assert.equal(r.snapshot.state.records.employee.maya.values.balance, 5);
    const p = r.snapshot.pending[0];
    r = await (
      await post("approvals/grant", {
        actor: "sam",
        requestId: p.id,
        policyId: p.requirements[0].policyId,
      })
    ).json();
    assert.equal(r.status, "approved");
    r = await (
      await post("approvals/resume", { actor: "sam", requestId: p.id })
    ).json();
    assert.equal(r.status, "committed");
    assert.deepEqual(
      r.evidence.outcome.events.map((e: { kind: string }) => e.kind),
      ["action", "change", "create"]
    );
    assert.equal(
      r.evidence.outcome.events[1].after,
      r.snapshot.state.records.employee.maya.values.balance
    );
    assert.equal(
      (await post("actions/preview", body, { origin: "https://example.com" }))
        .status,
      403
    );

    // Fetch normalizes Host; use an actual HTTP request to exercise this boundary.
    const badHost = await new Promise((resolve, reject) => {
      const req = httpRequest(
        `${server.url}/api/preview`,
        {
          method: "POST",
          headers: {
            host: "example.com",
            "content-type": "application/json",
            "x-leave-explain": "1",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }
      );

      req.on("error", reject);
      req.end(JSON.stringify(body));
    });

    assert.equal(badHost, 403);
    assert.equal(
      (await post("actions/preview", body, { "sec-fetch-site": "cross-site" }))
        .status,
      403
    );
    assert.equal(
      (await post("actions/preview", body, { "content-type": "text/plain" }))
        .status,
      415
    );
    assert.equal(
      (await post("actions/preview", { ...body, explain: true })).status,
      400
    );

    const invalid = await post("actions/preview", {
      ...body,
      args: { ...body.args, start: "2026-02-30" },
    });

    assert.equal(invalid.status, 400);
    assert.equal(Object.hasOwn(await invalid.json(), "evidence"), false);
  } finally {
    await server.close();
  }
});
