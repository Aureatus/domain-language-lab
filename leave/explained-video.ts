import { runLeaveBrowser } from "./browser-scenario.ts";

await runLeaveBrowser({
  explain: true,
  record: !process.argv.includes("--test"),
});
