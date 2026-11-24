# Time away: optional declaration companion

Run `npm run leave`, then open **http://127.0.0.1:4174/?explain=1**.

The companion is now an optional **generic evidence projection**, not required
time-off application code. The reusable renderer consumes `application-evidence/v1`
from the same generic action API. It shows captured invocation, actual policy and
precondition ASTs, the declared grouped transition and the returned status/facts.
No leave-specific header, route or browser module is involved.

**Current preview** and **Last action result** select evidence independently.
Automatic previews, actor switches and SSE updates do not replace a saved result.
The dark desktop pane stacks below the app on narrow screens. This is a declaration
and result view, **not a parser trace, execution-order instrumentation, exact
authored-source excerpt, proof or independent authority**.

The optional `leave/explain.mjs` is retained as demonstration-only tooling for
historical contiguous-source excerpts and diagnostic replay. Tests still check its
source correspondence and unchanged interpreter guard evaluation. The running
application does not import it; no hidden leave protocol lives in the framework.

```sh
node --test leave/explain.test.mjs
node leave/explained-video.mjs --test
```

The browser test exercises the real Maya/Leo/Sam lifecycle, separate durable grant
and resume, saved evidence preservation, failures, live updates, restart/resync,
desktop/mobile overflow and page errors. Current artifacts use
`derived-time-off-companion-*`. See the full
[model-derived application contract](model-derived-application.md).

## Historical recording

[`time-off-code-companion.mp4`](../artifacts/time-off-code-companion.mp4) remains
the original 140.12-second, 1920×1080 captioned browser recording, with no audio.
It shows the **former handwritten UI/exact-source companion**, not this migration.
The older narrated and explained recordings/audio are also preserved. The frame
extraction tool `leave/explained-frames.mjs` still targets that historical MP4.

`node leave/explained-video.mjs` now records the updated generic browser scenario
to a **new raw WebM path**, without overwriting those MP4s. It is functional recording
tooling, not a newly authored/paced cinematic walkthrough. Recording a new video
was not required or performed. Trust/identity/date/SQLite/SSE boundaries remain as
documented for the [time-off demo](time-off-demo.md).
