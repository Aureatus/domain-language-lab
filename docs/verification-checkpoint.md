# Verification checkpoint: time-off story demo

Latest integrated run:

- `pnpm test`: **159 passed**, zero failures/skips, including four new leave tests.
- `pnpm run leave:test`: Maya's balance/approval story, Leo's same-date rule-change
  story, two independent live clients, invalid dates, insufficient balance,
  unauthorized operations, stale saved-grant/resume failure without deduction,
  database reopen/resync and mobile overflow checks passed.
- Independent read-only review found no actionable issues in the inspected leave
  model/server/UI and targeted tests.
- `ffprobe`: `artifacts/time-off-demo.mp4` is H.264, 1440×1080, 25 fps,
  102.04 seconds. Starting screenshot and actual-video contact sheet inspected.

This is a familiar-domain demonstration of the existing core, not a new proof.
Dates count Monday–Friday without holidays. The threshold is live settings data
read by a policy; changing it is not a compiler/source edit. Approval grant and
resume are separate durable transactions. Full boundaries: `docs/time-off-demo.md`.

## Earlier checkpoint: end-to-end v1/v2 workspace

Latest integrated run (2026-11-12):

- `pnpm test`: **155 passed**, zero failures/skips. Includes all prior semantic,
  adapter, v1 Lean and issue tests, plus workspace server/derivation and stronger
  generated-history tests.
- `pnpm run workspace:test`: passed actual SQLite/Effect/browser flows for both
  profiles, two-session updates, same-DB listener/handle restart and reconnect,
  approval/stale/expiry/consumed behavior, JSON duplicate delivery, lifecycle,
  draft/focus, late-response guards, mobile, keyboard and axe checks.
- `pnpm run durable:generated`: six 30-command histories pass independent outcome,
  record/state and approval expectations; exact replay succeeds. Actual coverage:
  72 committed, 18 pending, 18 approved, 12 duplicates, 60 rejected outcomes.
- Independent workspace review reported no actionable defects in inspected files
  and targeted tests. Generated history evidence was strengthened after parent review.
- `ffprobe` confirmed the recorded demo is H.264, 1440×1060, 25 fps, 100.32 seconds.
  Desktop screenshot and decoded movie samples inspected.

Evidence: `artifacts/workspace-browser-test.json`,
`artifacts/durable-generated-report.json`, `artifacts/workspace-v1-v2-demo.mp4`.
See `docs/completion-contract.md` for acceptance scope. These results do not establish
v2 proofs, general bidirectional reactivity, authentication or external delivery.

## Earlier checkpoint: lifecycle and durable approvals

Latest integrated execution (2026-11-12):

- `pnpm test`: **140 passed**, zero failures/skips. Includes existing v1 Lean
  checks, v2 lifecycle/approval semantics, SQLite rollback/recovery, competing
  processes, invocation identity, grant/resume persistence, and both inventory
  profiles. Existing browser runtime unit/generated tests remain in the suite.
- `pnpm run inventory:durable`: three actual SQLite scenarios passed: full
  pending/reopen/grant/reopen/resume/retry/cancel/delete lifecycle, stale approval
  after intervening reservation, and fresh-clock expiry rejection. Report:
  `artifacts/inventory-v2-report.json`. The CLI reopens handles; additional tests
  run phases in separate Node processes.
- `git diff --check`: no errors. Source files remain untracked local work, so
  this command alone does not audit their whitespace or establish a clean commit.

Review covered v2 semantics and, in a separate completed pass, persisted approval
transactions. No actionable findings were reported in those bounded reviews.
This iteration adds no v2 theorem. Prior Lean evidence applies only to v1. SQLite
durability is conditional on SQLite/local filesystem behavior; no power-loss or
multi-host certification. Actors, approvers and clocks remain trusted-host inputs.
The existing browser demos and videos remain v1; v2's deliverable is executable
core, durable adapter, tests and CLI evidence.

## Earlier checkpoint: shared core and inventory

Latest integrated execution after adapter review corrections:

- `pnpm test`: **100 passed, zero failures/skips**, covering original prototype,
  live issues, shared semantics, inventory, actual Effect and generated Lean.
  Includes key-order-independent retry identity, caller mutation isolation and
  model-sensitive invocation conflicts.
- `pnpm run inventory:build` and `pnpm run inventory:test`: offline inventory UI
  flows, replay, failure/correct schedules, import/export and mobile checks passed.
- `pnpm run live:test`: existing issue browser workflows passed, seven axe scans
  and seven state audits. The issue application retains its original interpreter.
- `pnpm run proof:inventory`: **proof_checked** with Lean 4.19.0, commit
  `6caaee842e94`; `preserves` uses `propext`, positive witness no axioms.
  Evidence is `artifacts/inventory-proof/report.json`. The source is the actual
  inventory reserve AST, projected to stock integer expressions with exclusions.
- `pnpm run inventory:video`: regenerated continuous cursor-visible interaction
  with click pulses, replayed overselling and corrected behavior, H.264 MP4 at
  `artifacts/inventory-demo.mp4`. Screenshots and decoded sample frames inspected.

The Lean result proves the generated numeric kernel's conservation/nonnegativity
law, not full inventory behavior, authorization, concurrent scheduling or runtime
correspondence. Effect tests exercise process-local synchronized storage, not
durable/distributed execution. The independent accepted-command oracle detects
the deliberately broken host's two promises totaling six units from five even
though the overwritten final snapshot alone appears conserved.

## Earlier checkpoint: saved live workspace

Recorded after the autonomous persistence, derivation, availability and performance
iterations. These are execution results for this experimental repository, not
formal verification of the full proposed language.

## Commands executed

- `pnpm test`: 51 tests passed, zero failures. Covers the original approval
  experiment and current live core, journal, isolated forks, derivations and
  generated test harness.
- `pnpm run live:generated`: sampled pass for seed 335597, 40 histories of 80
  commands. 2,516 dispatch attempts and 684 rule edits. Successful actions:
  create 267, assign 91, comment 208, resolve 95, reopen 31, watch 199.
  Includes 1,203 role denials and 1,625 total rejected dispatches.
- `pnpm run live:build`: self-contained offline HTML with shared core, derive
  module, UI and worker code generated from those same sources.
- `pnpm run live:test`: browser workflows passed, seven automated axe scans and
  seven current-state audit outcomes. Includes local save recovery, atomic failed
  imports, preview guards, drafts, current-action explanations, cancelable worker
  checks, stale worker results and offline request checks.
- `pnpm run live:video`: continuous Playwright recording converted to
  `artifacts/live-issues-demo-v4.mp4`. ffprobe: H.264, 1440×940, 30 fps,
  70.4 seconds. Decoded sample frames inspected for cursor and visible workflow.
- Local Markdown link check and package JSON parse passed.

## Evidence boundaries

Sampled histories are not exhaustive model checking. Generated declaration cases
are finite executable checks, and `unknown` remains distinct from passing.
Browser coverage is Chromium plus selected accessibility scans, not a complete
cross-platform accessibility audit. The original Lean proof concerns its separate
mathematical transition model, not this live runtime.

Local saved documents are reconstructed and validated, not cryptographically
authenticated. Browser storage is not remote replication or durable external
delivery. Video timing is editorial pacing and does not establish latency claims.

The performance memo in `docs/live-derivations.md` records separate machine-specific
before/after measurements; these are not benchmark guarantees.
