import assert from "node:assert/strict";
import test from "node:test";

import { loadingPlan, loadingPresentation } from "./loading.ts";

test("ownership and lifecycle dominate placeholder preferences for every observation", () => {
  for (const strategy of ["text", "icon", "skeleton", "wait"]) {
    for (const owned of [false, true]) {
      for (const failed of [false, true]) {
        for (const pending of [false, true]) {
          const ui = loadingPresentation(strategy, { owned, failed, pending });
          assert.equal(ui.showContent, owned);
          assert.equal(ui.error, failed && !pending);
          assert.equal(
            ui.placeholder,
            !owned && pending && strategy !== "wait" ? strategy : null
          );
        }
      }
    }
  }
});

test("resolution preserves the declaration and labels its regions", () => {
  const views = [{ label: "Balance", loading: "wait" }, { label: "Calendar" }];
  assert.deepEqual(loadingPlan({ loading: "skeleton", views }), [
    { index: 0, label: "Balance", strategy: "wait" },
    { index: 1, label: "Calendar", strategy: "skeleton" },
  ]);
  assert.equal(loadingPlan({ views })[1]?.strategy, "text");
  assert.throws(() => loadingPlan({ views: [], loading: "unknown" }));
});
