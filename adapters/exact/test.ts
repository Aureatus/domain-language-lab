import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import "./submission.test.ts";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Agent, request } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { deriveApplication } from "../../application/derive.ts";
import { renamedFixture } from "../../application/fixture.ts";
import { createApplicationServer } from "../../application/server.ts";
import declaration from "../../leave/model.ts";
import { present } from "../../semantic/test-support.ts";
import { createClient } from "./client.ts";
import { generate, writeAdapter } from "./generate.ts";
import loadingFixture from "./loading-fixture.ts";
import { startGateway } from "./serve.ts";

async function scratch(t: TestContext, prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));

  return directory;
}

test(
  "Exact gateway CLI serves the selected view and shuts down after SIGTERM",
  { timeout: 15000 },
  async (t) => {
    const directory = await scratch(t, "exact-cli-");
    await writeFile(
      join(directory, "index.html"),
      "<title>Local fixture</title>"
    );
    await writeFile(join(directory, "payload.bin"), new Uint8Array([4, 9]));

    for (const model of ["leave/browser.domain", "leave/model.ts"]) {
      const child = spawn(
        process.execPath,
        ["adapters/exact/serve.ts", model, directory, "0", directory],
        { stdio: ["ignore", "pipe", "pipe"] }
      );

      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      const stopped = once(child, "close");
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }

        await stopped;
      });
      const stdout = createInterface({ input: child.stdout });

      const line = await Promise.race([
        once(stdout, "line").then(([line]) => String(line)),
        stopped.then(([status]) => {
          throw Error(`Gateway exited before readiness (${status}): ${stderr}`);
        }),
      ]);

      const url = present(
        line.match(/^Exact adapter (http:\/\/127\.0\.0\.1:\d+);/)?.[1]
      );

      const page = await fetch(url);
      assert.equal(page.headers.get("content-type"), "text/html");
      assert.equal(await page.text(), "<title>Local fixture</title>");
      const file = await fetch(url + "/payload.bin");
      assert.equal(
        file.headers.get("content-type"),
        "application/octet-stream"
      );
      assert.deepEqual(await file.bytes(), new Uint8Array([4, 9]));
      assert.equal((await fetch(url + "/api/contract")).status, 200);

      for (const headers of [
        { origin: "http://localhost:1" },
        { "sec-fetch-site": "cross-site" },
      ] satisfies HeadersInit[]) {
        const refused = await fetch(url + "/api/contract", { headers });
        assert.equal(refused.status, 403);
        assert.match(await refused.text(), /Unexpected host or origin/);
      }

      assert.equal((await fetch(url + "/api/events")).status, 404);

      const oversized = await fetch(url + "/api/actions/execute", {
        method: "POST",
        body: "x".repeat(16385),
      });

      assert.equal(oversized.status, 500);
      assert.deepEqual(await oversized.json(), { error: "Request too large" });
      child.kill("SIGTERM");
      assert.deepEqual(await stopped, [0, null], stderr);
    }
  }
);

test("Exact gateway closes its backing application after a failed bind", async (t) => {
  const directory = await scratch(t, "exact-bind-failure-");
  const first = await startGateway(declaration, { directory, root: directory });
  t.after(() => first.close());
  const port = Number(new URL(first.url).port);
  await assert.rejects(
    startGateway(declaration, { directory, root: directory, port }),
    { code: "EADDRINUSE" }
  );
  assert.equal((await fetch(first.url + "/api/snapshot")).status, 200);
});

