# Project checkpoint

Updated 2026-11-11.

## User direction

Explore an unnamed Ash-inspired language/extreme DSL combining typed domains, Effect execution, Alchemy deployment, Distilled provider interfaces, rich renderer-independent UI, safe scoped interop, implicit events and policy-derived approvals. Keep the language general rather than adopting Lucent-specific terminology. The user disliked the placeholder Lumen; no name is selected.

The user wants research distilled for agents rather than assigned as reading. They requested a repository and specialist agents, then endorsed the derived-capability backlog and authorized one example application to test the architecture.

## Work recorded

- Researched Ash ecosystem, including source for UI derivation and durable workflow/event mechanisms. Corrected the earlier overly broad impression that durable approvals were absent.
- Inspected Alchemy/Distilled source and in-progress work; separated authorization from Alchemy event-reaction Policy and provider retry from mutation replay guarantees.
- Reviewed selected literature/source on semantic models, model-based UI, statecharts, lenses, incremental dataflow, capabilities, effects, causal order, property testing, model checking and proof correspondence.
- Investigated current Bend 2 and José Valim's Lynx; recorded exact reading depth and proof/translation limits.
- Initialized a local Git repository, with six project OpenCode specialist definitions. No remote publication or commit has been made by this work.
- Authored design brief, output contract, nine law/scenario sketches, detailed research memos and staged roadmap.
- Added a clearly hand-authored explanation fixture. Static checks covered JSON, document links, agent-definition shape and fixture references/order; not runtime loading or proof validity.
- Independent evidence review corrected SCXML exit/transition/entry ordering to apply per microstep rather than across an entire macrostep.
- Recorded eight additional derived capabilities in [the backlog](design/derived-capabilities.md).

## Settled direction versus provisional choices

Shared semantic identities and contracts connect execution, UI, verification and explanation. Approvals derive from policy; pending is not success. Preconditions and implementation are distinct; grouped updates are preferred. Relationship/action metadata drives observation, reaction and communication. Renderer conformance covers sophisticated applications rather than just CRUD. Test our mappings instead of reproducing upstream suites.

Syntax, numeric semantics, full IR, distributed execution guarantees, proof backend scope and renderer profiles remain provisional. A deterministic compiler does not make external distributed execution deterministic. Formal evidence must identify the semantic layer, assumptions and translation boundary.

## First prototype

The first executable experiment is a dependency-free TypeScript issue-tracker semantic slice under `prototype/`. It uses a finite declarative policy model, an in-memory reference interpreter, approval binding, simulated events, a limited policy diff and finite schedule exploration. It is an experimental model, not a production application or integration with Effect/Alchemy.

Read [prototype scope](../prototype/README.md) for commands, supported semantics, checks and limitations. Generated outputs go to ignored `artifacts/`; their evidence describes actual scope. Tests must be run before claiming they pass.

Initial execution found one changed policy context among six, and one stale-approval counterexample in the deliberate mutant across six operation schedules. Eight initial tests passed. Review then prompted explicit mutant provenance in replay exports and a snapshot-comparison oracle independent of the interpreter's approval-match diagnostic; subsequent test runs are the authority for the current files.

## End-to-end workbench expansion

The user authorized completing a demonstrable end-to-end slice and requested heavy use of Sol 6.1/Luna 6 instead of Astra for implementation. Sol implemented generated histories, independent oracle, shrinking and the visual workbench. Luna implemented the Lean pilot, reviewed verification boundaries and built the compact in-chat demonstration. Astra coordinated integration and fixed evidence-report validation.

Implemented: 216 precomputed real interpreter executions; interactive policy comparison, replay, causality/state inspection, generated counterexample minimization and JSON downloads; seeded sampled property testing; a small checked Lean transition-model theorem with positive witness. Full and compact standalone HTML artifacts are generated locally. No runtime/server is needed to use them.

Review hardened proof reporting to require the pinned Lean version and every expected theorem's complete axiom list, allowlisting only propext. Reports are JSON-encoded and fail closed on missing tools/output. Workbench builds check source hashes before displaying stored evidence. The generated-history oracle independently models public behavior; this is still testing rather than a runtime proof.

Next: establish independently checked runtime correspondence, then one real Effect/Alchemy boundary and a renderer adapter conformance experiment. Full arbitrary application authoring, production hosting and video rendering remain outside this slice.

## Live issue workspace

After reviewing the workbench, the user authorized a real everyday workflow with
inspection as a contextual layer. Sol implemented the browser-safe domain runtime
and live issue workspace; Luna performed independent review. Astra integrated
nullable assignment editing and invalidation of displayed current-state checks.

