import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { errorMessage } from "../../errors.ts";
import { decodeJsonObject, encodeJsonPretty } from "../effect/json.ts";
import { model, obligation } from "./fixture.ts";
import { generate, hash, Unsupported } from "./generate.ts";

export const PINNED_LEAN =
  "/tmp/opencode/elan/toolchains/leanprover--lean4---v4.19.0/bin/lean";

interface Report {
  format: string;
  status: "tool_error" | "not_checked" | "proof_checked" | "unsupported";
  theorem_axioms: Record<string, string[]>;
  tool: { executable: string; version: string | null };
  scope: string;
  metadata?: ReturnType<typeof generate>["metadata"];
  generator_sha256?: string;
  template_sha256?: string;
  runner_sha256?: string;
  semantic_core_sha256?: string;
  semantic_primitives_sha256?: string;
  detail?: string;
}

export function writeReport<T extends object>(directory: string, report: T) {
  writeFileSync(
    resolve(directory, "report.json"),
    `${encodeJsonPretty(report)}\n`
  );
}

export function check(
  source: unknown,
  law: unknown,
  directory: string,
  lean = process.env["LEAN"] || PINNED_LEAN
) {
  mkdirSync(directory, { recursive: true });

  const report: Report = {
    format: "generated-lean-evidence/1",
    status: "tool_error",
    theorem_axioms: {},
    tool: { executable: lean, version: null },
    scope:
      "Generated numeric kernel only; no runtime correspondence or full-action theorem.",
  };

  let log = "";

  try {
    const { code, metadata } = generate(source, law);
    report.metadata = metadata;
    report.generator_sha256 = hash(
      readFileSync(new URL("generate.ts", import.meta.url), "utf-8")
    );
    report.template_sha256 = hash(
      readFileSync(new URL("template.ts", import.meta.url), "utf-8")
    );
    report.runner_sha256 = hash(
      readFileSync(new URL("check.ts", import.meta.url), "utf-8")
    );
    report.semantic_core_sha256 = hash(
      readFileSync(new URL("../../semantic/core.ts", import.meta.url), "utf-8")
    );
    report.semantic_primitives_sha256 = hash(
      readFileSync(
        new URL("../../semantic/primitives.ts", import.meta.url),
        "utf-8"
      )
    );
    writeFileSync(resolve(directory, "Generated.lean"), code);
    writeFileSync(
      resolve(directory, "metadata.json"),
      `${encodeJsonPretty(metadata)}\n`
    );

    const version = spawnSync(lean, ["--version"], {
      encoding: "utf-8",
      timeout: 30_000,
    });

    report.tool.version = version.stdout?.trim() ?? null;

    if (
      version.error ||
      version.status !== 0 ||
      !report.tool.version ||
      !/^Lean \(version 4\.19\.0(?:,|\))/u.test(report.tool.version)
    ) {
      throw new Error("Pinned Lean 4.19.0 unavailable or mismatched");
    }

    const run = spawnSync(lean, ["Generated.lean"], {
      cwd: directory,
      encoding: "utf-8",
      timeout: 120_000,
    });

    log = (run.stdout || "") + (run.stderr || "");

    if (run.error) {
      throw run.error;
    }

    if (run.status !== 0) {
      report.status = "not_checked";
      throw new Error(
        "Lean rejected generated declarations/obligations; see check.log"
      );
    }

    if (/\bsorry\b|\baxiom\s/u.test(code)) {
      throw new Error("Forbidden proof escape");
    }

    for (const name of ["preserves", "positive_witness"]) {
      const lines = log
        .split("\n")
        .filter((l) => l.startsWith(`'Generated.${name}' `));

      const [line] = lines;

      if (!line || lines.length !== 1) {
        throw new Error(`Missing/duplicate theorem axiom report: ${name}`);
      }

      const reported = line.match(/depends on axioms: \[([^\]]*)\]$/u)?.[1];

      const axioms =
        reported === undefined
          ? line.endsWith("does not depend on any axioms")
            ? []
            : null
          : reported
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);

      if (!axioms || axioms.some((a) => a !== "propext")) {
        throw new Error("Unrecognized/non-allowlisted theorem axioms");
      }

      report.theorem_axioms[name] = axioms;
    }

    report.status = "proof_checked";
    report.detail =
      "Pinned Lean checked generated invariant and concrete successful witness.";
  } catch (error) {
    if (error instanceof Unsupported) {
      report.status = "unsupported";
    }

    report.detail = errorMessage(error);
  }

  writeFileSync(resolve(directory, "check.log"), log || `${report.detail}\n`);
  writeReport(directory, report);

  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  // JSON declarations can be exported by any domain, including a later inventory fragment.
  const source = process.argv[2]
    ? decodeJsonObject(readFileSync(process.argv[2], "utf-8"))
    : model;

  const law = process.argv[3]
    ? decodeJsonObject(readFileSync(process.argv[3], "utf-8"))
    : obligation;

  const out = resolve(
    process.argv[4] || fileURLToPath(new URL("generated", import.meta.url))
  );

  const report = check(source, law, out);
  console.log(encodeJsonPretty(report));
  process.exitCode = report.status === "proof_checked" ? 0 : 1;
}