test("Exact gateway leaves no pooled API connection for an unanswered execute to replay on", async (t) => {
  const directory = await scratch(t, "exact-gateway-");

  const gateway = await startGateway(declaration, {
    directory,
    root: directory,
  });

  t.after(() => gateway.close());
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());

  function api(path: string, body?: string) {
    return new Promise<{
      status: number | undefined;
      connection: string | undefined;
      socket: Socket | null;
      text: string;
    }>((resolve, reject) => {
      const req = request(
        gateway.url + "/api/" + path,
        {
          agent,
          ...(body
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
              }
            : {}),
        },
        (res) => {
          const socket = res.socket;
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              connection: res.headers.connection,
              socket,
              text,
            })
          );
        }
      );

      req.on("error", reject);
      req.end(body);
    });
  }

  const contract = await api("contract");
  const snapshot = await api("snapshot");

  const { contractId } = JSON.parse(contract.text);
  const submissionId = crypto.randomUUID();

  const execute = await api(
    "actions/execute",
    JSON.stringify({
      actor: "maya",
      action: "leave.request",
      args: { start: "2026-11-23", end: "2026-11-25" },
      expectedContractId: contractId,
      submissionId,
    })
  );

  const reconcile = await api(
    "actions/reconcile",
    JSON.stringify({
      actor: "maya",
      expectedContractId: contractId,
      submissionId,
    })
  );

  for (const reply of [contract, snapshot, execute, reconcile]) {
    assert.equal(reply.status, 200);
    assert.equal(reply.connection, "close");
  }

  assert.equal(
    new Set(
      [contract, snapshot, execute, reconcile].map((reply) => reply.socket)
    ).size,
    4
  );
  assert.deepEqual(JSON.parse(reconcile.text), JSON.parse(execute.text));
});

