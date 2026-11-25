# Live issue workspace

Latest continuous demo: `artifacts/live-issues-demo-v4.mp4`, including current-action
explanation, declaration preview, worker checks, reload recovery and read-only
history. Rebuild/re-record with the commands below; earlier MP4s are retained.

This experimental browser-local issue tracker executes the shared `live/core.ts`
at interaction time. Unlike the earlier workbench, it has no precomputed action
histories. Open `artifacts/live-issues.html` directly; no server or dependencies are
required to use the built artifact. Successful actions and rule edits are saved as
a versioned workspace journal in this browser's `localStorage`, then validated and
reconstructed on reload. The displayed actor selector is a local simulation, not
login, authentication, or shared access.

## Use it

Create an issue, assign it as Maya (lead), and add a comment. Switch to Jonah or
Sofia to see their recipient inbox. Contextual **Why** opens the core's captured
event: actor, declaration revision, changes, relationship snapshot, and recipient
paths. The activity disclosure gives access to an issue's historical explanations.

**Why unavailable** beside disabled contextual actions opens a keyboard-accessible
dialog with a concise current reason and structured details behind disclosure.
Forms show their current rejection reason and a Why disclosure as inputs change;
unchanged assignment is unavailable until changed (including explicit Unassigned).
All availability comes from core `explainAction(action,args,actorId)`, sharing
dispatch's policy, validation and preconditions—not a renderer policy interpreter.
Create/assign editor launchers may open with missing inputs so you can supply them;
this does not claim the incomplete action can execute. Submits use full form args.
Current availability includes declaration revision/source and absent required input
paths when meaningful. It is a pure query, not a saved approval or guarantee that
the execution clock/resource limits will succeed. Event **Why** remains historical.

The development lab is closed initially. Edit comment/resolve `allowedRoles` and
`notify` paths there. Checkbox edits preview concise added/removed roles and routes
against the applied revision **before Apply**, without changing live state. The
preview is an exact declaration diff, not a complete reachable-behavior analysis
or a prediction of specific recipients. Returning to the applied values shows an
explicit no-op. Applying changes immediately updates action availability and generated
tool descriptors. Future actions use the new rule; old explanations and
notifications remain unchanged. Actor exclusion and deduplication belong to the
core, not the renderer. Assignment is lead-only under the initial declaration.

Tools show the current generated descriptors and accept editable JSON arguments.
Their availability reason updates from the editable arguments and selected actor,
with structured core output behind disclosure. Malformed JSON is explicitly a
parse error with no policy/precondition claim. Invoke remains usable to demonstrate
actual dispatch rejection; query availability never bypasses execution checks.
Invocation calls the same `dispatch` used by forms and buttons; hiding or disabling
a button is not the policy boundary. Invalid JSON never dispatches. **Run
current-state checks** executes the core's named invariant checks and displays
their actual results. These audits cover only current local state: no formal
runtime correspondence, authentication, storage durability, external delivery, concurrent
clients, or general language implementation is claimed.

