# Time away: a model-derived leave application

Run `npm run leave`, then open **http://127.0.0.1:4174**. No build is needed.
`PORT` and `LEAVE_DIR` select the listener and persistent directory; the default
remains `artifacts/leave-data/leave.sqlite`. Existing storage is reopened, not reset.

The application author entry is now **`leave/time-away.domain`**, a standalone
[experimental text syntax](standalone-syntax.md) declaring the semantic domain,
initial state and data-only presentation/input configuration. `leave/model.ts`
is only its loading bridge. The reusable
`application/` runtime derives server dispatch, the browser forms/views/inbox and
HTML-shell content. `leave/server.ts` is only a compatibility launcher.

See **[model-derived application](model-derived-application.md)** for the exact
authoring boundary, generic HTTP API, executable source count, tests and limitations.

## Try the story

1. Maya has **five days**. Request Friday **20 November 2026**: automatically
   approved, **four** days remain.
2. Request **23–25 November**: three weekdays need approval; Maya still has **four**.
3. Switch to **Sam Rivera · manager**. **Save approval** stores a real durable grant
   without deducting. **Complete request** separately resumes the saved invocation;
   the grouped balance/leave update leaves Maya **one** day.
4. Switch to **Leo Martin · employee**. Set **26–27 November**. The two-day preview
   is automatic; do not send yet.
5. Switch to Sam and save the approval threshold **2**. Return to Leo: his same
   preserved date draft now needs Sam's approval, with **five** days still available.
6. Send, save Sam's approval, then complete: Leo has **three** days.

Other open views update through SSE. Drafts survive updates and actor switches
within the page session. If anything commits after a pending request, its full-state
binding becomes stale: a saved grant may remain valid as historical approval but
completion fails without deducting. Send a new request; this prototype does not
rebase, cancel or supersede stale requests.

`/?actor=sam` selects Sam initially. `/?watch=1` hides mutation controls for an
observer layout, not for security. `/?explain=1` enables the optional generic
[declaration/result companion](time-off-explained.md).

## Verify

```sh
node --test application/*.test.ts leave/*.test.ts
node leave/browser-test.ts
node leave/explained-video.ts --test
npm run application:test
npm test
```

Browser scripts reuse the existing Playwright installation at
`/tmp/opencode/workbench-tooling/node_modules/playwright/index.mjs`. No dependencies
were installed. Browser runs use fresh temporary DBs and do not reset the demo.
Current reports/screenshots use `artifacts/derived-time-off-*`.

## Recordings are historical

The preserved [narrated edition](../artifacts/time-off-demo-narrated.mp4),
[`time-off-demo.mp4`](../artifacts/time-off-demo.mp4) and
[`time-off-code-companion.mp4`](../artifacts/time-off-code-companion.mp4) show the
**previous handwritten UI and combined approval control**, not the new derived
renderer. Their original outcomes were actual executions; they are not current UI
verification. [Audio sources and reproduction](time-off-audio.md) remain unchanged.

`node leave/video.ts` and `node leave/explained-video.ts` now use the generated
contracts and separate grant/resume controls and produce new raw WebM recordings
through the browser scenario. They do not overwrite the historical MP4s. No new
recording was required or made for this migration.

## Boundaries

This is a loopback **local identity simulation**, not authenticated staff software.
All local clients can inspect all projected resources. Dates use a trusted named
UTC Monday–Friday host adapter, not holidays/time zones/half-days/accrual/overlap
checking. Core policies/preconditions authorize requests and updates; actual
durable requirements route approvals. Grant and resume are separate transactions.
SSE broadcasts/resynchronizes full snapshots; it is not secured recipient delivery.
Lost HTTP replies are ambiguous and local duplicate locking is not cross-request
idempotency. SQLite/Effect/interpreter/host assumptions and excluded guarantees
are documented in [durable execution](durable-execution.md) and the
[application contract](model-derived-application.md).
