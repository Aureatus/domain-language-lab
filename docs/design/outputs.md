# Derived explanations and outputs

Status: design contract, not implemented.

## Output families

1. **Domain atlas:** resources, relationships, actions, types, queries and policies; source links and impact navigation.
2. **Mapping atlas:** source declaration → typed model → generated/runtime operation → service requirement → deployment resource → interface affordance. Each edge has a meaning and provenance, not merely a line.
3. **Possible-flow model:** branching, synchronization, policy outcomes, cancellation, retries, deadlines and unknown foreign regions.
4. **Concurrency analysis:** which transitions can be simultaneously enabled, which conflict, which commute under stated assumptions, and which require ordering.
5. **Execution/counterexample trace:** a particular set of events and causal dependencies, with state deltas and evidence.
6. **Verification report:** law, exact checked artifact, assumptions, coverage/bounds, result class and source-mapped diagnostics.
7. **Explanation package:** structured claims and scenes usable by an agent or deterministic document/animation renderer.

Human-readable formats can include Markdown, navigable diagrams, SVG/PDF, interactive replay and video. Machine-facing JSON is a primary output, not scraped from those renderings. A video backend could target a scene renderer such as Remotion or another timeline system; no backend is selected or implemented.

## All possible flows

Do not enumerate arbitrary permutations of unrelated events. Independent events may have many serial schedules with the same relevant observations. Represent causal partial orders and explore representative interleavings using an independence relation justified for the properties being checked. Read/write sets alone may miss external effects and synchronization.

Three claims must stay separate:

- Conservative static possibility: an edge may occur; guards or foreign behavior may make it infeasible.
- Feasible bounded behavior: reachable under explicit input, population, queue, retry, depth and time bounds.
- General property: proved under an explicit model and its assumptions.

Unbounded loops, growing resources and arbitrary foreign computation prevent a general finite enumeration. Use symbolic constraints, bounded exploration, symmetry/partial-order reductions where justified, and explicit unknown regions. Record whether a reduction preserves safety, liveness or only selected observations. Liveness needs fairness and environment assumptions. Physical time requires clock/delay semantics; logical order alone cannot prove a deadline.

Queries the design should support:

- Can these actions overlap for the same resource? For different resources?
- Can cancellation race with commit? What are the permitted outcomes?
- Can two relationship routes deliver the same logical message twice?
- Can this state be reached without an approval under this policy?
- Which retry schedules are observationally equivalent?
- What changed in possible behavior between these two versions?

## Trace contract

Every trace declares its kind: observed, simulated, model-checker witness, illustrative. Include model/build identity, source references, inputs, transition instances, actor/resource versions, policy/rule identities, causal parents, relevant read/write observations, effects, state changes, clocks and assumptions.

Unknown ordering is not evidence of independence. An observed timestamp order is not automatically causation. Use explicit edge kinds: happens-before, data-dependency, synchronization, conflict, alternative and explanatory-reference.

Do not infer that the domain ran successfully because a delivery intent exists. Model commit, dispatch, attempt, acknowledgment and externally uncertain outcome separately.

## Storyboard contract

Scenes reference trace events and semantic IDs. Each factual claim points to source/model/trace/evidence. Editorial choices include focus, camera, layout, durations, captions and narration. A simultaneous scene may show concurrent branches; serial exposition must label them concurrent if no causal dependency exists.

Caption text can be generated deterministically from templates. An LLM may produce optional narration, but preserve its content as a versioned artifact with claim references; do not call that generation deterministic. Validate supported references mechanically and review semantic faithfulness separately. Reference validation alone cannot prove natural-language entailment.

The illustrative [example package](../../examples/explanation-package.json) shows two post-commit branches. It is hand-authored and has no proof or runtime evidence. It demonstrates export shape only.

## Reproducibility and provenance

Pin model, source, adapters, dependencies, scenario inputs and random seed. For byte-identical media also pin renderer, layout algorithm, fonts, assets, locale, encoder and relevant environment. Reproducible semantic scene order is a weaker and often more useful guarantee than identical encoded video bytes.

Generated views are read-only with respect to application effects. Replay runs through a simulation interpreter; never resubmit real commands just to animate them. Project visibility/redaction policy applies to graph labels, state deltas, captions, narration and source excerpts alike.

Keep evidence attached through transformations. A bounded checker result remains bounded in the final video. An abstract counterexample is labeled abstract until replay/concretization validates it. A hypothetical narrative stays hypothetical.

## Output conformance scenarios

- Every scene event ID resolves; every causal edge references existing events; cycles in a claimed happens-before DAG are rejected.
- Scene order respects causal edges. Same-scene grouping is permitted only where presentation preserves any internal ordering.
- Dropping an event cannot silently remove a required causal explanation; collapsed groups retain references to the hidden steps.
- No output adapter calls production mutation capabilities.
- The same model change invalidates affected docs, proofs and storyboards using their declared dependency hashes.
- Unsupported regions, assumptions and analysis bounds survive export into all evidence-bearing formats.