**Run declaration checks** sends the exported workspace to an offline Blob Web
Worker running `runDerivedChecks` from the shared bundled `live/derive.ts`,
separately from the current-state audit and historic Lean
artifacts. It derives cases from the applied declarations and current workspace,
then validates/reconstructs once and runs actual tool dispatch in isolated trusted
snapshot forks, including prepared setup. The table shows
each case's action, actor, expected and actual outcome, status, and reason, with
passed/failed/unknown/skipped counts. Unknown preconditions are not passes. These
finite generated cases are not exhaustive property tests or a proof. Unapplied
checkbox drafts are not checked. Live action/model changes, import, reset, and
history preview invalidate results; reload does not preserve check evidence.
While running, the UI stays interactive and offers **Cancel declaration checks**.
Cancellation terminates execution and reports unknown; it does not manufacture a
passing partial report. State/model changes also terminate the job, and obsolete
responses cannot replace current evidence. Worker unavailability, resource/startup
or execution errors, undecodable messages and a 60-second time budget visibly
report unknown. There is **no synchronous fallback**. Current-state audits remain
separate synchronous operations. See [performance measurements and remaining
limits](live-derivations.md#interactive-execution-and-measured-performance).

## Local saving, recovery, and history

The save-status line distinguishes recovered/saved work, unavailable storage, and
failed writes. Successful dispatch is not the same as successful storage: quota or
browser-policy failures leave usable in-memory changes and an explicit **Not
saved** message. Export before leaving in that case. The browser owns durability;
clearing site data loses the save. `file:` URL storage behavior varies by browser,
and moving the HTML may change its storage area. No synchronization, encryption,
multi-tab conflict resolution, or external backup is provided.

**Export JSON** downloads the live core workspace, including accepted declaration
edits. **Import JSON** uses the core's atomic validation/reconstruction; invalid
JSON, unsupported versions, or invalid journal entries leave the current workspace
and saved document unchanged. Import replaces the workspace after validation.
**Reset** opens a confirmation explaining that it replaces persisted work with the
seed; ordinary reload never resets it. Export first to retain a copy.

If a saved document cannot be recovered, the original remains untouched and
automatic saving pauses. The seed is available for in-memory work, clearly marked
as unsaved. Export the unreadable original for recovery, import a valid workspace,
or explicitly confirm reset. A rejected import does not unlock automatic saving.

**Workspace history** reconstructs the first N journal entries with
`previewWorkspace(N)`. It shows historical issues, inboxes, and captured event
explanations without changing live state or storage. Forms, actions, rule edits,
tool invocation, import, and reset are unavailable in preview. **Return to live**
restores the live selection. Export always exports live work, not a partial preview.
Replay is local reconstruction, not proof that any external effect occurred.
Current-availability explanations are explicitly disabled in history preview:
no live-model availability query is presented beside historical actions. Historical
event Why still uses the preview's captured events, never today's rule.

Comment drafts are separate for each actor/issue pair. Editable tool JSON is kept
per tool. Both survive rerenders, actor/issue switches, and history previews, but
are session-memory drafts, not persisted on reload or included in JSON exports.
Successful comments clear only their own draft. Explicit reset clears all drafts.
Search matches issue title, ID, and description; combine it with **Unresolved** and
**Assigned to me**. Queue buttons support Arrow Up/Down, Home/End, and Enter;
search retains focus and caret while filtering.

## Reproduce

```sh
node live/build.ts
node live/browser-test.ts
node live/record-demo.ts
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of json artifacts/live-issues-demo-v3.mp4
```

Build uses only Node built-ins and inlines core, derive, generated worker source,
then UI into the HTML,
with isolated module-local scopes and explicit core-import alias handling. It rejects
unsupported module syntax instead of silently omitting it. The worker source is
generated from shared modules, not a copied interpreter or fetched file. Browser automation
uses the existing Playwright and axe packages in
`/tmp/opencode/workbench-tooling/node_modules`; recording additionally needs
`ffmpeg` with H.264 support. No package changes or dependency installation are needed.

Tests interact with actual controls and read the shared core for assertions. They
cover create/assign/comment/resolve/reopen/watch, related inbox and notification
Why, comment/resolve role and notification declaration changes, denial through a
tool, updated descriptors, editable tool JSON, historical explanation immutability,
current-state checks, declaration preview/no-op without mutation, generated case
tables without live/storage mutation, role-derived expectation changes, stale
check invalidation, explicit persisted reset, reload recovery, export/import
round trips, rejected imports without state loss, retained corrupt saves,
storage-denied/quota status, read-only history/return, actor/issue and tool drafts,
search/filter/queue keyboard controls, keyboard-opened editors/Escape/focus restoration, and
390px responsive layout. Axe scans test selected desktop, mobile, editor, lab,
and explanation states; this is not a complete accessibility or cross-browser
certification. Results are written to `artifacts/live-browser-results.json` with
desktop/mobile screenshots alongside it.
`artifacts/live-declaration-browser-results.json` also retains the actual baseline
and edited-declaration case reports used to assert the rendered table.

`artifacts/live-issues-demo-v3.mp4` is 60–90 seconds of continuous Chromium video,
showing live create/comment, pre-Apply rule impact, resulting tools/inbox,
generated checks, saving/reload, and read-only history. Older movies are retained.
It is converted to H.264
with ffmpeg. Cursor movement and click pulses follow actual Playwright mouse
events. Brief captions explain the current interaction; pacing is editorial, not
an execution latency measurement. `artifacts/live-video-v3/interactions.json` records
click timestamps. The script never swaps in static-state slides.

Read depth for this update: README, `live/DERIVATION-CONTRACT.md`, existing
renderer/browser-test source, and selected core persistence API implementation.
Independent execution: live build and Chromium browser suite. No external research
or proof audit was performed for this renderer.

Earlier current-availability slice scope: only `live/core.ts`, `live/core.test.ts`,
`live/app.ts`, `live/template.html`, `live/browser-test.ts`, and the two live
guides. No action/journal semantics, derive/build/recording/package sources changed.
Existing actor/issue drafts, per-tool JSON drafts, persistence and derived-check
invalidation remain in place. Browser coverage adds keyboard-opened availability
dialog/Escape/focus restoration, rule-change updates, partial/schema tool reasons,
query nonmutation, unchanged/null assignment, and explicit history suppression.
Executed checks: `npm test` (49 passing), `npm run live:build`, and
`npm run live:test` (Chromium flows and seven axe scans). This is finite local
integration evidence, not a general policy-system or accessibility proof.

The subsequent fork/worker performance slice also updates core/derive/build and
their tests. Chromium coverage adds actual 100-comment worker results, animation
frames and search during computation, cancellation/termination, delayed stale
response rejection after commit/rule/import/reset/history/replacement, unavailable
workers and injected startup/runtime failures, resource-limit unknowns and an
offline context with zero HTTP(S) requests. The table remains a synchronous DOM
projection; ordinary imports/history/actions still execute synchronously. No
recording, package or template source was changed for this slice.
