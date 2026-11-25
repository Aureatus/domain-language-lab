# Autonomous implementation log

The user authorized sustained implementation/review/test cycles without routine
approval gates. Continue using Sol 6.1/Luna 6 for scoped implementation and review,
with the primary agent coordinating integration. Ask only when a decision would
materially redirect the project or require authority not already given.

## Current assumptions

- The next deliverable remains a local, single-user executable demonstration of
  domain derivation, not a hosted SaaS deployment.
- Local browser persistence is useful; account authentication, remote hosting,
  billing and shared multi-user storage remain separate decisions.
- The language is named Premise. Example-app titles are not language names.
- Preserve the prior experiments and evidence boundaries. New runtime features
  do not inherit the earlier Lean theorem's guarantee.
- Advance actual declaration/runtime/renderer contracts, not just interface polish.

## Completed implementation batches

### Familiar time-off demonstration

The user found inventory terminology hard to follow and approved a leave-request
story. `leave/` now uses the same v2 interpreter and Effect/SQLite adapter with Maya,
Leo and manager Sam, actual dates, balances and plain-language outcomes. Maya goes
5 -> 4 -> pending -> 1; Leo's separate five-day balance makes the two-day rule-change
example valid without resetting history. The threshold is a declared settings
resource read by policy expressions, not a compiler or model-binding rewrite.
Sol implemented the app/video and Luna independently reviewed the flow. Main
screens hide technical state behind a shared-declaration disclosure. The recording
uses actual interaction, visible cursor/clicks and captions, with no audio narration.

### End-to-end v1/v2 completion (2026-11-12)

The user requested completion of both profiles. Sol implemented the unified local
server and UI, actual durable adapter integration, two-session browser tests and
continuous demo; Luna reviewed the integrated workspace. The first generated-history
pass had insufficient independent outcome prediction and weak variation. A second
Sol pass added six seeded histories with predicted successes/rejections, full replay
commands/observations and same-checker mutation sensitivity. Parent integrated scripts,
ran the full suite/browser/generated reports and consolidated the evidence.

Acceptance and supported boundaries live in `docs/completion-contract.md`.
All state mutation remains interpreter-driven. UI refreshes use declared invalidation
explanations plus complete durable snapshots, not an invented incremental query engine.

### Lifecycle and durable execution (2026-11-12)

Following the user's request to proceed, implemented an opt-in v2 core with grouped
insert/update/delete, policy-derived eligible approvers, serializable bound requests
and receipts, and fresh-clock resumption. v1 remains unchanged so prior generated
Lean artifacts do not silently acquire different source semantics.

Effect now has a SQLite adapter persisting state, outcomes and outbox facts in one
transaction; approval requests/grants and one-shot consumption use bounded durable
operations. Inventory v2 creates named reservations rather than reserving slots.
Its CLI executes pending -> reopen -> grant -> reopen -> resume, duplicate retry,
cancel/delete, and separate stale/expired rejection scenarios. Independent review
covered the v2 core and, in a separate pass, persisted approval transactions.

Decisions: full-state approval invalidation is deliberately conservative; any
intervening state change requires a new request. Database content is bound to one
complete model; upgrades are not automatic. The outbox supports pull/ack with
possible redelivery, not external exactly-once delivery. Approver/clock inputs are
trusted-host simulation. The existing browser demonstrations remain v1; v2 evidence
is CLI/process/database execution.

1. Versioned workspace export/import backed by a deterministic command journal.
2. Local saving and safe recovery on reload, with clear saved/unsaved status.
3. Read-only replay of past workspace steps, preserving event-time explanations.
4. Draft/focus preservation, usable issue filters and keyboard navigation.
5. Generated state-machine tests of the live runtime, including policies,
   relationships, rejected commands and replay parity.
6. Independent review, browser verification and updated cursor-visible demo.

Subsequent iterations added declaration-change previews, positive/negative
declaration-derived cases, contextual action availability explanations and
cancelable worker execution. Reviews found real bugs and regressions; fixes carry
tests. The generated historical-value check now compares captured serialized
baselines rather than a value to its own fresh clone.

Performance investigation found repeated journal reconstruction took tens of
seconds at 100 entries. Trusted forks now reuse already validated immutable state;
measured direct-check time fell from 30.50 s to 770 ms in the implementation run.
Those are machine-specific single-run measurements, not an SLA. Interactive checks
run in a worker regardless; cancellation, stale output and unavailable workers are
explicitly handled.

## Assumptions retained for later confirmation

The subsequent user request authorized all three architectural milestones. Sol
implemented the shared interpreter, inventory UI/replay/video and Lean generator;
Luna implemented the real Effect adapter and reviewed the combined work. Integration
added actual inventory Effect tests and an explicit AST-derived stock-only Lean
projection. Review found order-sensitive retry identity; the parent corrected it,
snapshotted caller data and added a regression covering model/content identity.

Consequential assumptions: reservations use preallocated slots because the bounded
IR has no insertion; expiration is an explicit clocked command; the browser runs
the reference interpreter while Effect/Lean are separately executed adapters;
the old live issue runtime remains intact and a smaller issue fixture tests reuse.
Lean evidence covers numeric stock updates only, with all exclusions recorded.

- Browser-local persistence and export/import are the useful next durability step;
  no remote deployment, accounts or credential setup was introduced.
- State reconstruction uses a versioned journal. This is replay of local domain
  actions with captured time, not replay of external payments/messages.
- The six-action issue domain is deliberately finite. We should validate general
  semantic/action/adapter contracts before choosing final language syntax.
- Rule edits are development operations. The demo's actor selector is not login.
- Browser recordings communicate the workflow; they are not proof evidence.

## Handoff: workspace persistence contract

Core extends `createApp` without breaking current consumers:

- `exportWorkspace()` returns deeply copied/frozen JSON with `format`,
  `seedVersion`, `journal`; the journal records successful dispatches (with captured
  clock values) and accepted rule edits in order. No network calls on replay.
- `restoreWorkspace(document)` validates and reconstructs in isolation, then
  atomically replaces state/model/journal; returns `{ok,reason?}`. Failures leave
  the current runtime untouched. Unknown versions reject explicitly.
- `previewWorkspace(stepCount)` returns `{ok,state?,model?,reason?}` reconstructed
  from the first N journal entries, without mutating live state or journal.
- `createApp({clock?,workspace?})` can initialize by validated reconstruction;
  invalid initial workspace throws. The injected clock governs future actions,
  while replay uses captured values.

UI persists exported documents, not raw mutable application state. It reports
storage failures rather than claiming a save. Replay views are read-only; changing
their selection must not dispatch or overwrite the current workspace. Import and
reset are explicit user actions. This is local reconstruction, not proof of
external effects or cryptographic integrity.