test("each Exact placeholder follows its view; waiting never suppresses another view", () => {
  const contract = structuredClone(deriveApplication(loadingFixture).contract);
  const render = () => generate({ contract, contractId: "fixture" }).contract;

  const output = render();
  assert.match(
    output,
    /progress .*aria-label="Loading Record group 0…" testId="loading:0:icon"/
  );
  assert.match(output, /text "Loading Record group 1…" role="status"/);
  assert.match(
    output,
    /column role="status" aria-label="Loading Record group 2…".*\n +box /
  );
  assert.doesNotMatch(output, /Loading Record group 3|loading:3:/);
  contract.views.forEach((v) => {
    v.loading = "wait";
  });
  assert.doesNotMatch(render(), /testId="loading:/);
  assert.match(render(), /testId="screen-failed"/);
});

test("generated Exact mapping uses real durable HTTP pending, grants, resume and balance", async (t) => {
  const directory = await scratch(t, "exact-mapping-");
  const server = await createApplicationServer(declaration, { directory });

  try {
    const envelope = await (await fetch(server.url + "/api/contract")).json();
    const c = createClient(envelope, server.url);
    await c.snapshot();
    const output = generate(envelope, { api: server.url });
    assert.ok(output.contract.includes("saveGrant(actor, id, policy)"));
    assert.ok(
      output.manifest.sourceMap.some(
        (m) => m.semanticId === "action:leave.request"
      )
    );
    assert.ok(!output.ts.includes("balance -"));
    assert.ok(!output.ts.includes("days >="));
    await writeAdapter(envelope, "artifacts/exact-app", {
      api: "http://127.0.0.1:4186",
    });

    const { createClient: generatedClient } = await import(
      pathToFileURL("artifacts/exact-app/client.mjs").href
    );

    assert.deepEqual(
      await generatedClient(envelope, server.url).snapshot(),
      await c.snapshot()
    );

    const balance = () =>
      c
        .snapshot()
        .then((s) => s.state.records["employee"]?.["maya"]?.values["balance"]);

    const start = await balance();
    assert.ok(typeof start === "number");

    const request = {
      actor: "maya",
      action: "leave.request",
      args: { start: "2026-11-23", end: "2026-11-25" },
    };

    const preview = await c.request("actions/preview", request);
    assert.equal(preview.status, "pending");
    const execute = await c.command("actions/execute", request);
    assert.equal(execute.ok, true);
    assert.equal(await balance(), start);
    let s = await c.snapshot();

    const p = present(s.pending.at(-1));
    const r = present(p.requirements[0]);
    const approver = present(r.approvers[0]);

    assert.equal(present(c.project(s, "maya").inbox[0]).complete, false);
    assert.equal(
      present(present(c.project(s, approver).inbox[0]).grants[0]).eligible,
      true
    );

    const grant = await c.command("approvals/grant", {
      actor: approver,
      requestId: p.id,
      policyId: r.policyId,
    });

    assert.equal(grant.ok, true);
    assert.equal(await balance(), start);
    assert.equal(
      present(c.project(await c.snapshot(), approver).inbox[0]).complete,
      true
    );

    const resume = await c.command("approvals/resume", {
      actor: approver,
      requestId: p.id,
    });

    assert.equal(resume.ok, true);
    assert.equal(await balance(), start - 3);
    assert.equal(c.project(await c.snapshot(), approver).inbox.length, 0);

    const duplicate = await c.command("approvals/resume", {
      actor: approver,
      requestId: p.id,
    });

    assert.equal(duplicate.ok, false);
    assert.match(duplicate.message, /Approval is saved, but completion failed/);
    await c.request("actions/execute", { ...request, actor: "leo" });
    const staleRequest = present((await c.snapshot()).pending.at(-1));
    await c.request("approvals/grant", {
      actor: approver,
      requestId: staleRequest.id,
      policyId: r.policyId,
    });
    await c.request("actions/execute", {
      actor: approver,
      action: "settings.change",
      args: { threshold: 4 },
    });

    const stale = await c.command("approvals/resume", {
      actor: approver,
      requestId: staleRequest.id,
    });

    assert.equal(stale.ok, false);
    assert.match(stale.message, /Approval is saved, but completion failed/);
    const retained = present((await c.snapshot()).pending.at(-1));
    assert.equal(retained.grants.length, 1);
    assert.equal(retained.stale, true);
    assert.equal(
      (await c.snapshot()).state.records["employee"]?.["leo"]?.values[
        "balance"
      ],
      5
    );
    const bad = structuredClone(envelope);
    bad.contract.actions["leave.request"].fields.find(
      (f: { hidden: boolean }) => !f.hidden
    ).schema.type = "ids";
    assert.throws(
      () => generate(bad, { api: server.url }),
      /Unsupported field/
    );

    const mismatch = createClient(
      { ...envelope, contractId: "wrong" },
      server.url
    );

    await assert.rejects(() => mismatch.snapshot(), /Declaration changed/);

    const offline = createClient(envelope, server.url, async () => {
      throw Error("offline");
    });

    const failure = await offline.command("approvals/resume", {});
    assert.equal(failure.ok, false);
    assert.match(failure.message, /ambiguous outcome/);
    await writeFile(
      "artifacts/exact-http-report.json",
      JSON.stringify(
        {
          format: "exact-http-mapping/v1",
          contractId: envelope.contractId,
          initialBalance: start,
          pendingBalance: start,
          grantBalance: start,
          resumedBalance: start - 3,
          preview: preview.status,
          requestId: p.id,
          grant: grant.message,
          resume: resume.message,
          duplicate: duplicate.message,
          staleCompletion: stale.message,
          staleGrantRetained: retained.grants.length === 1,
          staleBalance: 5,
          scope:
            "Real HTTP/SQLite mapping test, not Exact UI or native execution.",
        },
        null,
        2
      )
    );
  } finally {
    await server.close();
  }
});

test("renamed non-leave schemas generate references, enums, integers and booleans", async (t) => {
  const server = await createApplicationServer(renamedFixture(), {
    directory: await scratch(t, "exact-fixture-"),
  });

  try {
    const envelope = await (await fetch(server.url + "/api/contract")).json();
    const c = createClient(envelope, server.url);

    const generated = await writeAdapter(envelope, "artifacts/exact-fixture", {
      api: "http://127.0.0.1:4186",
    });

    assert.match(generated.contract, /type="checkbox"/);
    assert.match(generated.contract, /select value=/);
    assert.match(generated.ts, /Number\(v1\)/);
    assert.ok(!generated.ts.includes("leave.request"));

    const s = await c.snapshot();
    const args = { ...present(s.defaults["ari"]?.["kit.issue"]), units: 2 };

    await c.request("actions/execute", {
      actor: "ari",
      action: "kit.issue",
      args,
    });
    const p = present((await c.snapshot()).pending[0]);
    assert.equal(present(p.requirements[0]).approvers[0], "devon");
    await c.request("approvals/grant", {
      actor: "devon",
      requestId: p.id,
      policyId: present(
        p.requirements.find((r) => r.approvers.includes("devon"))
      ).policyId,
    });
    await c.request("approvals/resume", { actor: "devon", requestId: p.id });
    assert.equal(
      (await c.snapshot()).state.records["rack"]?.["parts"]?.values[
        "remaining"
      ],
      6
    );
  } finally {
    await server.close();
  }
});

test("inbox coverage follows every captured server requirement, not a single manager assumption", async (t) => {
  const model = renamedFixture();
  const issue = model.domain.actions["kit.issue"];
  const original = issue?.policies[1];

  assert.ok(issue && original?.effect === "approval-required");

  const policy = {
    ...original,
    id: "kit.second-review",
    approvers: { op: "literal", value: "ari" },
    allowSelfApproval: true,
  };

  const domain = {
    ...model.domain,
    actions: {
      ...model.domain.actions,
      "kit.issue": { ...issue, policies: [...issue.policies, policy] },
    },
  };

  const server = await createApplicationServer(
    { ...model, domain },
    { directory: await scratch(t, "exact-multi-") }
  );

  try {
    const envelope = await (await fetch(server.url + "/api/contract")).json();
    const c = createClient(envelope, server.url);
    const s = await c.snapshot();

    await c.request("actions/execute", {
      actor: "ari",
      action: "kit.issue",
      args: { ...present(s.defaults["ari"]?.["kit.issue"]), units: 2 },
    });
    const p = present((await c.snapshot()).pending[0]);
    assert.equal(p.requirements.length, 2);
    await c.request("approvals/grant", {
      actor: "devon",
      requestId: p.id,
      policyId: present(p.requirements[0]).policyId,
    });
    assert.equal(
      present(c.project(await c.snapshot(), "ari").inbox[0]).complete,
      false
    );

    const incomplete = await c.command("approvals/resume", {
      actor: "ari",
      requestId: p.id,
    });

    assert.equal(incomplete.ok, false);
    await c.request("approvals/grant", {
      actor: "ari",
      requestId: p.id,
      policyId: present(p.requirements.find((r) => r.approvers.includes("ari")))
        .policyId,
    });
    assert.equal(
      present(c.project(await c.snapshot(), "ari").inbox[0]).complete,
      true
    );

    const complete = await c.command("approvals/resume", {
      actor: "ari",
      requestId: p.id,
    });

    assert.equal(complete.ok, true);
    assert.equal(
      (await c.snapshot()).state.records["rack"]?.["parts"]?.values[
        "remaining"
      ],
      6
    );
    await writeFile(
      "artifacts/exact-multiple-requirements-report.json",
      JSON.stringify(
        {
          requirements: p.requirements,
          oneGrantComplete: false,
          twoGrantsComplete: true,
          incompleteResume: incomplete,
          completeResume: complete,
          remaining: 6,
          scope:
            "Real renamed fixture HTTP/SQLite run; self-approval explicitly declared in second test policy.",
        },
        null,
        2
      )
    );
  } finally {
    await server.close();
  }
});

test("transport never overwrites a newer accepted snapshot with an older HTTP reply", async () => {
  const { contract } = deriveApplication(declaration);

  const responses = [
    { contractId: "same", snapshotVersion: 8, marker: "new" },
    { contractId: "same", snapshotVersion: 7, marker: "old" },
    { contractId: "other", snapshotVersion: 9 },
  ];

  const c = createClient(
    { contract, contractId: "same" },
    "http://127.0.0.1:1",
    async () => Response.json(responses.shift())
  );

  const first = await c.snapshot();
  const second = await c.snapshot();

  assert.ok("marker" in first && "marker" in second);
  assert.equal(first.marker, "new");
  assert.equal(second.marker, "new");
  await assert.rejects(() => c.snapshot(), /Declaration changed/);
});
