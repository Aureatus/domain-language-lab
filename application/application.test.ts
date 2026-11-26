import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decodeJsonObject, encodeJson } from "../adapters/effect/json.ts";
import leave from "../leave/model.ts";
import { present } from "../semantic/test-support.ts";
import { deriveApplication, buildInvocation } from "./derive.ts";
import { fixture, renamedFixture, extendedFixture } from "./fixture.ts";
import { createApplicationServer } from "./server.ts";

test("leave contract retains the published submission identity", () => {
  const { model, contract } = deriveApplication(leave);
  assert.equal(
    createHash("sha256").update(encodeJson({ model, contract })).digest("hex"),
    "136de0f000fc5aed5febb25583ca25c9ecdacb562bd42b50b54124f2c92d4144"
  );
});

test("absent presentation does not inherit config for valid prototype-named inputs and actions", () => {
  const source = structuredClone(fixture);
  present(source.domain.actions["supply.take"]).inputs["toString"] = {
    type: "string",
  };
  source.domain.actions["toString"] = {
    inputs: {},
    bindings: [],
    preconditions: [],
    policies: [],
    updates: [],
    inserts: [],
    deletes: [],
    observe: [],
  };
  const { actions: _actions, ...application } = source.application;
  const { contract } = deriveApplication({ ...source, application });
  const action = present(contract.actions["supply.take"]);
  assert.ok(
    action.fields.some(
      (field) => field.name === "toString" && field.widget === "text"
    )
  );
  assert.equal(present(contract.actions["toString"]).id, "toString");
});

