import assert from "node:assert/strict";
import test from "node:test";

import { present, withStatus } from "../test-support.ts";
import {
  createInterpreter,
  validateModel,
  validateState,
  jsonSnapshot,
} from "./core.ts";
import type { Expr, Interpreter, Model, Scalar, State } from "./types.ts";

type Mutable<T> = T extends object
  ? { -readonly [K in keyof T]: Mutable<T[K]> }
  : T;

const lit = (value: Scalar): Mutable<Expr> => ({ op: "literal", value });
const input = (name: string): Mutable<Expr> => ({ op: "input", name });

const field = (binding: string, name: string): Mutable<Expr> => ({
  op: "field",
  binding,
  field: name,
});

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function fixture() {
  const model: Mutable<Model> = {
    format: "semantic-core/v2",
    id: "example.v2",
    resources: {
      items: {
        fields: {
          amount: { type: "integer", min: 0 },
          owner: { type: "string" },
          reviewers: { type: "ids" },
        },
      },
    },
    relationships: [{ id: "owner.path", resource: "items", field: "owner" }],
    actions: {
      move: {
        inputs: { from: { type: "string" }, to: { type: "string" } },
        bindings: [{ id: "source", resource: "items", key: input("from") }],
        preconditions: [],
        policies: [{ id: "permit", when: lit(true), effect: "allow" }],
        updates: [],
        inserts: [
          {
            id: "make",
            resource: "items",
            key: input("to"),
            values: {
              amount: field("source", "amount"),
              owner: { op: "actor" },
              reviewers: field("source", "reviewers"),
            },
          },
        ],
        deletes: [{ id: "remove", target: "source" }],
        observe: [
          { binding: "source", relationship: "owner.path" },
          { binding: "make", relationship: "owner.path" },
        ],
      },
    },
  };

  const state: Mutable<State> = {
    revision: 0,
    records: {
      items: {
        old: {
          version: 4,
          values: { amount: 7, owner: "former", reviewers: ["boss", "actor"] },
        },
      },
    },
  };

  const inv = {
    id: "call1",
    action: "move",
    args: { from: "old", to: "new" },
    actor: "actor",
    clock: 10,
  };

  return { model, state, inv };
}

function pendingFixture() {
  const f = fixture();
  present(f.model.actions["move"]).policies.push({
    id: "review",
    effect: "approval-required",
    when: lit(true),
    approvers: field("source", "reviewers"),
  });

  const runtime = createInterpreter(f.model);
  const pending = runtime.execute(f.state, f.inv);

  assert.equal(pending.status, "pending");

  const granted = runtime.approve(pending.request, {
    policyId: "review",
    approver: "boss",
  });

  assert.equal(granted.status, "approved");

  return { ...f, runtime, pending, receipt: granted.receipt };
}

test("grouped lifecycle, frozen prestate RHS, lifecycle facts and deletion routing", () => {
  const { model, state, inv } = fixture();
  const original = copy(state);

  const r = createInterpreter(model).execute(state, inv);
  assert.equal(r.status, "committed");
  assert.deepEqual(state, original);
  assert.equal(present(r.state.records["items"])["old"], undefined);
  assert.deepEqual(present(r.state.records["items"])["new"], {
    version: 0,
    values: { amount: 7, owner: "actor", reviewers: ["boss", "actor"] },
  });
  assert.equal(r.state.revision, 1);
  assert.deepEqual(
    r.events.map((e) => e.kind),
    ["action", "create", "delete"]
  );
  assert.deepEqual(
    present(r.events[0]).recipients.map((r) => r.recipient),
    ["former"]
  );

  const removed = present(r.events[2]);
  const created = present(r.events[1]);

  assert.equal(removed.kind, "delete");
  assert.equal(created.kind, "create");
  assert.deepEqual(removed.before, present(original.records["items"])["old"]);
  assert(Object.isFrozen(created.after.values));
});

test("rollback on existing, missing, duplicate insert/delete and aliased update/delete", () => {
  const variants: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.inv.args.to = "old";
    },
    (f) => {
      f.inv.args.from = "absent";
    },
    (f) => {
      const a = present(f.model.actions["move"]);
      a.inserts.push({ ...copy(present(a.inserts[0])), id: "make2" });
    },
    (f) => {
      present(f.model.actions["move"]).deletes.push({
        id: "remove2",
        target: "source",
      });
    },
    (f) => {
      const a = present(f.model.actions["move"]);
      a.bindings.push({ id: "alias", resource: "items", key: input("from") });
      a.updates.push({
        id: "u",
        target: "alias",
        field: "amount",
        value: lit(1),
      });
    },
    (f) => {
      present(present(f.model.actions["move"]).inserts[0]).values["amount"] =
        lit(-1);
    },
  ];

  for (const mutate of variants) {
    const f = fixture();
    mutate(f);

    const before = copy(f.state);
    const r = createInterpreter(f.model).execute(f.state, f.inv);

    assert.equal(r.status, "rejected");
    assert.equal("events" in r, false);
    assert.strictEqual(r.state, f.state);
    assert.deepEqual(f.state, before);
  }
});

