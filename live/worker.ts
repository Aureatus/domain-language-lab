import { runDerivedChecks } from "./derive.ts";

self.addEventListener("message", ({ data }) => {
  try {
    self.postMessage({ id: data.id, report: runDerivedChecks(data.workspace) });
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