test("schema-invalid JSON is durably rejected and can be reconciled", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "application-invalid-receipt-")
  );

  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await createApplicationServer(leave, { directory });
  t.after(() => server.close());

  const submit = async (path: string, body: object) => {
    const response = await fetch(`${server.url}/api/actions/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encodeJson(body),
    });

    assert.equal(response.status, 200);

    return decodeJsonObject(await response.text());
  };

  const receipt = { actor: "leo", submissionId: "null-threshold" };

  const rejected = await submit("execute", {
    ...receipt,
    action: "settings.change",
    args: { threshold: null },
  });

  assert.equal(rejected["status"], "rejected");
  assert.equal(rejected["code"], "schema");
  const reconciled = await submit("reconcile", receipt);
  assert.equal(reconciled["submissionId"], receipt.submissionId);
  assert.equal(reconciled["status"], "rejected");
  assert.equal(reconciled["code"], "schema");
  assert.deepEqual(reconciled["args"], { threshold: null });
});

test("automatic input types, inferred references, added actions/inputs and policy changes alter contract", () => {
  const { contract } = deriveApplication(fixture);
  const a = present(contract.actions["supply.take"]);

  assert.deepEqual(
    a.fields.map((f) => [f.name, f.widget]),
    [
      ["cabinetKey", "select"],
      ["quantity", "number"],
      ["reason", "select"],
      ["tracked", "checkbox"],
    ]
  );
  assert.equal(present(a.fields[0]).reference?.resource, "cabinet");
  const { actions: _actions, ...inferredMeta } = fixture.application;
  const inferred = { ...structuredClone(fixture), application: inferredMeta };
  assert.deepEqual(
    present(
      present(deriveApplication(inferred).contract.actions["supply.take"])
        .fields[0]
    ).reference,
    { resource: "cabinet" }
  );
  const changed = structuredClone(fixture);
  present(changed.domain.actions["supply.take"]).inputs["memo"] = {
    type: "string",
  };

  const review = present(
    present(changed.domain.actions["supply.take"]).policies[1]
  );

  assert.equal(review.effect, "approval-required");
  review.approvers = { op: "literal", value: "nora" };
  changed.domain.actions["supply.audit"] = {
    inputs: { comment: { type: "string" } },
    bindings: [],
    policies: [
      {
        id: "audit.allow",
        effect: "allow",
        when: { op: "literal", value: true },
      },
    ],
    preconditions: [],
    updates: [],
    inserts: [],
    deletes: [],
    observe: [],
  };
  const derived = deriveApplication(changed);
  assert.ok(
    present(derived.contract.actions["supply.take"]).fields.some(
      (f) => f.name === "memo"
    )
  );
  assert.equal(
    present(present(derived.contract.actions["supply.audit"]).fields[0]).label,
    "Comment"
  );

  const inv = buildInvocation(derived.contract, {
    action: "supply.take",
    actor: "quinn",
    args: {
      cabinetKey: "tools",
      quantity: 2,
      reason: "Repair",
      tracked: true,
      memo: "Test",
    },
    id: "i",
    clock: 1,
  });

  const result = derived.runtime.prepare(derived.initialState, inv);
  assert.equal(result.status, "pending");
  assert.deepEqual(present(result.request.requirements[0]).approvers, ["nora"]);
});

test("hidden actor/id/clock/constant mappings are host-owned, not client defaults or overrides", () => {
  const x = structuredClone(fixture);
  const a = present(x.domain.actions["supply.take"]);

  Object.assign(a.inputs, {
    operator: { type: "string" },
    nonce: { type: "string" },
    stamp: { type: "integer", min: 0 },
    origin: { type: "string", enum: ["host"] },
  });
  Object.assign(x.application.actions["supply.take"].fields, {
    operator: { binding: { source: "actor" } },
    nonce: { binding: { source: "operation-id" } },
    stamp: { binding: { source: "clock" } },
    origin: { binding: { source: "constant", value: "host" } },
  });

  const { contract } = deriveApplication(x);

  const args = {
    cabinetKey: "tools",
    quantity: 1,
    reason: "Repair",
    tracked: true,
  };

  const i = buildInvocation(contract, {
    action: "supply.take",
    actor: "nora",
    id: "command-one",
    clock: 42,
    args,
  });

  assert.deepEqual(i.args, {
    ...args,
    operator: "nora",
    nonce: "command-one",
    stamp: 42,
    origin: "host",
  });
  assert.ok(
    present(contract.actions["supply.take"])
      .fields.filter((f) =>
        ["operator", "nonce", "stamp", "origin"].includes(f.name)
      )
      .every((f) => f.hidden)
  );
  assert.throws(() =>
    buildInvocation(contract, {
      action: "supply.take",
      actor: "nora",
      id: "command-two",
      clock: 42,
      args: { ...args, stamp: 0 },
    })
  );
});

test("all matching approval policies must be granted; inbox records actual requirements and grants", async () => {
  const x = extendedFixture();
  present(x.domain.actions["supply.take"]).policies.push({
    id: "supply.second-review",
    effect: "approval-required",
    when: { op: "literal", value: true },
    approvers: { op: "literal", value: "quinn" },
  });

  const server = await createApplicationServer(x, {
    directory: await mkdtemp("/tmp/opencode/multiple-approvals-"),
  });

  const post = async (path: string, body: object) => {
    const r = await fetch(`${server.url}/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(r.status, 200);

    return r.json();
  };

  try {
    let r = await post("actions/execute", {
      actor: "nora",
      action: "supply.take",
      args: {
        cabinetKey: "tools",
        quantity: 2,
        reason: "Repair",
        tracked: false,
        memo: "Both policies",
      },
    });

    const p = r.snapshot.pending[0];
    assert.deepEqual(
      p.requirements.map((entry: { approvers: string[] }) => entry.approvers),
      [["rory"], ["quinn"]]
    );
    await post("approvals/grant", {
      actor: "rory",
      requestId: p.id,
      policyId: p.requirements[0].policyId,
    });
    r = await post("approvals/resume", { actor: "rory", requestId: p.id });
    assert.equal(r.status, "rejected");
    assert.equal(r.snapshot.state.records.cabinet.tools.values.stock, 8);
    r = await post("approvals/grant", {
      actor: "quinn",
      requestId: p.id,
      policyId: p.requirements[1].policyId,
    });
    assert.equal(r.snapshot.pending[0].grants.length, 2);
    r = await post("approvals/resume", { actor: "quinn", requestId: p.id });
    assert.equal(r.status, "committed");
    assert.equal(r.snapshot.state.records.cabinet.tools.values.stock, 6);
  } finally {
    await server.close();
  }
});

