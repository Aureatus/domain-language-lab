import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Identity of the checker + projection code used for recorded-failure replay.
export async function checkerBuild() {
  const hash = createHash("sha256");

  for (const file of [
    "interaction-check",
    "action-review",
    "submission",
    "loading",
    "view-records",
    "client",
    "snapshot",
  ]) {
    hash
      .update(file)
      .update("\0")
      .update(await readFile(new URL(`${file}.ts`, import.meta.url)))
      .update("\0");
  }

  return hash.digest("hex");
}
