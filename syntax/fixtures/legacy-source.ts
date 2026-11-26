// Legacy single-file frontend coverage. The independent prior-leave.ts fixture
// remains the semantic equality oracle; this text projection is not that oracle.
import { readFileSync } from "node:fs";

const read = (name: string) =>
  readFileSync(new URL(`../../leave/${name}.domain`, import.meta.url), "utf-8")
    .split("\n")
    .filter((line) => !/^(module|import|use)\b/u.test(line))
    .join("\n");

export default [
  read("time-away")
    .replace(
      'resource settings singleton key "leave-rule"',
      "resource settings"
    )
    .replace(
      'action "leave.request" identity request',
      'action "leave.request"'
    )
    .replace(
      'action "settings.change" identity edit',
      'action "settings.change"'
    )
    .replace("employeeId reference employee as employee", "employeeId string")
    .replace(
      "  preconditions",
      '  bindings\n    employee from employee key employeeId id "request.employee"\n    settings from settings key "leave-rule" id "request.settings"\n  end\n\n  preconditions'
    )
    .replace(
      "    threshold like settings.threshold\n  end",
      '    threshold like settings.threshold\n  end\n  bindings\n    settings from settings key "leave-rule" id "edit.settings"\n  end'
    ),
  read("demo"),
  read("browser"),
].join("\n");
