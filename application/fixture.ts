import { ownValue } from "../semantic/core.ts";
// Tiny non-leave MODEL TEST fixture; not another shipped application.
import { validateModel, validateState } from "../semantic/v2/core.ts";
import type { Expr, Model, Scalar } from "../semantic/v2/types.ts";

const literal = (value: Scalar): Expr => ({ op: "literal", value });
const input = (name: string): Expr => ({ op: "input", name });

const field = (name: string): Expr => ({
  op: "field",
  binding: "selected",
  field: name,
});

type Mutable<T> = T extends object
  ? { -readonly [K in keyof T]: Mutable<T[K]> }
  : T;

const domain: Mutable<Model> = {
  format: "semantic-core/v2",
  id: "supplies-test",
  resources: {
    cabinet: {
      fields: {
        caption: { type: "string" },
        stock: { type: "integer", min: 0 },
        reviewer: { type: "string" },
      },
    },
  },
  relationships: [],
  actions: {
    "supply.take": {
      inputs: {
        cabinetKey: { type: "string" },
        quantity: { type: "integer", min: 1, max: 10 },
        reason: { type: "string", enum: ["Workshop", "Repair"] },
        tracked: { type: "boolean" },
      },
      bindings: [
        { id: "selected", resource: "cabinet", key: input("cabinetKey") },
      ],
      preconditions: [
        {
          id: "supply.available",
          when: { op: "le", left: input("quantity"), right: field("stock") },
        },
      ],
      policies: [
        {
          id: "supply.small",
          effect: "allow",
          when: { op: "lt", left: input("quantity"), right: literal(2) },
        },
        {
          id: "supply.review",
          effect: "approval-required",
          when: { op: "le", left: literal(2), right: input("quantity") },
          approvers: field("reviewer"),
        },
      ],
      updates: [
        {
          id: "supply.spend",
          target: "selected",
          field: "stock",
          value: { op: "sub", left: field("stock"), right: input("quantity") },
        },
      ],
      inserts: [],
      deletes: [],
      observe: [],
    },
  },
};

export const fixture = {
  domain,
  initialState: {
    revision: 0,
    records: {
      cabinet: {
        tools: {
          version: 0,
          values: { caption: "Tool cabinet", stock: 8, reviewer: "quinn" },
        },
      },
    },
  },
  application: {
    version: "model-application/v1",
    title: "Supply fixture",
    actors: [
      { id: "nora", label: "Nora" },
      { id: "quinn", label: "Quinn" },
    ],
    actions: {
      "supply.take": {
        fields: {
          cabinetKey: {
            reference: { resource: "cabinet", labelField: "caption" },
          },
          quantity: { default: 1 },
        },
      },
    },
  },
};

export function renamedFixture() {
  const names: Record<string, string> = {
    cabinet: "rack",
    caption: "description",
    stock: "remaining",
    reviewer: "checker",
    selected: "chosen",
    "supply.take": "kit.issue",
    cabinetKey: "rackId",
    quantity: "units",
    reason: "purpose",
    tracked: "logged",
    nora: "ari",
    quinn: "devon",
    tools: "parts",
    "supply.review": "kit.authorization",
    "supply.small": "kit.direct",
    "supply.available": "kit.available",
    "supply.spend": "kit.spend",
  };

  // oxlint-disable-next-line anti-slop/no-unknown-returns -- rewrites arbitrary JSON fixture data; validateModel parses the result.
  function rename(x: unknown): unknown {
    if (Array.isArray(x)) {
      return x.map(rename);
    }

    if (x && typeof x === "object") {
      return Object.fromEntries(
        Object.entries(x).map(([k, v]) => [ownValue(names, k) ?? k, rename(v)])
      );
    }

    return typeof x === "string" ? (ownValue(names, x) ?? x) : x;
  }

  const innerDomain = validateModel(rename(fixture.domain));

  return {
    domain: innerDomain,
    initialState: validateState(innerDomain, rename(fixture.initialState)),
    application: rename(fixture.application),
  };
}

export function extendedFixture() {
  const x = structuredClone(fixture);
  x.application.actors.push({ id: "rory", label: "Rory" });
  const take = x.domain.actions["supply.take"];

  if (!take) {
    throw new Error("Expected supply.take fixture action");
  }

  take.inputs["memo"] = { type: "string" };
  const review = take.policies[1];

  if (review?.effect !== "approval-required") {
    throw new Error("Expected review policy");
  }

  review.approvers = { op: "literal", value: "rory" };
  x.domain.actions["supply.audit"] = {
    inputs: { note: { type: "string" } },
    bindings: [],
    preconditions: [],
    policies: [
      { id: "supply.audit-allowed", effect: "allow", when: literal(true) },
    ],
    updates: [],
    inserts: [],
    deletes: [],
    observe: [],
  };

  return x;
}
