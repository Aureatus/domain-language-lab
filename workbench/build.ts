import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gzipSync } from "node:zlib";

import { Runtime, policyDiff, hash } from "../prototype/engine.ts";
import { model, ticket, reviewer } from "../prototype/model.ts";
import type { Decision, Role, Priority } from "../prototype/model.ts";
import { runProperties, replayHistory } from "../prototype/property.ts";
import { permutations, explore } from "../prototype/scenarios.ts";
import type { Step } from "../prototype/scenarios.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const schedules = permutations<Step>(["approve", "edit", "execute"]);
const cases: Record<string, unknown> = {};
const policies: Record<string, unknown> = {};

for (const decision of ["approval", "allow", "deny"] satisfies Decision[]) {
  const variant = structuredClone(model);
  variant.policy.support.high = decision;
  policies[decision] = { model: variant, diff: policyDiff(model, variant) };

  for (const role of ["support", "reviewer", "viewer"] satisfies Role[]) {
    for (const priority of ["high", "normal"] satisfies Priority[]) {
      for (const [scheduleIndex, schedule] of schedules.entries()) {
        for (const mutant of [false, true]) {
          const initial = { ...ticket(), priority };
          const runtime = new Runtime(variant, initial, () => 1000);
          const frames: unknown[] = [];

          const capture = (action: string, result: unknown = null) =>
            frames.push({
              action,
              result,
              ticket: structuredClone(runtime.ticket),
              invocation: structuredClone(runtime.invocation ?? null),
              events: structuredClone(runtime.events),
              deliveries: structuredClone(runtime.deliveries),
            });

          capture("initial");
          capture(
            "request",
            runtime.request(
              { id: role === "support" ? "support-1" : `${role}-1`, role },
              "Original resolution"
            )
          );

          for (const step of schedule) {
            const result =
              step === "approve"
                ? runtime.approve(reviewer)
                : step === "edit"
                  ? runtime.editSummary("Changed resolution")
                  : runtime.execute({ staleApprovalMutant: mutant });

            capture(step, result);
          }

          let subject: unknown;

          const violations = runtime.events.flatMap((event) => {
            if (event.kind === "approved") {
              ({ subject } = event.details);
            }

            return event.kind === "committed" &&
              event.details["decision"] === "approval" &&
              !isDeepStrictEqual(subject, event.details["subject"])
              ? [event.id]
              : [];
          });

          cases[[decision, role, priority, scheduleIndex, mutant].join("|")] = {
            inputs: { decision, role, priority, schedule, mutant, clock: 1000 },
            initial,
            frames,
            violations,
            trace: runtime.export(),
          };
        }
      }
    }
  }
}

async function report(name: string) {
  try {
    const raw = await readFile(resolve(root, "artifacts", name), "utf-8");
    const data = JSON.parse(raw);

    const sources =
      name === "lean-report.json"
        ? [["proof/Approval.lean", data.source_sha256]]
        : [
            ["prototype/engine.ts", data.engine?.sha256],
            ["prototype/model.ts", data.engine?.modelSha256],
            ["prototype/property.ts", data.engine?.adapterSha256],
          ];

    for (const [path, expected] of sources) {
      const actual = createHash("sha256")
        .update(await readFile(resolve(root, path)))
        .digest("hex");

      if (actual !== expected) {
        return {
          availability: "unavailable",
          path: `artifacts/${name}`,
          reason: `Stale or unbound evidence for ${path}. Regenerate the report.`,
        };
      }
    }

    return {
      availability: "available",
      path: `artifacts/${name}`,
      sha256: hash(data),
      data,
    };
  } catch (error) {
    return {
      availability: "unavailable",
      path: `artifacts/${name}`,
      reason:
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "Not present at build time. Rebuild after generating this report."
          : "Could not read valid JSON. No evidence inferred.",
    };
  }
}

// A separate, explicitly fault-injected run; never overwrite the normal property report.
const mutantReport = runProperties({
  seed: 0x5e_ed,
  samples: 12,
  maxSteps: 16,
  shrinkBudget: 2000,
  staleApprovalMutant: true,
});

if (!mutantReport.failures.length) {
  throw new Error(
    "Expected the generated mutant demonstration to expose a failure"
  );
}

