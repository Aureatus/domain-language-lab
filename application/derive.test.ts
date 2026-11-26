import assert from "node:assert/strict";
import test from "node:test";

import { present } from "../semantic/test-support.ts";
import { buildInvocation, deriveApplication, inputDefaults } from "./derive.ts";
import { fixture } from "./fixture.ts";

const action = "supply.take";

function withFields(fields: Record<string, unknown>) {
  return {
    ...fixture,
    application: { ...fixture.application, actions: { [action]: { fields } } },
  };
}

test("input bindings and widgets must agree with the declared schema", () => {
  for (const [fields, message] of [
    [{ quantity: { binding: { source: "constant" } } }, /Missing constant/],
    [
      { quantity: { binding: { source: "constant", value: {} } } },
      /Binding\/schema mismatch/,
    ],
    [{ quantity: { default: null } }, /Default\/schema mismatch/],
    [
      { quantity: { binding: { source: "clock", value: 1 } } },
      /Unexpected binding value/,
    ],
    [
      { quantity: { reference: { resource: "cabinet" } } },
      /Unknown or incompatible input reference/,
    ],
    [
      { cabinetKey: { reference: { resource: "missing" } } },
      /Unknown or incompatible input reference/,
    ],
    [{ quantity: { widget: "date" } }, /Widget\/schema mismatch/],
    [{ cabinetKey: { widget: "number" } }, /Widget\/schema mismatch/],
    [{ cabinetKey: { widget: "checkbox" } }, /Widget\/schema mismatch/],
    [{ tracked: { widget: "select" } }, /Widget\/schema mismatch/],
    [{ tracked: { widget: "text" } }, /Unsupported schema\/widget override/],
    [{ quantity: { widget: "text" } }, /Unsupported schema\/widget override/],
    [
      { reason: { widget: "text" } },
      /Enums and references require select widgets/,
    ],
  ] satisfies [Record<string, unknown>, RegExp][]) {
    assert.throws(() => deriveApplication(withFields(fields)), message);
  }
});

test("a declared default reads the selected actor record, never another actor’s record", () => {
  const model = withFields({
    quantity: {
      default: { resource: "cabinet", key: "$actor", field: "stock" },
    },
  });

  assert.throws(() => deriveApplication(model), /Default\/schema mismatch/);
  const { tools } = fixture.initialState.records.cabinet;

  const initialState = {
    revision: 0,
    records: {
      cabinet: {
        tools,
        nora: { ...tools, values: { ...tools.values, stock: 3 } },
      },
    },
  };

  const { contract, initialState: state } = deriveApplication({
    ...model,
    initialState,
  });

  assert.equal(inputDefaults(contract, action, state, "nora")["quantity"], 3);
  assert.equal(
    inputDefaults(contract, action, state, "quinn")["quantity"],
    undefined
  );
  assert.throws(
    () => inputDefaults(contract, "missing", state, "nora"),
    /Unknown action/
  );
  assert.throws(
    () =>
      buildInvocation(contract, {
        action: "missing",
        actor: "nora",
        id: "test",
        clock: 0,
        args: {},
      }),
    /Unknown action/
  );
  assert.throws(
    () =>
      buildInvocation(contract, {
        action,
        actor: "missing",
        id: "test",
        clock: 0,
        args: {},
      }),
    /Choose a known person/
  );
});

test("date adapters reject overlapping outputs and incompatible fields before execution", () => {
  const model = structuredClone(fixture);
  const take = present(model.domain.actions[action]);

  Object.assign(take.inputs, {
    begin: { type: "string" },
    end: { type: "string" },
    days: { type: "integer" },
  });

  const adapter = {
    name: "utc-weekday-range/v1",
    mapping: { start: "begin", end: "end", output: "days" },
  };

  const derive = (adapters: unknown, fields: unknown = {}) =>
    deriveApplication({
      ...model,
      application: {
        ...model.application,
        actions: { [action]: { adapters, fields } },
      },
    });

  assert.throws(
    () =>
      derive([{ ...adapter, mapping: { ...adapter.mapping, start: "end" } }]),
    /must be distinct/
  );
  assert.throws(
    () =>
      derive([
        { ...adapter, mapping: { ...adapter.mapping, end: "quantity" } },
      ]),
    /adapter schema mismatch/
  );
  assert.throws(
    () =>
      derive([
        { ...adapter, mapping: { ...adapter.mapping, output: "reason" } },
      ]),
    /adapter schema mismatch/
  );
  assert.throws(() => derive([adapter, adapter]), /Conflicting adapter output/);
  assert.throws(
    () => derive([adapter], { days: { binding: { source: "clock" } } }),
    /Computed input cannot also have binding/
  );
  assert.throws(
    () => derive([adapter], { days: { default: 1 } }),
    /Hidden bound\/computed inputs cannot have client defaults/
  );
});

test("view columns and record selectors are validated against the selected resource", () => {
  const view = { kind: "list", resource: "cabinet" };

  const derive = (config: object) =>
    deriveApplication({
      ...fixture,
      application: { ...fixture.application, views: [{ ...view, ...config }] },
    });

  assert.throws(() => derive({ kind: "chart" }), /Unsupported view/);
  assert.throws(() => derive({ key: "missing" }), /Unknown view record/);
  assert.throws(() => derive({ ownerField: "missing" }), /Unknown owner field/);
  assert.throws(
    () => derive({ fields: [], columns: [] }),
    /Use fields or columns, not both/
  );
  assert.throws(
    () => derive({ columns: { field: "caption" } }),
    /Expected columns array/
  );
  assert.throws(
    () => derive({ columns: [{ field: "stock", format: "date" }] }),
    /Date column requires string schema/
  );

  const { contract } = derive({
    ownerField: "reviewer",
    columns: [{ field: "caption", format: "text" }],
  });

  assert.deepEqual(contract.views, [
    {
      kind: "list",
      resource: "cabinet",
      label: "Cabinet",
      ownerField: "reviewer",
      columns: [{ field: "caption", label: "Caption", format: "text" }],
    },
  ]);
});