test("invalid/unsupported presentation, references, bindings, adapters fail at startup", () => {
  const request = ["application", "actions", "leave.request"];
  const fields = [...request, "fields"];

  const threshold = [
    "application",
    "actions",
    "settings.change",
    "fields",
    "threshold",
  ];

  const firstActor = present(leave.application.actors[0]);

  const mutations: [parent: string[], key: string, value: unknown][] = [
    [["application", "actions"], "unknown", {}],
    [fields, "typo", {}],
    [[...fields, "start"], "widget", "html"],
    [[...fields, "start"], "template", "<h1>custom</h1>"],
    [[...fields, "employeeId", "binding"], "source", "javascript"],
    [[...request, "adapters", "0"], "name", "unknown/v1"],
    [[...request, "adapters", "0", "mapping"], "output", "typo"],
    [[...threshold, "default"], "field", "typo"],
    [["application", "views", "0", "fields", "0"], "field", "typo"],
    [["application", "views", "0"], "resource", "unknown"],
    [
      ["application", "actors"],
      String(leave.application.actors.length),
      firstActor,
    ],
    [
      [...fields, "start"],
      "reference",
      { resource: "employee", labelField: "typo" },
    ],
    [
      threshold.slice(0, -1),
      "threshold",
      {
        ...present(
          leave.application.actions["settings.change"]?.fields["threshold"]
        ),
        default: "not a number",
      },
    ],
    [threshold, "binding", { source: "actor" }],
    [["application", "views", "2", "columns", "1"], "format", "eval"],
    [[...fields, "employeeId"], "binding", null],
    [["application"], "actions", []],
    [[], "handler", "not supported"],
    [[...fields, "employeeId"], "default", "maya"],
    [["application", "actions"], "toString", {}],
    [["application", "actions"], "leave.request", null],
    [fields, "start", null],
    [request, "adapters", null],
    [["application"], "views", null],
  ];

  for (const [path, key, value] of mutations) {
    const x = structuredClone(leave);
    let target: unknown = x;

    for (const member of path) {
      assert.ok(
        target && typeof target === "object" && Object.hasOwn(target, member)
      );
      target = Reflect.get(target, member);
    }

    assert.ok(target && typeof target === "object");
    assert.ok(Reflect.set(target, key, value));
    assert.throws(() => deriveApplication(x));
  }
});

const cases: [
  name: string,
  declaration: unknown,
  action: string,
  actor: string,
  approver: string,
  args: object,
  resource: string,
  record: string,
  stock: string,
  policy: string,
][] = [
  [
    "non-leave",
    fixture,
    "supply.take",
    "nora",
    "quinn",
    { cabinetKey: "tools", quantity: 2, reason: "Repair", tracked: true },
    "cabinet",
    "tools",
    "stock",
    "supply.review",
  ],
  [
    "systematically renamed",
    renamedFixture(),
    "kit.issue",
    "ari",
    "devon",
    { rackId: "parts", units: 2, purpose: "Repair", logged: true },
    "rack",
    "parts",
    "remaining",
    "kit.authorization",
  ],
];

for (const [
  name,
  declaration,
  action,
  actor,
  approver,
  args,
  resource,
  record,
  stock,
  policy,
] of cases) {
  test(`${name}: same contract drives generic route, pending requirements, grant/resume, projections`, async () => {
    const server = await createApplicationServer(declaration, {
      directory: await mkdtemp("/tmp/opencode/application-test-"),
    });

    const post = async (path: string, body: object) => {
      const response = await fetch(`${server.url}/api/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      assert.equal(response.status, 200);

      return response.json();
    };

    try {
      const { contractId, contract } = await (
        await fetch(`${server.url}/api/contract`)
      ).json();

      assert.deepEqual(contract, deriveApplication(declaration).contract);
      let r = await post("actions/preview", { actor, action, args });
      assert.equal(r.status, "pending");
      assert.deepEqual(r.requirements, [
        { policyId: policy, approvers: [approver], allowSelfApproval: false },
      ]);
      r = await post("actions/execute", { actor, action, args });
      assert.equal(r.contractId, contractId);
      const p = r.snapshot.pending[0];
      assert.equal(r.snapshot.state.records[resource][record].values[stock], 8);
      assert.equal(
        (
          await post("approvals/grant", {
            actor,
            requestId: p.id,
            policyId: policy,
          })
        ).code,
        "unauthorized-approval"
      );
      r = await post("approvals/grant", {
        actor: approver,
        requestId: p.id,
        policyId: policy,
      });
      assert.equal(r.status, "approved");
      assert.equal(r.snapshot.state.records[resource][record].values[stock], 8);
      r = await post("approvals/resume", { actor: approver, requestId: p.id });
      assert.equal(r.status, "committed");
      assert.equal(r.snapshot.state.records[resource][record].values[stock], 6);
      assert.equal(
        (await post("approvals/resume", { actor: approver, requestId: p.id }))
          .code,
        "consumed"
      );
    } finally {
      await server.close();
    }
  });
}
