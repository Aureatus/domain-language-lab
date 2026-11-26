import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("inventory browser build fingerprints the shared interpreter and declaration helpers", () => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL("build.ts", import.meta.url)),
  ]);
  const root = new URL("../", import.meta.url);

  const { sources } = JSON.parse(
    readFileSync(new URL("artifacts/inventory-build.json", root), "utf-8")
  );

  for (const path of ["semantic/primitives.ts", "inventory/declarations.ts"]) {
    const digest = createHash("sha256")
      .update(readFileSync(new URL(path, root)))
      .digest("hex");

    assert.equal(sources[path], digest, path);
  }
});