test("same-field aliases reject, distinct fields grouped against immutable prestate", () => {
  const { model, state, inv } = fixture();
  const a = present(model.actions["move"]);

  a.inserts = [];
  a.deletes = [];
  a.observe = [];
  a.bindings.push({ id: "alias", resource: "items", key: input("from") });
  a.updates = [
    { id: "u1", target: "source", field: "amount", value: lit(2) },
    {
      id: "u2",
      target: "alias",
      field: "amount",
      value: field("source", "amount"),
    },
  ];
  assert.equal(
    withStatus(createInterpreter(model).execute(state, inv), "rejected").code,
    "conflicting-update"
  );
  a.updates[1] = {
    id: "u2",
    target: "alias",
    field: "owner",
    value: field("source", "owner"),
  };
  const r = createInterpreter(model).execute(state, inv);
  assert.equal(r.status, "committed");
  assert.equal(present(present(r.state.records["items"])["old"]).version, 5);
  assert.deepEqual(
    r.events.map((e) => e.kind),
    ["action", "change"]
  );
});

test("no-op and empty groups advance revision; only written records advance version; overflow atomic", () => {
  const { model, state, inv } = fixture();
  const a = present(model.actions["move"]);

  a.inserts = [];
  a.deletes = [];
  a.observe = [];
  let r = createInterpreter(model).execute(state, inv);
  assert.equal(r.status, "committed");
  assert.equal(r.state.revision, 1);
  assert.equal(present(present(r.state.records["items"])["old"]).version, 4);
  assert.equal(r.events.length, 1);
  a.updates = [
    {
      id: "noop",
      target: "source",
      field: "amount",
      value: field("source", "amount"),
    },
  ];
  r = createInterpreter(model).execute(state, inv);
  assert.equal(r.status, "committed");
  assert.equal(present(present(r.state.records["items"])["old"]).version, 5);
  assert.equal(r.events.length, 1);
  present(present(state.records["items"])["old"]).version =
    Number.MAX_SAFE_INTEGER;
  assert.equal(
    withStatus(createInterpreter(model).execute(state, inv), "rejected").code,
    "overflow"
  );
  a.updates = [];
  state.revision = Number.MAX_SAFE_INTEGER;
  assert.equal(
    withStatus(createInterpreter(model).execute(state, inv), "rejected").code,
    "overflow"
  );
});

test("malformed IR fails closed even unreachable, exact complete fields and approval declarations", () => {
  const mutations: ((
    model: Mutable<Model>,
    move: Mutable<Model>["actions"][string]
  ) => void)[] = [
    (m) => {
      Reflect.set(m, "format", "semantic-core/v1");
    },
    (_m, a) => {
      Reflect.deleteProperty(a, "inserts");
    },
    (_m, a) => {
      delete present(a.inserts[0]).values["owner"];
    },
    (_m, a) => {
      present(a.inserts[0]).values["extra"] = lit(1);
    },
    (_m, a) => {
      present(a.inserts[0]).values["amount"] = lit("bad");
    },
    (_m, a) => {
      present(a.inserts[0]).key = field("source", "owner");
    },
    (_m, a) => {
      a.updates.push({
        id: "u",
        target: "make",
        field: "owner",
        value: lit("x"),
      });
    },
    (_m, a) => {
      Reflect.set(a, "policies", [
        { id: "review", effect: "approval-required", when: lit(false) },
      ]);
    },
    (_m, a) => {
      Reflect.set(present(a.policies[0]), "approvers", lit("boss"));
    },
    (_m, a) => {
      Reflect.set(present(a.inserts[0]).values, "owner", { op: "unknown" });
    },
  ];

  for (const mutate of mutations) {
    const { model } = fixture();
    mutate(model, present(model.actions["move"]));
    assert.throws(() => validateModel(model));
  }

  const { model, state } = fixture();
  present(present(state.records["items"])["old"]).values["extra"] = 1;
  assert.throws(() => validateState(model, state));
  assert.throws(() =>
    jsonSnapshot({
      get bad() {
        throw Error("must not run");
      },
    })
  );
});

