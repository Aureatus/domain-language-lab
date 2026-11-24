# Exact adapter research

Primary source: <https://github.com/expo/exact>, pinned to
[`d8863f736172954b605c3bff22f51337c6983170`](https://github.com/expo/exact/tree/d8863f736172954b605c3bff22f51337c6983170).
This is a daily-changing pre-1.0 SDK, not a stable public compatibility promise.

## Read depth

- Local README and model-derived application memo; source inspection of
  `application/derive.mjs`, `server.mjs`, `browser.mjs`, and the source loader.
- Full Exact README and `docs/start-here.md`,
  `docs/card.md`, REST starter Contract and TS,
  `recipes/rest-backend.md`, `after-a-write.md`, and `phone-manifest.md`.
- Selected implementation: `scripts/exact.mjs` compiler invocation/type checking,
  Android target selection in `scripts/agent-android.mjs`, SDK setup/toolchain pins.
- No upstream suite copied or run as our conformance evidence. No proof audit.
- Independent execution: real Contract/TS compiler checks, compiled web UI and
  installed Android native UI against the shared HTTP/Effect/SQLite host. Native
  input/captures used only the required bound device CLI, not upstream's driver.

## Findings (upstream facts, scoped to the pin)

Exact is **not React Native**. Contract describes a UI plan. Its web backend uses
DOM/CSS; native hosts execute the plan through Rust/layout/platform presenters.
TypeScript is a data seam, using browser JS on web and Hermes on native. See
README architecture, lines 53–65 and 177–211. Android is an early native target;
the selected Android build uses `aarch64-linux-android`. This is not evidence that
our generated application has executed natively.

`Sources`/`Answer` are generated from declared Contract source signatures. Resource
failures retain a prior answer; `failure(resource)` exposes failure. A mutation
that throws does not run `then`; a shaped refusal can retain drafts and show a
message. Network grants are declared separately. These facts motivate the typed
HTTP seam, owner-gated retained reads and explicit failure UI.

The SDK pins Bun **1.4.2**, stable Rust **1.97.0** and a separate nightly for its
optional web/Wasm tooling. `contract build app.contract --json --errors-only`
runs the actual compiler, refreshes `.d.ts`, and type-checks the TS seam (selected
`scripts/exact.mjs:654–711`). Checking generated text with our own regex is not a
substitute. Android SDK **37.2**, build-tools **37.0.0**, NDK, Android Rust target
and pinned Hermes are additional prerequisites. The README performance claims
were not independently benchmarked here.

## Adapter decision (our proposal/implementation)

The author's domain and view modules remain the source. Generate Contract and
typed TS source bindings from `derived-application/v1`; send visible action args
to the same HTTP interpreter host. Do not translate policy AST, date deductions,
approval rules or updates into Exact code. Render server-projected resource
views, availability, defaults, captured pending requirements and persisted grants.
Grant and resume are separate HTTP transactions.

The adapter's loopback gateway is an additional trusted host, not a change to the
shared server's Host/Origin checks. It checks its own Host/Origin/site, relays
bounded JSON to the isolated backend and serves the compiled web files at the
same origin. Native uses the same loopback origin through `adb reverse`.

## Open boundaries

Local actors are simulation, not authentication. Full state remains visible to
the local host; view ownership is presentation, not authorization. Polling is
eventual refresh, not push or exactly-once execution. Drafts are memory-only.
Unknown outcomes must be inspected before retrying. Exact's compiler/runtime,
generated mapping, transport and the shared semantic/Effect/SQLite stack are
trusted; no renderer correspondence theorem is claimed. Contract source maps
point to stable contract IDs/JSON pointers; they do not invent authored source
spans absent from the HTTP contract. Runtime/build results belong in
[`../exact-adapter.md`](../exact-adapter.md), not in upstream factual claims.
