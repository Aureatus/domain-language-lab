import { mkdir, writeFile } from "node:fs/promises";

import { policyDiff } from "./engine.ts";
import { model } from "./model.ts";
import { explore, replay, storyboard } from "./scenarios.ts";

const next = structuredClone(model);

next.revision += 1;

next.policy.support.high = "allow";

const artifacts = {
  "policy-diff": policyDiff(model, next),
  "correct-exploration": explore(),
  "mutant-exploration": explore(true),
  "safe-replay": storyboard(replay(["approve", "edit", "execute"])),
  "counterexample-replay": storyboard(
    replay(["approve", "edit", "execute"], true)
  ),
};

await mkdir("artifacts", { recursive: true });

for (const [name, artifact] of Object.entries(artifacts)) {
  await writeFile(
    `artifacts/${name}.json`,
    `${JSON.stringify(artifact, null, 2)}\n`
  );
}

console.log(
  `Policy diff: ${artifacts["policy-diff"].changes.length} changed decision in 6 contexts.`
);

console.log(
  `Correct interpreter: ${artifacts["correct-exploration"].result} across 6 schedules.`
);

console.log(
  `Deliberately broken interpreter: ${artifacts["mutant-exploration"].failures.length} counterexample(s).`
);

console.log(
  "Wrote 5 simulated analysis/replay artifacts to artifacts/. No external effects or formal proofs."
);
