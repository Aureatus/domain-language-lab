# Verification as a language feature

Research memo · 2026-11-11 · design proposal, no implementation or tool execution claims.

## Recommendation

Give the unnamed Ash-like language one typed, versioned semantic core and several verification adapters. Make laws first-class declarations associated with resources, actions, policies, relationships, event transitions, and semantic UI interactions. Start with executable properties and replayable state-machine tests; add bounded model checking for workflows and Lean proofs for a deliberately small pure fragment. Treat compilation correctness as a separate obligation. Effect and Alchemy integrations are execution boundaries, not automatically verified semantics.

**Current Bend 2 is directly relevant:** it has laws, proof definitions, and a Lean-formalized kernel path. It is not the old Bend/HVM project. Its own documentation explicitly limits the guarantee to modeled semantics and identifies translation/backend gaps. Borrow its law ergonomics and visible obligations, not a blanket “bug-free application” claim.

## Sources and actual read depth

All sources accessed on the date above. “Read” below means the listed sections, not an entire repository or paper. No prover was installed or executed; no theorem was independently rebuilt. Moving-branch URLs are discovery references rather than reproducibility pins.

| Source | Material actually inspected | Provenance and limit |
| --- | --- | --- |
| [Bend README](https://github.com/bendlang/bend/blob/d18110b6d6e9a70bb8814b2a8d8db092e301e540/README.md) | Law/proof examples, `--verdict`, all limitations | Primary maintainer description; performance charts and marketing claims not independently validated. Commit `d18110b6d6e9a70bb8814b2a8d8db092e301e540`, dated 2026-11-10. |
| [Bend safe.ts](https://github.com/bendlang/bend/blob/d18110b6d6e9a70bb8814b2a8d8db092e301e540/bend2/safe.ts) | Translation header; unsafe rejection; `def_emit`, model fallback; kernel build, `kernel_check`, `safe_check` | Selected implementation sections. Initial guessed `verdict.ts` URL was absent; repository discovery located `safe.ts`. |
| [BendTT Lean source](https://github.com/bendlang/bend/blob/d18110b6d6e9a70bb8814b2a8d8db092e301e540/bend2/bendtt.lean) | `Typed`, `Claim.sound`, proof-section map, `conv_sound`, `chk`, `book_check`, final `reach` and `consistent` assembly | Selected definitions, theorem statements and proof bodies in a 3,862-line file; not an independent soundness audit. BendTT/BendRT papers were discovered through README but not read. |
| [Bend WONTFIX](https://github.com/bendlang/bend/blob/d18110b6d6e9a70bb8814b2a8d8db092e301e540/WONTFIX.txt) | Numeric/runtime limits, dead-code behavior, effects cancellation, F32 lane differences | Primary limitation inventory, read in full. |
| [Lean: Axioms and Computation](https://lean-lang.org/theorem_proving_in_lean4/axioms_and_computation.html) | Chapter introduction; propositional/function extensionality, quotients, `#print axioms`, kernel reduction versus compiled evaluation | Official textbook sections, not the whole textbook. |
| [Lean declaration.cpp](https://github.com/leanprover/lean4/blob/master/src/kernel/declaration.cpp) | Declaration safety tagging, `use_unsafe`, `mk_definition_inferring_unsafe` | Primary implementation; this file alone does not establish all kernel admission rules. |
| [fast-check RunDetails.ts](https://github.com/dubzzz/fast-check/blob/main/packages/fast-check/src/check/runner/reporter/RunDetails.ts) | Entire result type: property failure, excessive skips, setup failure, interrupted success, seed/path, execution tree | Primary API implementation; selected integration surface, not a runner audit or full QuickCheck paper reading. |
| [Apalache README](https://github.com/apalache-mc/apalache/blob/a2910d423e031be9dc077b2d9cfcbd5dd42996e8/README.md) and [SeqModelChecker.scala](https://github.com/apalache-mc/apalache/blob/a2910d423e031be9dc077b2d9cfcbd5dd42996e8/tla-bmcmt/src/main/scala/at/forsyte/apalache/tla/bmcmt/SeqModelChecker.scala) | README capability summary; example traces, deadlock and timeout branches, enabled transitions and too-short executions | Primary summary and selected implementation. Distinguishes bounded executions from inductive invariants over fixed/bounded parameters. A guessed principles documentation URL returned 404 and was not evidence. |
| [Alive2 README](https://github.com/AliveToolkit/alive2) and [solver.h](https://github.com/AliveToolkit/alive2/blob/master/smt/solver.h) | Architecture, refinement examples, interprocedural limitation; result predicates for SAT/UNSAT/invalid/skip/timeout/error | Primary project description and selected result API. Linked PLDI 2021 paper discovered, not read. |
| [Lynx README](https://github.com/josevalim/lynx/blob/683d96fc54fa10d4a45f31bde83e4a4c95e63f1a/README.md) and [laws.ex](https://github.com/josevalim/lynx/blob/683d96fc54fa10d4a45f31bde83e4a4c95e63f1a/lib/lynx/laws.ex) | README including examples and limitations; `verify/2`, law options and requires/expects construction | Primary project in José Valim's account; selected implementation sections, not translator audit. |

## Findings

### Lean and the Elixir anecdote

There is now stronger, attributable evidence than an anecdote: **José Valim's [Lynx](https://github.com/josevalim/lynx) explicitly translates Erlang/Elixir programs and laws to Lean and combines them with Lean proofs.** Its README shows an Elixir `sum` function, a law for concatenated lists, and a Lean induction proof. `laws.ex` builds translations, assembles modules, and calls the Lean verification command. Valim-authored Lean issues [#15749](https://github.com/leanprover/lean4/issues/15749) and [#16313](https://github.com/leanprover/lean4/issues/16313) also contain concrete Lean reproductions; GitHub search located these and Lynx.

This verifies the substance “Elixir's creator is working on Lean proofs about Elixir functions.” The exact recollection that he **manually writes parallel Lean versions of functions as a routine practice** remains unverified. Lynx describes automatic shallow embedding, a materially different workflow. Do not attribute that stronger personal claim without the original talk/post.

Lynx is especially instructive for this language: author properties beside normal code, preserve callable laws for tests, and expose proof blocks separately. Its README correctly notes that roundtrip alone does not establish standards compliance and that the same sum algebraic law also fits `length`. A proof of an inadequate property is still inadequate product evidence. Its stated support for modeled concurrent runtime features is not a proof about external sockets or ports.

Lean offers a useful trust architecture: proofs are terms checked against propositions, while tactics can be replaceable producers. Record all theorem axioms, including transitive dependencies; reject `sorryAx` and unapproved axioms for the strongest evidence tier. Distinguish admitted assumptions, classical axioms accepted by project policy, and unsafe computational dependencies. `#eval` producing a value is not a theorem. A handwritten Lean counterpart proves the counterpart until a correspondence obligation connects it to executable code.

### Current Bend 2

`law add_zero` declares a universally quantified equality; `def add_zero` supplies its proof. The project recommends `LAWS.bend` and `PROOF.bend`. This is a strong interaction pattern for agents: stable requirements, explicit proof obligations, and evidence attached to edits.

The implementation matters more than the headline:

- `safe.ts` elaborates checked Bend terms into BendTT. Its header says the kernel trusts no elaboration: it checks the emitted terms. **That is not proof that elaboration preserved the original source meaning.** The README explicitly acknowledges the parser/translation gap.
- `safe_check` only invokes the kernel when the out-of-scope list is empty. Unsupported definitions must not silently disappear from a successful report. `kernel_check` requires both successful exit and the exact success response; abnormal termination is infrastructure failure.
- Unsafe definitions are rejected from this path. Bodyless laws/native/foreign definitions are represented through opaque checked models. A model inhabiting a signature does not establish that a foreign runtime implementation obeys it; report this boundary explicitly.
- `Claim.sound` states successful book checking implies `Book.WellTyped` and `Book.Live`; the final consistency assembly uses termination, progress, and preservation to exclude a checked definition of empty type. These are meaningful formalization artifacts, not independent evidence that every compiler target preserves them.
- F32 operations are presently axiomatic; NaN payload behavior differs on JS. Mathematical Nat is unbounded in the theory but runtime Nat beyond `2^48-1` fail-stops. Unbalanced array trees can type-check yet trap. The ordinary checker is described as unproven; the compiler as not fully audited.

Decision: maintain a Bend 2 research adapter candidate and borrow the syntax concept. Prefer Lean as the initial general proof backend rather than making the whole application depend on Bend's present runtime and numeric subset.

### Property testing, model checking, translation validation

**Property testing:** fast-check fits a TypeScript/Effect host. Generate typed values and command sequences, shrink both input data and event schedules, replay with seed/path plus dependency versions. Test policy decisions, stale approvals, relationship attach/detach, retries and duplicate events. Source inspection shows `failed: false` can coexist with `interrupted: true`; excessive skips and setup failures are separate from a falsified property. Never reduce this result to one green Boolean.

**Model checking:** use an explicit transition model for approvals, revocation, relationship propagation, retries, and concurrent edits. Apalache supports bounded execution checking and inductive invariant checks with fixed/bounded parameters. State actor/resource/queue domains, depth, fairness, delivery and failure assumptions. Its source explicitly handles SMT timeouts and too-short executions; simulation can ignore a timed-out transition, so simulation success cannot be promoted to exhaustive checking. Safety (“no unauthorized execution”) and liveness (“a valid request eventually completes”) require different obligations and liveness needs environment/fairness assumptions.

**Translation validation:** validate a particular lowering's source/target relation, rather than assuming all compiler transformations are correct. Alive2 demonstrates refinement checking, not just equality: removing LLVM `nsw` can be valid while adding it can introduce undefined behavior. Alive2 is an LLVM tool, **not an off-the-shelf validator for TypeScript/Effect**. Our analogous validator needs semantics for the actual restricted IR and emitted code. Unsupported instructions, timeout, or skipped checks remain explicit. Differential tests of an IR interpreter against generated code are useful initial evidence, but are not formal translation validation.

## Proposed verification adapter contract

This is a data contract proposal, not API implementation.

### Request

- **Identity:** obligation ID, source spans, law hash, semantic-IR hash/version, executable build hash, dependencies, adapter/tool/solver/kernel versions and options.
- **Claim:** quantified variables, precondition, postcondition or temporal property, initial states, transition relation, frame conditions, and observation/refinement relation. Link both the specification and the implementation being checked.
- **Scope:** covered actions, policy branches, event routes, UI interactions, compilation passes, and excluded constructs with reasons. Explicitly name whether the claim concerns source IR, a mathematical model, generated output, or deployed behavior.
- **Semantics profile:** numeric representation; error/defect/cancellation behavior; ordering; transaction isolation; retries/delivery; clock/randomness; identity and relationship snapshot rules; foreign-function contracts.
- **Assumptions and trusted base:** named axioms and their origin, external-service assumptions, abstract models, translator correctness status, checker/kernel identity, solver trust or certificate checker, runtime/compiler/FFI dependencies. A certificate-checked proof and a trusted-SMT answer are distinct evidence classes.
- **Budget:** cases, seeds, shrink budget, actor/data bounds, transition depth, time/memory/fuel, and desired evidence class. Insufficient budget cannot relax the requested property silently.

### Response

Return a tagged result, never `verified: boolean`:

| Result | Meaning |
| --- | --- |
| `proof_checked` | Certificate/term checked for the exact claim under the enumerated assumptions. Include checker and theorem/axiom manifest; say which semantic layer was proved. |
| `solver_validated` | Solver-established obligation for the encoded scope; no independent proof certificate checked. Include solver trust and translation assumptions. |
| `bounded_pass` | Exhaustive within explicit finite domains/depth, no counterexample found. No unbounded implication. |
| `sampled_pass` | Completed specified generated cases/schedules. Include coverage, skips and replay configuration. |
| `counterexample` | Concrete failing witness or model-level counterexample, with replay status. Abstract/spurious candidates are labeled until concretized. |
| `unknown` | Timeout, interruption, exhausted proof search, unresolved obligation, excessive skips, unsupported semantics, or incomplete exploration. Preserve reason. |
| `tool_error` | Tool crash, malformed output, unavailable executable, setup/translation failure. No property conclusion. |

Include raw artifact hashes, coverage/exclusions, elapsed resources, dependency graph, and source-mapped trace. A failed proof attempt does not refute the theorem. A passed model check does not prove implementation correspondence. Changing a law, semantics profile, assumption, or referenced code invalidates cached evidence.

### Numeric semantics: settle before proofs

Use distinct types for mathematical integers/naturals, checked fixed-width integers, modular bitvectors, scaled decimal money, and floating point. Specify overflow, division/remainder (especially negative operands and zero), shifts, rounding, conversions and serialization. JavaScript `number` does not exactly represent every integer beyond `2^53-1`; use a chosen exact runtime representation or explicit bounds, not an implicit Lean `Int` translation. Big integers still have resource limits. Money needs a currency/scale and rounding policy; rational arithmetic is not automatically equivalent to decimal rounding.

Floating-point laws require a precise format and NaN/infinity/signed-zero policy; ordinary real-number algebra is unsound as a blanket replacement. Cross-target equality may require observational rather than bitwise equality, but must be declared. Bend's Nat/F32 gaps make this a concrete requirement, not theoretical housekeeping. Model resource exhaustion separately from functional value correctness; totality in a mathematical semantics does not promise completion on a finite machine.

### No vacuous proofs

1. Require satisfiable preconditions/initial states with witnesses for important input classes; check existential reachability of the action and approval branches being claimed safe.
2. Report discarded generated inputs, empty domains, unreachable transitions and missing coverage. “No execution” is not acceptable evidence of a useful workflow.
3. Separate an invariant to prove from environment assumptions. Never assume the target invariant or a disguised equivalent to discharge itself.
4. Pair negative safety laws with positive capability laws: some permitted request can execute; a denied request cannot; revocation invalidates the relevant pending authorization.
5. Keep requirements independently reviewable. An agent modifying implementation and weakening its law together must produce an explicit semantic law diff; the old proof cannot be reused.
6. Use deliberate mutants and independent examples to evaluate whether laws distinguish wrong implementations. These improve specification adequacy; they do not prove consistency or completeness of every assumption set.

## Domain obligations and explainable output

- **Policy-derived approvals:** prove that execution uses a valid authorization for the same actor, action, resource version, arguments and relevant policy version/snapshot. Model races between approval, edits, revocation and execution; choose and document the transaction/revalidation point. A UI approval click is not the authorization invariant.
- **Relationship-driven events:** distinguish graph reachability from delivery semantics. Include cycles, detach/reattach, duplicates, replay, deduplication lifetime, and transaction commit/rollback. Avoid an “exactly once” claim unless the side-effect boundary supports it; specify idempotent observable outcomes instead where appropriate.
- **Renderer-independent UI:** verify semantic interactions over a view/action state machine. Example: a disabled action cannot dispatch a privileged command, and stale responses cannot overwrite newer state. Renderer conformance, focus/accessibility behavior, layout and pixels need their own tests; semantic proof is not visual proof.
- **Effect/Alchemy boundary:** model effect descriptions and failure/cancellation outcomes explicitly; bind adapters to actual environment contracts. Infrastructure desired-state invariants do not establish provider behavior, convergence or availability without additional assumptions and observations.

One normalized trace should feed diagnostics, interactive replay and video storyboards: transition ID, source span, actor/resource/version, relationship edge, policy facts and rule IDs, pre/post-state delta, effects, causal parents, schedule/time assumptions, and evidence references. Redact secrets while preserving stable event IDs. Separate recorded execution, generated counterexample and illustrative scenario labels. A storyboard may summarize a validated trace, but generated narration and animation are explanatory artifacts, never proof evidence. Link each scene to the exact trace steps it represents and avoid inventing omitted causal steps.

## Roadmap and exit criteria

1. **Semantics and evidence design:** specify a small total pure core, typed errors, numeric profile, action transition system and result taxonomy. Publish an assumption manifest and several independently reviewed useful/non-vacuous laws.
2. **Executable properties and traces:** fast-check adapter, model-based action sequences, shrinking and deterministic replay through the actual Effect integration. Exit when known policy/event mutants produce minimal reproducible traces and setup/skip/interruption cannot appear as a pass.
3. **Bounded workflow models:** Apalache adapter for a small approval/relationship example. Exercise revocation races, duplicate delivery and cycles. Exit with visible bounds, replayable concrete witnesses, and explicit unknown/error cases.
4. **Lean pure-core pilot:** generate definitions and obligations from the same semantic IR; retain source mapping and inspect theorem axioms. Prove a useful policy or transition invariant, plus initial-state satisfiability and enabled-action witnesses. Evaluate Lynx's embedding workflow and Bend's laws/verdict ergonomics as comparators.
5. **Correspondence and compilation:** initially differential-test interpreter/generated-code behavior; then implement certificate-producing or independently checked translation validation for a restricted lowering. State uncovered runtime/FFI assumptions. Do not announce end-to-end proof while this bridge remains trusted.
6. **Evidence-linked experiences:** semantic UI conformance suite and trace-driven storyboards with provenance labels; broaden supported language constructs only alongside semantics and adapter coverage. Revisit Bend 2 as its proof boundary and backend fidelity evolve.

Success means developers can answer **what was established, for which artifact and inputs, under which assumptions, by which method, and what remains unknown**—without needing to infer those distinctions from a green badge.
