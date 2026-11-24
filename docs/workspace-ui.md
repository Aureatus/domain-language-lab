# Local inventory workspace

The workspace is an API-backed workbench for the existing v1 and v2 inventory
profiles, not a marketing dashboard or a new semantic implementation.

## Run

```sh
node workspace/server.mjs
# Open http://127.0.0.1:4173
node workspace/browser-test.mjs
node workspace/video.mjs
```

The server defaults to `artifacts/workspace-data`; `WORKSPACE_DIR` and `PORT` can
override it. Startup never resets databases. Browser tests and video each create
an exclusive temporary directory under `/tmp/opencode` and use an ephemeral port.
They use the already-installed Playwright/axe tooling in
`/tmp/opencode/workbench-tooling/node_modules`; recording additionally needs
`ffmpeg` and `ffprobe`. No dependency installation or global configuration occurs.

## Interaction contract

- **Profile and actor:** v1 has capacity five and preallocated owner-bound slots;
  v2 has capacity eight and inserts caller-chosen reservation IDs. Each profile has
  its own SQLite database. Actors are explicitly local simulations, not login or
  authorization credentials. Permissions are evaluated by the interpreter.
- **Actions:** input names/types/minima come from the snapshot's derived tool
  descriptors. Forms and editable invocation JSON both call `POST /api/execute`.
  The JSON editor retains its ID, so Execute JSON can retry the exact invocation
  and display the server's duplicate result. Form execution creates a new ID.
- **Approvals:** the desk counts requests awaiting the selected actor by reading
  each request's `requirements[].approvers` and persisted grants. Only that actor's
  outstanding grants get Grant approval buttons. Other requests remain visible
  for inspection and resume, including consumed ones with an explicit retry
  control. Request Why shows policies, captured revision, invocation and grants.
  Pending does not mean committed; the UI does not decrement stock optimistically.
- **Resume:** a separate nonnegative integer Resume clock is always sent. Stale,
  missing-approval, expired/precondition and consumed outcomes show the server
  result plus contextual guidance. A stale request needs a fresh action and grant;
  the client never silently rebases it. Expiry is invocation-driven, not scheduled.
- **Recovery:** one EventSource follows the selected profile and actor. Notifications
  trigger full snapshots, including pending/grants and durable event history.
  Native SSE reconnect plus the server's initial resync restores current data after
  restart. Reconnect / resync is an explicit recovery control. Generation and request
  serial guards discard late old-profile/actor or superseded snapshot responses.
- **Drafts:** action/actor/profile drafts and tool JSON remain in memory. Background
  snapshots do not replace the form or resume clock, so focused fields and text
  selections survive pushes. Refreshing approval/history lists retains expanded
  details and surviving focused buttons. Drafts do not survive a browser reload.
- **Why/history:** the latest server notification exposes relationship-derived
  invalidations, recipient provenance and resync reason. Historical events expand
  into exact persisted facts, separate from the current stock table. No browser
  local storage, client receipt, or local state mutation is an authority.

## Executed acceptance evidence

`node workspace/browser-test.mjs` exercises the real exported server, Effect adapter,
SQLite and Chromium. It writes `artifacts/workspace-browser-test.json` and desktop/
mobile screenshots. Covered workflows:

1. v1 reserve/cancel/expire, owner denial, inclusive expiry boundary and stock
   propagation between two pages.
2. v2 pending with unchanged stock, missing approval rejection, approver inbox/grant
   synchronization and focused draft/text-selection preservation during a push.
3. Close the listener and SQLite handles; reopen **the same directory and port**;
   both pages reconnect without reload. Persisted grants reappear. A competing
   commit makes resume stale; a fresh request/grant/resume commits once, and a new
   resume ID rejects consumed.
4. Active-delete rejection, denied cancellation, owner cancel/delete, expired
   approval resume and actual warehouse expiration. Tables synchronize remotely.
5. Tool JSON execution, exact duplicate delivery without a second decrement,
   malformed JSON and a real non-2xx invalid-clock response.
6. Committed history after another database reopen; deliberately delayed old actor
   and profile snapshots; restoration of actor-specific drafts.
7. 390px mobile layout, focusable horizontally scrollable tables, keyboard actor
   navigation, no page exceptions, and automated axe WCAG A/AA checks.

`node workspace/video.mjs` records an actual continuous, paced browser session to
`artifacts/workspace-v1-v2-demo.mp4`, with visible mouse movement, click pulses and
captions. `artifacts/workspace-video.json` records duration and chapter timings.
The recording shows both profiles, a persisted grant and actual backend close/
reopen, a competing change, stale resume, a fresh successful grant/resume, consumed
rejection, cancellation, deletion and event/relationship Why. No slideshow, cuts,
retiming, invented database states or precomputed outcomes are used.

## Limits and evidence boundary

Read depth: full local README, completion API contract and inventory-v2 memo;
selected inventory models, durable adapter and server/derivation source; independent
execution of the browser tests and recording. Desktop and mobile screenshots were
opened for visual inspection.

Restart here means listener/SQLite-handle teardown and reopen in one Node process,
not an OS process kill, power-loss test or proof of filesystem durability. Two-page
coverage is not a concurrent-host/load test. The app assumes the supplied model,
interpreter, adapter, Node/SQLite, server and filesystem contracts. Automated axe
and limited keyboard checks are not a full assistive-technology audit.

This is a finite-profile renderer (integer/string inputs in these models), not a
general schema renderer or a production authenticated application. Large histories
and pending lists are unpaginated; consumed requests remain inspectable, rather
than being pruned or archived. Current clocks, request IDs and actors are explicit
host/user simulation inputs. There is no scheduler, offline mutation queue, saved
draft persistence, browser-provided receipt authority or claim of external
exactly-once execution. v1 numeric proof scope is unchanged; no v2 approval/lifecycle
proof is claimed. Backend correctness tests and broader semantic histories remain
separate evidence from these UI workflows.
