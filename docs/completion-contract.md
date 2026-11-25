# v1/v2 end-to-end completion contract

## Completed acceptance checkpoint (2026-11-12)

The local application-profile acceptance below is implemented and executed.
`pnpm run workspace` serves both profiles using separate SQLite databases and the
actual Effect adapter. The server and UI share derived input descriptors; live
notifications carry declared resource/relationship invalidations and event-time
recipient provenance. Clients resynchronize complete durable snapshots on reconnect.

- `pnpm test`: 155 tests pass, zero failures/skips, including workspace server,
  semantic v1/v2, persistence/approval, independent generated histories and v1 Lean.
- `pnpm run workspace:test`: both profiles, two-session synchronization, pending/
  grant/resume, same-database restart/reconnect, competing changes, stale/expired
  rejection, lifecycle actions, duplicate JSON invocation, preserved focus/drafts,
  delayed old-profile/actor responses, mobile/keyboard and axe checks pass.
- `pnpm run durable:generated`: six seeds, 30 commands each, independently predicted
  outcomes and exact fresh-database replay. 72 committed outcomes, 18 pending,
  18 approved, 12 duplicate, and 60 categorized rejections. Three full-observation
  mutation checks detect stale acceptance, double decrement and missing commit.
- Actual continuous cursor/click-highlight recording:
  `artifacts/workspace-v1-v2-demo.mp4`, 100.32 seconds, H.264, 1440×1060, 25 fps.

Completion here is the declared local profiles, not every future language goal.
v1 intentionally retains preallocated slots and its numeric-only Lean projection;
v2 creates/deletes records and resumes policy-derived approvals but has no Lean
theorem. The original live issue workspace is preserved on its existing runtime.
Reactivity is declaration-derived invalidation plus full snapshot resync, not
incremental joins or bidirectional propagation. Authentication, scheduling,
external delivery, model migrations and production deployment remain outside these
profiles. Browser restart tests reopen handles/listener in one process; separate
adapter tests exercise process death/restart. Neither certifies power loss.

See [workspace UI](workspace-ui.md), [server](workspace-server.md), and
[generated histories](durable-generated-tests.md) for exact commands and scopes.

Implementation target: usable local application profiles with their declared
semantics, execution adapters, recovery, tools, explanations and verified workflows.
This does not rename either profile into a finished general-purpose language.

## Acceptance

- v1: existing slot-based inventory and issue regression demos remain reproducible;
  the inventory profile also runs through actual Effect/SQLite from the new UI.
- v2: dynamic reservations, policy-derived approvals, fresh-clock resume,
  cancel/expire/delete, two-session updates and backend restart recovery through UI.
- Shared UI/API tools derive action input descriptors from the selected model.
  Policy decisions stay in the interpreter; pending is not reported completed.
- Relationship-derived invalidation/recipient explanations, with explicit durable
  resynchronization on reconnect; no hidden action-name mutation implementations.
- Test end-to-end restart, competing commands, duplicate delivery, stale and
  expired approvals, and generated lifecycle histories with an independent oracle.
- Preserve v1 proof evidence; unsupported v2 proof targets remain explicitly
  unsupported. Record exact evidence and remaining profile limits.

## Local workspace handoff

New files live in `workspace/`. Backend owns `server.ts`, `server.test.ts`,
`derive.ts`, `derive.test.ts`, and `docs/workspace-server.md`. Frontend owns
`app.ts`, `index.html`, `browser-test.ts`, `video.ts`, and
`docs/workspace-ui.md`. Do not edit each other's files.

`createWorkspaceServer({directory, port:0})` exported from `workspace/server.ts`
returns a Promise of `{url, close()}`. `close()` awaits listener/DB cleanup and SSE
closure. CLI uses `WORKSPACE_DIR` (default artifacts/workspace-data), `PORT`
(default 4173), binds loopback, and serves the UI at `/`. Each profile has its own
SQLite file. Never reset/delete existing databases on startup.

HTTP JSON API:

- `GET /api/snapshot?profile=v1|v2&actor=alice`: returns
  `{profile,model,state,pending,events,tools,sequence,scope}`. `pending` is an array
  of durablePending projections; `events` is an ordered array of
  `{sequence,eventId,event}` (non-destructive, not just unacked). Tools are
  `[{name,inputs,policyIds,preconditionIds}]` derived from model actions.
  Snapshot always contains complete current state; actor is simulation context.
- `POST /api/execute`: `{profile, invocation}` -> exact durable result.
- `POST /api/approve`: `{profile,command:{id,invocationId,policyId},actor}` -> result.
  Actor is explicitly a local simulation identity, not authentication.
- `POST /api/resume`: `{profile,command:{id,invocationId,clock}}` -> result.
- `GET /api/events?profile=v1|v2&actor=alice`: SSE `change` notifications contain
  `{sequence,invalidations,recipients,reason}`. Initial/reconnected stream emits
  resync notification. Client fetches snapshot after notifications; sequence may
  include pending/grant operations that do not advance domain state revision.
  Invalidations derive from changed resource facts and relationship declarations;
  approval changes explicitly invalidate pending views.
- Errors use non-2xx `{error}` for malformed requests/storage/transport errors;
  domain rejected/pending/duplicate remain normal JSON results with HTTP 200.

UI uses this API, displays profile/version and connected/reconnecting status,
preserves drafts/focus across background refreshes and shows historical event
facts separately from current availability. No browser-provided receipt authority.
Backend may add documented fields, but coordinate incompatible API changes through
this handoff. Tests use temporary data directories and ephemeral ports.
