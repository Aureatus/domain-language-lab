import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { errorMessage } from "../../errors.ts";
import { inventoryModel } from "../../inventory/model.ts";
import { validateModel } from "../../semantic/core.ts";
import type { Expr, Model, Scalar } from "../../semantic/types.ts";
import { encodeJson, encodeJsonPretty } from "../effect/json.ts";
import { check, writeReport } from "./check.ts";
import { generate, hash, Unsupported } from "./generate.ts";

export const PROJECTION = "inventory-stock-capacity/1";

const ACTION = "reservation.reserve";
const GUARD = `${ACTION}.capacity`;
const UPDATE = `${ACTION}.set.available`;

// Pins every declaration except the two numeric expressions intentionally translated.
// A new source shape requires a reviewed, versioned projection, not a refreshed baseline.
const STRUCTURE =
  "52c581eb7a6698617d02b9565a6f60fcb2e7ab8de1d6806eb8df2f4f361b1cc0";

function fail(message: string): never {
  throw new Unsupported(message);
}

const lit = (value: Scalar): Expr => ({ op: "literal", value });

export const obligation = {
  format: "numeric-law/v1",
  id: "inventory.available-conservation.v1",
  action: ACTION,
  ensures: {
    op: "and",
    left: { op: "le", left: lit(0), right: { op: "post", field: "available" } },
    right: {
      op: "eq",
      left: {
        op: "add",
        left: { op: "post", field: "available" },
        right: { op: "input", name: "quantity" },
      },
      right: { op: "pre", field: "available" },
    },
  },
  witness: {
    pre: { capacity: 5, available: 5, revision: 0, version: 0 },
    inputs: { quantity: 3, clock: 10 },
    post: { capacity: 5, available: 2, revision: 1, version: 1 },
  },
};

// All semantic IDs in the complete source, not merely the selected action.
function ids(source: Model) {
  return [
    source.id,
    ...Object.keys(source.resources),
    ...source.relationships.map((x) => x.id),
    ...Object.entries(source.actions).flatMap(([id, a]) => [
      id,
      ...(
        ["bindings", "policies", "preconditions", "updates"] as const
      ).flatMap((k) => a[k].map((x) => x.id)),
    ]),
  ].toSorted();
}