test("allow, pending without writes/events, deny dominates and failed precondition is not pending", () => {
  const { model, state, inv } = fixture();
  const a = present(model.actions["move"]);

  assert.equal(
    createInterpreter(model).execute(state, inv).status,
    "committed"
  );
  a.policies.push({
    id: "review",
    effect: "approval-required",
    when: lit(true),
    approvers: lit("boss"),
  });
  const pending = createInterpreter(model).execute(state, inv);
  assert.equal(pending.status, "pending");
  assert.strictEqual(pending.state, state);
  assert.equal("events" in pending, false);
  assert.equal("prepared" in pending, false);
  a.preconditions = [{ id: "notReady", when: lit(false) }];
  assert.equal(
    withStatus(createInterpreter(model).execute(state, inv), "rejected").code,
    "precondition"
  );
  a.preconditions = [];
  a.policies.push({ id: "ban", effect: "deny", when: lit(true) });
  assert.equal(
    withStatus(createInterpreter(model).execute(state, inv), "rejected").code,
    "denied"
  );
  a.policies = [];
  assert.equal(
    withStatus(createInterpreter(model).execute(state, inv), "rejected").code,
    "denied"
  );
});

test("serialized positive grant/resume across interpreter restart and explicit resumed clock", () => {
  const f = pendingFixture();
  const rt = createInterpreter(copy(f.model));

  const r = rt.resume(
    copy(f.state),
    copy(f.inv),
    copy(f.pending.request),
    [copy(f.receipt)],
    { clock: 12 }
  );

  assert.equal(r.status, "committed");
  assert.equal(present(r.events[0]).clock, 12);
  assert.equal(present(r.state.records["items"])["old"], undefined);
  assert.equal(rt.execute(f.state, f.inv).status, "pending"); // no policy rewrite/bypass persists
  assert.equal(
    withStatus(
      rt.resume(f.state, f.inv, f.pending.request, [], { clock: 12 }),
      "rejected"
    ).code,
    "approval"
  );

  const foreign: ReturnType<Interpreter["commit"]> = Reflect.apply(
    rt.commit,
    rt,
    [f.state, copy(f.pending.request)]
  );

  assert.equal(withStatus(foreign, "rejected").code, "invalid-token");
});

test("unauthorized/self approval rejected unless explicitly enabled; every matching policy needs a grant", () => {
  const f = pendingFixture();

  for (const approver of ["intruder", "actor"]) {
    assert.equal(
      withStatus(
        f.runtime.approve(f.pending.request, { policyId: "review", approver }),
        "rejected"
      ).code,
      "unauthorized-approval"
    );
  }

  const bad = { ...copy(f.receipt), approver: "intruder" };
  assert.equal(
    withStatus(
      f.runtime.resume(f.state, f.inv, f.pending.request, [bad], { clock: 12 }),
      "rejected"
    ).code,
    "unauthorized-approval"
  );
  const policy = present(present(f.model.actions["move"]).policies[1]);
  assert.equal(policy.effect, "approval-required");
  policy.allowSelfApproval = true;
  present(f.model.actions["move"]).policies.push({
    id: "second",
    effect: "approval-required",
    when: lit(true),
    approvers: lit("other"),
  });

  const rt = createInterpreter(f.model);
  const p = rt.execute(f.state, f.inv);

  const g = rt.approve(withStatus(p, "pending").request, {
    policyId: "review",
    approver: "actor",
  });

  assert.equal(g.status, "approved");
  assert.equal(
    withStatus(
      rt.resume(f.state, f.inv, withStatus(p, "pending").request, [g.receipt], {
        clock: 10,
      }),
      "rejected"
    ).code,
    "approval"
  );

  const second = rt.approve(withStatus(p, "pending").request, {
    policyId: "second",
    approver: "other",
  });

  assert.equal(
    rt.resume(
      f.state,
      f.inv,
      withStatus(p, "pending").request,
      [g.receipt, withStatus(second, "approved").receipt],
      { clock: 10 }
    ).status,
    "committed"
  );
});

