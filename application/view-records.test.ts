import assert from "node:assert/strict";
import test from "node:test";

import { viewRecords } from "./view-records.ts";

test("record views intersect literal or viewer keys with the declared owner filter", () => {
  const resource = "cabinet";
  const ownerField = "owner";

  const records = {
    maya: { values: { owner: "leo" } },
    leo: { values: { owner: "maya" } },
    tools: { values: { owner: "maya" } },
  };

  const snapshot = { state: { records: { cabinet: records } } };
  assert.deepEqual(
    viewRecords(snapshot, { resource }, "maya"),
    Object.entries(records)
  );
  assert.deepEqual(viewRecords(snapshot, { resource, key: "$actor" }, "maya"), [
    ["maya", records.maya],
  ]);
  assert.deepEqual(viewRecords(snapshot, { resource, ownerField }, "maya"), [
    ["leo", records.leo],
    ["tools", records.tools],
  ]);
  assert.deepEqual(
    viewRecords(snapshot, { resource, key: "tools", ownerField }, "maya"),
    [["tools", records.tools]]
  );
  assert.deepEqual(
    viewRecords(snapshot, { resource, key: "$actor", ownerField }, "maya"),
    []
  );
});

test("record projection rejects an incomplete snapshot rather than showing a false empty view", () => {
  assert.throws(
    () =>
      viewRecords({ state: { records: {} } }, { resource: "cabinet" }, "maya"),
    /Missing view resource: cabinet/
  );
});