export function projectInventory(source: Model = inventoryModel) {
  try {
    validateModel(source);
  } catch (error) {
    fail(`Invalid inventory source: ${errorMessage(error)}`);
  }

  const original = source.actions[ACTION];
  const retainedGuard = original?.preconditions.find((x) => x.id === GUARD);
  const retainedUpdate = original?.updates.find((x) => x.id === UPDATE);

  if (!original || !retainedGuard || !retainedUpdate) {
    fail("Missing retained inventory declarations");
  }

  const skeleton = {
    ...source,
    actions: {
      ...source.actions,
      [ACTION]: {
        ...original,
        preconditions: original.preconditions.map((x) =>
          x === retainedGuard ? { ...x, when: null } : x
        ),
        updates: original.updates.map((x) =>
          x === retainedUpdate ? { ...x, value: null } : x
        ),
      },
    },
  };

  if (hash(skeleton) !== STRUCTURE) {
    fail("Inventory structural drift: versioned projection review required");
  }

  const { stock } = source.resources;
  const { quantity } = original.inputs;

  if (!stock || !quantity) {
    fail("Missing stock resource or quantity input");
  }

  const fields = Object.fromEntries(
    Object.entries(stock.fields).filter(([, s]) => s.type === "integer")
  );

  function dependency(e: Expr): void {
    switch (e.op) {
      case "literal": {
        if (typeof e.value === "number" || typeof e.value === "boolean") {
          return;
        }

        break;
      }

      case "input": {
        if (e.name === "quantity") {
          return;
        }

        break;
      }

      case "field": {
        if (e.binding === `${ACTION}.stock` && Object.hasOwn(fields, e.field)) {
          return;
        }

        break;
      }

      case "not": {
        return dependency(e.value);
      }

      case "add":
      case "sub":
      case "lt":
      case "le":
      case "eq":
      case "and":
      case "or": {
        dependency(e.left);

        return dependency(e.right);
      }
      // no default: the cases cover every e.op variant.
    }

    fail(`Unexpected retained dependency: ${encodeJson(e)}`);
  }

  dependency(retainedGuard.when);
  dependency(retainedUpdate.value);
  const binding = original.bindings.find((x) => x.id === `${ACTION}.stock`);

  if (!binding) {
    fail("Missing stock binding");
  }

  const model: Model = {
    format: source.format,
    id: "inventory.stock-capacity.v1",
    resources: { stock: { fields: structuredClone(fields) } },
    relationships: [],
    actions: {
      [ACTION]: {
        inputs: { quantity: structuredClone(quantity) },
        bindings: [{ ...structuredClone(binding), key: lit("camera") }],
        preconditions: [structuredClone(retainedGuard)],
        updates: [structuredClone(retainedUpdate)],
        policies: [],
        observe: [],
      },
    },
  };

  validateModel(model);

  const retained = [
    source.id,
    "stock",
    ACTION,
    binding.id,
    GUARD,
    UPDATE,
  ].toSorted();

  const metadata = {
    format: PROJECTION,
    source_id: source.id,
    source_sha256: hash(source),
    source: structuredClone(source),
    structure_sha256: STRUCTURE,
    projected_sha256: hash(model),
    retained_ids: retained,
    excluded_ids: ids(source).filter((id) => !retained.includes(id)),
    retained_paths: [
      "resources.stock.fields.capacity",
      "resources.stock.fields.available",
      `actions.${ACTION}.inputs.quantity`,
    ],
    excluded_paths: [
      "resources.stock.fields.watchers",
      "resources.stock.fields.operator",
      "resources.reservation",
      `actions.${ACTION}.inputs.stockId`,
      `actions.${ACTION}.inputs.slotId`,
      `actions.${ACTION}.inputs.expiresAt`,
      `actions.${ACTION}.policies`,
      `actions.${ACTION}.observe`,
      "relationships",
      "actions.reservation.cancel",
      "actions.reservation.expire",
    ],
    specializations: [
      {
        id: binding.id,
        source_key: structuredClone(binding.key),
        projected_key: lit("camera"),
      },
    ],
    exclusions: [
      "other guards (matchingStock, expectedStatus, futureExpiry)",
      "all policies/authorization",
      "reservation slot, its writes, existence, ownership and status",
      "routing, events and relationships",
      "other actions, commit tokens, concurrency, persistence, external execution",
    ],
    assumptions: [
      "existing static stock record camera",
      "numeric kernel success, not full reserve success",
      "source safe-integer schemas and intermediate overflow checks retained",
    ],
  };

  return { model, metadata };
}

export function generateInventory(
  source: Model = inventoryModel,
  law = obligation
) {
  const projected = projectInventory(source);

  return { ...generate(projected.model, law), inventory: projected.metadata };
}

export function checkInventory(
  directory: string,
  source: Model = inventoryModel,
  law = obligation
) {
  const { model, metadata } = projectInventory(source);
  mkdirSync(directory, { recursive: true });

  const report = {
    ...check(model, law, directory),
    inventory: metadata,
    inventory_adapter_sha256: hash(readFileSync(import.meta.filename, "utf-8")),
  };

  writeFileSync(
    resolve(directory, "inventory-projection.json"),
    `${encodeJsonPretty(metadata)}\n`
  );
  writeReport(directory, report);

  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const report = checkInventory(
    resolve(process.argv[2] || "/tmp/opencode/inventory-evidence/positive")
  );

  console.log(
    encodeJsonPretty({
      status: report.status,
      source_sha256: report.inventory.source_sha256,
      detail: report.detail,
    })
  );
  process.exitCode = report.status === "proof_checked" ? 0 : 1;
}