test("changed full model, policy, args, actor, clock, state and receipt/request invalidate binding", () => {
  const f = pendingFixture();

  const resume = (
    rt: Interpreter,
    state: State,
    inv: typeof f.inv,
    request = f.pending.request,
    receipt = f.receipt
  ) =>
    withStatus(
      rt.resume(state, inv, request, [receipt], { clock: 12 }),
      "rejected"
    );

  const models: ((m: typeof f.model) => void)[] = [
    (m) => {
      m.id = "different";
    },
    (m) => {
      const policy = present(present(m.actions["move"]).policies[1]);
      assert.equal(policy.effect, "approval-required");
      policy.approvers = lit("other");
    },
    (m) => {
      const field = present(present(m.resources["items"]).fields["amount"]);
      assert.equal(field.type, "integer");
      field.max = 100;
    },
    (m) => {
      present(m.actions["move"]).policies.splice(1);
    },
  ];

  for (const change of models) {
    const m = copy(f.model);
    change(m);
    assert.equal(resume(createInterpreter(m), f.state, f.inv).code, "stale");
  }

  const invocations: ((i: typeof f.inv) => void)[] = [
    (i) => {
      i.args.to = "other";
    },
    (i) => {
      i.actor = "other";
    },
    (i) => {
      i.clock++;
    },
    (i) => {
      i.id = "newCall";
    },
  ];

  for (const change of invocations) {
    const i = copy(f.inv);
    change(i);
    assert.equal(resume(f.runtime, f.state, i).code, "stale");
  }

  const states: ((s: typeof f.state) => void)[] = [
    (s) => {
      s.revision++;
    },
    (s) => {
      present(present(s.records["items"])["old"]).version++;
    },
    (s) => {
      const values = present(present(s.records["items"])["old"]).values;
      const amount = values["amount"];

      assert.ok(typeof amount === "number");
      values["amount"] = amount + 1;
    },
    (s) => {
      const items = present(s.records["items"]);
      items["unrelated"] = copy(present(items["old"]));
    },
  ];

  for (const change of states) {
    const s = copy(f.state);
    change(s);
    assert.equal(resume(f.runtime, s, f.inv).code, "stale");
  }

  const original = copy(f.pending.request);
  const [first, ...other] = original.requirements;

  assert.ok(first);

  const request = {
    ...original,
    requirements: [
      { ...first, approvers: [...first.approvers, "intruder"] },
      ...other,
    ],
  };

  assert.equal(resume(f.runtime, f.state, f.inv, request).code, "stale");

  const grant = copy(f.receipt);
  const invocation = grant.request.invocation;

  const receipt = {
    ...grant,
    request: {
      ...grant.request,
      invocation: { ...invocation, args: { ...invocation.args, to: "other" } },
    },
  };

  assert.equal(
    resume(f.runtime, f.state, f.inv, f.pending.request, receipt).code,
    "stale"
  );
});

test("resume uses fresh clock: preconditions/deny rechecked, approval cannot disappear into allow", () => {
  for (const scenario of ["precondition", "denied", "stale"]) {
    const f = fixture();
    const a = present(f.model.actions["move"]);

    const guard: Mutable<Expr> = {
      op: "lt",
      left: { op: "clock" },
      right: lit(20),
    };

    a.policies.push({
      id: "review",
      effect: "approval-required",
      when: scenario === "stale" ? guard : lit(true),
      approvers: lit("boss"),
    });

    if (scenario === "precondition") {
      a.preconditions.push({ id: "deadline", when: guard });
    }

    if (scenario === "denied") {
      a.policies.push({
        id: "lateBan",
        effect: "deny",
        when: { op: "not", value: guard },
      });
    }

    const rt = createInterpreter(f.model);
    const p = rt.execute(f.state, f.inv);

    const g = rt.approve(withStatus(p, "pending").request, {
      policyId: "review",
      approver: "boss",
    });

    assert.equal(
      withStatus(
        rt.resume(
          f.state,
          f.inv,
          withStatus(p, "pending").request,
          [withStatus(g, "approved").receipt],
          { clock: 21 }
        ),
        "rejected"
      ).code,
      scenario
    );
    assert.equal(
      withStatus(
        rt.resume(
          f.state,
          f.inv,
          withStatus(p, "pending").request,
          [withStatus(g, "approved").receipt],
          { clock: 9 }
        ),
        "rejected"
      ).code,
      "invalid"
    );
  }
});

test("optimistic commit compares entire latest state, interpreter-bound tokens and no consumed authority", () => {
  const f = fixture();
  const rt = createInterpreter(f.model);
  const p = rt.prepare(f.state, f.inv);
  const changed = copy(f.state);

  changed.revision++;
  assert.equal(
    withStatus(
      rt.commit(changed, withStatus(p, "prepared").prepared),
      "rejected"
    ).code,
    "stale"
  );
  assert.equal(
    withStatus(
      createInterpreter(f.model).commit(
        f.state,
        withStatus(p, "prepared").prepared
      ),
      "rejected"
    ).code,
    "invalid-token"
  );
  assert.equal(
    withStatus(
      rt.commit(f.state, copy(withStatus(p, "prepared").prepared)),
      "rejected"
    ).code,
    "invalid-token"
  );
  const result = rt.commit(f.state, withStatus(p, "prepared").prepared);
  assert.equal(result.status, "committed");
  assert.equal(
    withStatus(
      rt.commit(result.state, withStatus(p, "prepared").prepared),
      "rejected"
    ).code,
    "stale"
  );
});

