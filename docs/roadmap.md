# Research-to-prototype roadmap

The user has authorized the first example application. The initial in-memory semantic slice is in `prototype/`; the broader experiments below remain a roadmap. See `docs/status.md` and `prototype/README.md` for implemented scope.

## 1. Agree on one semantic slice

Use a resource with a grouped update, a policy that sometimes requires approval, two relationship paths to a recipient, and a workspace with two documents. Specify numbers, errors, commit/revalidation and cancellation. Keep the domain general.

Exit: independently understandable laws with useful witnesses, counterexamples and exact assumptions; a small typed IR proposal. Surface unresolved product choices rather than burying them in compiler code.

## 2. Reference execution and output prototype

Implementation of the initial slice is authorized. Build a deterministic interpreter with injectable external results and schedule, plus source-mapped traces. Derive domain/flow JSON and a canonical explanation package. Validate output references and causal order.

Exit: one trace explains a real failure, drives replay without effects and exports a truthful storyboard. Do not start with polished video before the underlying facts are reliable.

## 3. Property and bounded-model adapters

Generate histories, shrink failures, model races and retries under explicit finite bounds. Compare interpreter observations with one real Effect/Alchemy integration. Apply mutation checks to detect inadequate laws.

Exit: timeout/skip/unsupported cases cannot report success; minimized counterexamples replay; failures point to source laws and transitions.

## 4. Proof pilot and correspondence

Generate Lean definitions/obligations for a small pure or transition fragment. Prove one useful invariant with enabled-state witnesses, enumerate axioms and bind artifacts by hash. Compare Lynx and Bend 2 strategies. Add restricted correspondence work separately from model proofs.

Exit: precisely state what was proved and which translator/runtime assumptions remain. A proof of the model is not labeled end-to-end verification.

## 5. Rich renderer conformance

Specify capability profiles and shared interaction scenarios. Implement one reference renderer and a deliberately different adapter. Exercise focus, lifecycle, cancellation, streaming and native-widget boundaries.

Exit: normalized behavior matches while presentation can differ; unsupported capabilities are diagnosed; platform checks cover aspects the semantic model cannot establish.

## 6. Explanatory media

Turn validated explanation packages into interactive playback and clean video. Give agents scene/evidence contracts and an output conformance runner. Separate deterministic templates from optional editorial narration.

Exit: every scene can be traced to its model/trace/evidence, concurrent branches remain truthful, and a model change invalidates stale outputs.