The live app executes create, assign/unassign, comment, resolve/reopen and watch
actions in the browser. Related issue views and recipient inboxes update after
each action. Why reads immutable event-time rule/relationship snapshots. A hidden
development lab changes roles/routing and derives updated tool descriptors;
invoking those tools uses the same dispatch and authorization path as UI actions.
This replaces precomputed selection for this new example, while preserving the
earlier workbench as a separate experiment.

The demonstration includes a continuous cursor-visible MP4. The local runtime
and browser checks are separate from the earlier Lean theorem, which does not
prove this runtime. The initial version was ephemeral; the autonomous iterations
below add browser-local saving. Actor switching remains a simulation.
Model editing remains a finite policy/routing interface, not arbitrary language
authoring. See docs/live-runtime.md and docs/live-workspace.md for exact scope.

## Autonomous iterations

The user authorized continued implementation/review loops with educated assumptions.
Sol and Luna supplied the implementation and independent reviews; the primary
integrated corrections and consolidated evidence.

- Versioned command journal with captured clock values, strict restore validation,
  atomic import, immutable historical snapshots and read-only prefix previews.
- Browser-local save/recovery, portable JSON export/import, preserved corrupt-save
  recovery, explicit reset, draft/focus handling, search/filter/keyboard navigation.
- Seeded generated histories for the live six-action runtime, independent policy,
  transition and routing expectations, deep historical-value checks and restored
  workspace parity. Mutation checks validate the test harness itself.
- Live rule-impact previews before Apply; declaration-derived positive/negative
  tool and dispatch cases, with unavailable setup reported unknown rather than pass.
- Pure explainAction API sharing dispatch preparation; contextual availability
  explanations in the UI and tool editor without sampling clocks or mutating state.
- Trusted identity-branded isolated forks speed up generated checks; browser checks
  run in a cancelable offline worker and discard results after live state changes.

Reviews found and corrected sparse-array rule corruption, a stale reset handler
that could bypass preview mode, an ineffective snapshot comparison and expensive
repeated journal reconstruction. No earlier Lean guarantee was broadened.

## Shared semantic core and inventory milestone

Implemented `semantic-core/v1`: typed JSON declarations drive executable
preconditions, policy outcomes, grouped updates, implicit facts and relationship
recipients. Inventory reserve/cancel/expire and a small issue fixture consume the
same interpreter. The older live issue application remains a regression application
on its original runtime; it has not been migrated wholesale.

Inventory demonstrates an executed stale-host overselling mutant, independent
accepted-command accounting, replay and corrected stale rejection/retry. Effect
4.1.4 serializes actual inventory invocations with atomic process-local state/event
publication. Generated Lean 4.19.0 checks a separately specified conservation law
over numeric expressions extracted from the actual reserve declaration. This is
an explicit stock-only projection, not full-action or concurrency verification.

The original v1 profile retains preallocated records and pending-only approval;
its in-memory Effect adapter and numeric Lean evidence remain available. The v2
iteration below addresses lifecycle/durability without silently changing v1.

## Lifecycle and durable approval iteration

Opt-in `semantic-core/v2` supports grouped insert/update/delete and policy-derived
approval/resumption with fresh-clock checks and exact full-state/model bindings.
Inventory v2 creates actual named reservations, cancels/expires them and deletes
terminal records. SQLite-backed Effect execution persists outcomes, pending
requests, grants, state and an outbox across reopen; resume consumes a request
atomically once. Duplicate IDs retain their historical result.

The executed CLI scenario is `npm run inventory:durable`; evidence and boundaries
are in `docs/inventory-v2.md` and `docs/durable-execution.md`. Routing is still one-hop; authentication, scheduling,
external delivery, model migration and v2 proofs remain future work. Runtime/proof
correspondence is unproved.

## End-to-end v1/v2 workspace completion

`workspace/` now hosts both inventory profiles through the real durable Effect
adapter, with version-isolated SQLite storage, schema-derived form/tool dispatch,
policy-derived approval UI, explicit resume clocks and durable event history.
Resource/relationship invalidations derive from declarations and committed facts;
SSE pushes trigger complete snapshot resync across sessions and after restart.
Pending/grant changes invalidate the approval view independently of domain revision.

The browser acceptance includes both profiles, two sessions, restart/reconnect,
stale/expired approvals, fresh successful resume, cancel/expire/delete, duplicate
tools, focus/draft preservation and mobile/accessibility checks. The completed
checkpoint and exact profile boundaries are in `docs/completion-contract.md`.
This does not migrate the original issue application or broaden any Lean theorem.