test("mixed update and multiple inserts read prestate, then route poststate; late routing failure rolls back", () => {
  const f = fixture();
  const a = present(f.model.actions["move"]);

  a.deletes = [];
  a.updates = [
    { id: "adjust", target: "source", field: "amount", value: lit(1) },
    {
      id: "reassign",
      target: "source",
      field: "owner",
      value: lit("nextOwner"),
    },
  ];
  a.inserts.push({
    ...copy(present(a.inserts[0])),
    id: "makeSecond",
    key: lit("second"),
  });

  const before = copy(f.state);
  const r = createInterpreter(f.model).execute(f.state, f.inv);

  assert.equal(r.status, "committed");
  assert.equal(
    present(present(r.state.records["items"])["old"]).values["amount"],
    1
  );
  assert.equal(
    present(present(r.state.records["items"])["new"]).values["amount"],
    7
  );
  assert.equal(
    present(present(r.state.records["items"])["second"]).values["amount"],
    7
  );
  assert.equal(present(present(r.state.records["items"])["old"]).version, 5);
  assert.equal(r.state.revision, 1);
  assert.deepEqual(
    present(r.events[0]).recipients.map((r) => r.recipient),
    ["nextOwner"]
  );
  present(a.updates[1]).value = lit("not a recipient id");
  const rejected = createInterpreter(f.model).execute(f.state, f.inv);
  assert.equal(withStatus(rejected, "rejected").code, "routing");
  assert.equal("events" in rejected, false);
  assert.deepEqual(f.state, before);
});

test("safe arithmetic rejects intermediate overflow and eager boolean RHS, not only final totals", () => {
  const f = fixture();
  const a = present(f.model.actions["move"]);

  a.deletes = [];
  a.inserts = [];
  a.observe = [];

  const overflow: Mutable<Expr> = {
    op: "add",
    left: lit(Number.MAX_SAFE_INTEGER),
    right: lit(1),
  };

  a.updates = [
    {
      id: "adjust",
      target: "source",
      field: "amount",
      value: { op: "sub", left: overflow, right: lit(1) },
    },
  ];
  assert.equal(
    withStatus(createInterpreter(f.model).execute(f.state, f.inv), "rejected")
      .code,
    "overflow"
  );
  a.updates = [];
  present(a.policies[0]).when = {
    op: "or",
    left: lit(true),
    right: { op: "eq", left: overflow, right: lit(0) },
  };
  assert.equal(
    withStatus(createInterpreter(f.model).execute(f.state, f.inv), "rejected")
      .code,
    "overflow"
  );
});

test("resumed preparation still requires latest full state at commit and keeps original models immutable", () => {
  const f = pendingFixture();
  const modelBefore = copy(f.runtime.model);
  const invocationBefore = copy(f.inv);

  const p = f.runtime.prepareResume(
    f.state,
    f.inv,
    f.pending.request,
    [f.receipt],
    { clock: 15 }
  );

  assert.equal(p.status, "prepared");
  const changed = copy(f.state);
  present(present(changed.records["items"])["old"]).values["owner"] = "other";
  assert.equal(
    withStatus(f.runtime.commit(changed, p.prepared), "rejected").code,
    "stale"
  );
  const r = f.runtime.commit(f.state, p.prepared);
  assert.equal(r.status, "committed");
  assert.equal(present(r.events[0]).clock, 15);
  assert.deepEqual(f.runtime.model, modelBefore);
  assert.deepEqual(f.inv, invocationBefore);
  assert.equal(f.runtime.execute(f.state, f.inv).status, "pending");
});

test("deleted prototype-shaped but valid identity routes from own prestate record", () => {
  const f = fixture();
  Object.defineProperty(f.state.records["items"], "toString", {
    value: present(f.state.records["items"])["old"],
    writable: true,
    enumerable: true,
    configurable: true,
  });
  delete present(f.state.records["items"])["old"];
  f.inv.args.from = "toString";
  f.inv.args.to = "valueOf";
  const r = createInterpreter(f.model).execute(f.state, f.inv);
  assert.equal(r.status, "committed");
  assert.equal(
    Object.hasOwn(present(r.state.records["items"]), "toString"),
    false
  );
  assert.equal(
    Object.hasOwn(present(r.state.records["items"]), "valueOf"),
    true
  );
  assert.deepEqual(
    present(r.events[0]).recipients.map((r) => r.recipient),
    ["former"]
  );
});