const propertyExamples = mutantReport.failures.map((failure) => ({
  sample: failure.sample,
  sampleSeed: failure.sampleSeed,
  originalHistory: failure.originalHistory,
  minimalHistory: failure.minimalHistory,
  attempts: failure.attempts,
  budgetExhausted: failure.budgetExhausted,
  minimality: failure.minimality,
  replay: failure.replay,
  recordings: Object.fromEntries(
    Object.entries({
      original: failure.originalHistory,
      shrunk: failure.minimalHistory,
    }).map(([name, history]) => [
      name,
      Object.fromEntries(
        [false, true].map((staleApprovalMutant) => [
          String(staleApprovalMutant),
          Array.from({ length: history.length + 1 }, (_, length) =>
            replayHistory({
              ...failure.replay,
              staleApprovalMutant,
              history: history.slice(0, length),
            })
          ),
        ])
      ),
    ])
  ),
}));

const data = {
  format: "semantic-workbench/1",
  modelHash: hash(model),
  schedules,
  policies,
  cases,
  generated: { report: mutantReport, examples: propertyExamples },
  exploration: { safe: explore(false), mutant: explore(true) },
  reports: {
    property: await report("property-report.json"),
    lean: await report("lean-report.json"),
  },
  scope:
    "216 precomputed executions: 3 support/high policy choices × 3 actor roles × 2 ticket priorities × 6 schedules × 2 interpreters. One request, then exactly one approve/edit/execute; fixed clock 1000. No arbitrary histories, persistence, authentication or external delivery.",
};

const template = (
  await readFile(resolve(root, "workbench/template.html"), "utf-8")
).replace(
  /<style>[\s\S]*?<\/style>/u,
  `<style>${await readFile(
    resolve(root, "workbench/workspace.css"),
    "utf-8"
  )}</style>`
);

const html = template.replace(
  "/*__WORKBENCH_DATA__*/",
  JSON.stringify(data).replaceAll("<", "\\u003c")
);

await mkdir(resolve(root, "artifacts"), { recursive: true });

await writeFile(resolve(root, "artifacts/workbench.html"), html);

// All data and controls are retained. Native gzip decoding is local, with no fetch or libraries.
let inline = template
  .replace(/<header class="topbar">[\s\S]*?<\/header>/u, "")
  .replace(/<footer class="footer">[\s\S]*?<\/footer>/u, "")
  .replace(
    "/*__WORKBENCH_DATA__*/",
    gzipSync(JSON.stringify(data)).toString("base64")
  )
  .replace("'use strict';", "'use strict';\n(async()=>{try{")
  .replace(
    "const DATA=JSON.parse(document.getElementById('workbench-data').textContent);",
    "const packed=Uint8Array.from(atob(document.getElementById('workbench-data').textContent),c=>c.charCodeAt(0));\nconst DATA=JSON.parse(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).text());"
  )
  .replace(
    "renderReports();render();",
    "renderReports();render();\n}catch(error){document.body.textContent='Workbench could not load: '+error.message;throw error}})();"
  );

const inlineCSS = await readFile(
  resolve(root, "workbench/inline.css"),
  "utf-8"
);

// Replace fixed colors throughout the shared structural CSS with host theme tokens.
inline = inline.replace(/<style>([\s\S]*?)<\/style>/u, (_, source) => {
  let css = source
    .replace(/:root\{[^}]*\}/u, "")
    .replaceAll("min-height:calc(100vh - 90px)", "min-height:0");

  css = css.replaceAll(/#[a-fA-F0-9]{3,8}\b|\bwhite(?=[;}])/gu, "var(--card)");

  return `<style>${css}\n${inlineCSS}</style>`;
});

if (inline.length >= 512_000 || Buffer.byteLength(inline) >= 512_000) {
  throw new Error(
    `Inline artifact exceeds render limit: ${inline.length} characters / ${Buffer.byteLength(inline)} bytes`
  );
}

await writeFile(resolve(root, "artifacts/workbench-inline.html"), inline);

console.log(
  `Built artifacts/workbench-inline.html (${inline.length} characters; ${Buffer.byteLength(inline)} bytes; all 216 cases retained).`
);

console.log(
  `Built artifacts/workbench.html (${Object.keys(cases).length} genuine runtime executions; ${Math.round(Buffer.byteLength(html) / 1024)} KiB).`
);
