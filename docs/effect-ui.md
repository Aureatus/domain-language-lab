# Effect UI renderer spike

This is a second web renderer for one action, not a replacement for the browser,
CLI or Exact adapters. It uses the preview [Effect UI](https://ui.effect.website/article.md)
snapshot at commit `0ba6f41c78d3d339bee404ab466daac8540f29ef`, with the same Effect
version as the backend. No new Effect UI dependencies are needed for the other adapters.

With Node 22.18 or newer, from the repository root:

```sh
npm run adapters:install
npm ci --prefix adapters/effect-ui
npm start --prefix adapters/effect-ui
```

Open the printed loopback URL. The server uses a fresh SQLite database and
simulates the Maya actor. Three weekdays (November 23–25, 2026) request approval
without changing her balance. The spike displays that receipt; approval controls
are out of scope. The scoped server accepts only local same-origin requests.

The adapter reads the action's label, visible string fields, widgets and defaults
from `derived-application/v1`. It supports date and text widgets and refuses other
inputs rather than guessing a mapping. An Effect UI message maps a form event to
the shared submission reducer; Commands use the shared HTTP client. The server
still evaluates policies and owns the receipt. A refreshed snapshot does not
resolve a submission. The tab remembers the original request identity across a
reload, and a missing receipt permits a retry only with that same identity.

To reproduce the two fault cases in Chromium against the real backend:

```sh
npm exec --prefix adapters/effect-ui -- playwright install chromium
npm test --prefix adapters/effect-ui
```

Playwright either lets the POST reach SQLite and drops the reply, or stops the
POST before delivery. The test checks the first outcome remains recoverable after
a refreshed snapshot and reload, and the second resends the exact same request.
This is not a claim about recovery across tabs, browsers or lost local storage.
