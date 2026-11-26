import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

const unitTests = globSync("**/*.test.ts", {
  exclude: [
    "**/node_modules/**",
    "**/dist/**",
    "artifacts/**",
    "adapters/effect-ui/browser.test.ts",
  ],
}).toSorted();

const result = spawnSync(
  process.execPath,
  ["--test", ...process.argv.slice(2), ...unitTests, "adapters/exact/test.ts"],
  { stdio: "inherit" }
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
