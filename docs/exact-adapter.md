# Experimental Exact adapter

`adapters/exact/` generates a bounded Exact renderer from the existing
`derived-application/v1` HTTP contract. There is no second authored time-off app.
The generated `app.contract`, typed `app.ts`, `app.json`, contract envelope,
transport and `adapter-manifest.json` are disposable projections. Edit the
domain/data/view declarations instead.

Pinned SDK and read depth: [research memo](research/exact.md).

## Boundary

- Generic declared actions and visible scalar fields: text, dates, integer text
  entry, boolean and enum/resource selects. Hidden host-bound/computed fields are
  never sent. Integer conversion is input encoding, not local authorization.
- Summary/list views display projected records; date strings retain their ISO
  spelling. Relationship labels come from the actor menu.
- Per-actor/action option-valued draft state survives polling and actor switches;
  live defaults apply until the person edits a field. Drafts do not survive reload.
- Preview and execute call the actual backend. The real durable inbox supplies
  eligible requirements, saved grants, staleness and coverage. Save approval and
  Complete request are separate controls. A failed completion does not erase a
  grant. Transport failure is explicitly an ambiguous outcome, never “nothing
  happened.”
- One in-flight command locks actor/action/approval controls. Polling preserves
  drafts. Retained snapshots are owner-gated and monotone by `snapshotVersion`.
  A contract mismatch refuses reads/writes and requires regeneration.
- Unsupported contract formats/views/visible schemas/widgets fail generation.
  This is not a rich workspace renderer, offline writer, authentication layer or
  mobile-web replacement for a native build.

## Reproduce without root-package edits

```sh
# Shared backend in fresh isolated data; gateway serves compiled web at its origin.
node adapters/exact/serve.mjs leave/model.mjs /tmp/opencode/exact-generated/dist \
  4186 /tmp/opencode/exact-my-fresh-data

# Another terminal: pin Exact and install its declared tools once.
git clone https://github.com/expo/exact /tmp/opencode/exact-source
git -C /tmp/opencode/exact-source checkout d8863f736172954b605c3bff22f51337c6983170
export EXACT_FEEDBACK=0
export BUN=/tmp/opencode/exact-bun/bun-linux-x64/bun # Bun 1.4.2
"$BUN" /tmp/opencode/exact-source/scripts/exact.mjs setup
"$BUN" /tmp/opencode/exact-source/scripts/exact.mjs new \
  /tmp/opencode/exact-generated --name Derived --bundle-id research.derived.exact --with android
node adapters/exact/generate.mjs http://127.0.0.1:4186 /tmp/opencode/exact-generated
cd /tmp/opencode/exact-generated
"$BUN" exact.mjs contract build app.contract --json --errors-only
"$BUN" exact.mjs web-build --out dist
```

Web is served at `http://127.0.0.1:4186`, **not** a separate-origin Exact dev
server. The scoped adapter gateway forwards to an ephemeral shared backend.
Do not weaken global origin checks to make a cross-origin web loop work.

Android build/install only (never upstream `--run`, `agent android`, or
`verify android`, which drive the device outside the permitted device tools):

```sh
export ANDROID_SERIAL=emulator-5554
"$BUN" exact.mjs android
adb -s emulator-5554 reverse tcp:4186 tcp:4186
```

Open `hostId=local`, `deviceId=emulator-5554` with the device tool; use only its
returned bound `agent-device` command for app launches, taps, typing and captures.
Package: `research.derived.exact`. iOS execution requires a usable macOS simulator;
none was available locally for this task. No remote publication or feedback was
authorized or performed.

Mapping tests:

```sh
node --test adapters/exact/test.mjs
node adapters/exact/run-web-test.mjs # requires compiled /tmp/opencode/exact-generated/dist
```

These execute real isolated HTTP/Effect/SQLite preview → pending → grant → resume,
check **5 → 5 → 5 → 2** balance, one-shot rejection, retained saved grants after a
stale completion, mismatch refusal and transport failure. They are not native UI
evidence. Generated snapshots use `artifacts/exact-*`; do not reset user data.

`serve.mjs` also accepts a standalone view entry such as `leave/mobile.domain`
instead of `leave/model.mjs`. Its declared input bindings/defaults/views then
drive the generated client; the adapter does not supply leave-specific metadata.

## Executed evidence

### Background refresh layout check (2026-11-21)

The live browser reproduced a 38px form jump every four seconds: the pending
screen resource inserted and removed a loading row during polling. The generated
renderer now shows that row only while loading an identity without retained
records. Background refresh retains the current layout; refresh failures remain
visible. After rebuilding web, browser observation across repeated polls recorded
no layout-shift entries. The web workflow test also holds a snapshot request in
flight and asserts unchanged form bounds, retained draft and no loading row.
The isolated compiled-web workflow and four mapping tests passed. This update
was not rebuilt or retested on Android. Exact's optional target-cache sweep
reported a noatime filesystem error; web compilation still exited successfully.

Toolchain setup succeeded for web/Android after installing Bun 1.4.2, the pinned
Rust/Hermes dependencies and Android SDK/build-tools.

- **Compiler:** actual pinned `contract build ... --errors-only` returned `[]`
  for both the time-off app and systematically renamed non-leave fixture. The
  fixture includes reference/enum selects, integer entry and boolean controls;
  its initial type error exposed an untyped record projection and was fixed,
  regenerated and recompiled. The normal time-off web build has an explicit
  routeless-header warning; this inline one-screen adapter does not claim native
  navigation-bar integration.
- **Mapping tests:** four tests pass: three isolated real HTTP/Effect/SQLite
  scenarios plus a delayed-snapshot/mismatched-contract transport test. These include
  renamed non-leave pending/grant/resume (**8 → 6** stock) and complete coverage
  of two captured approval requirements before resume.
- **Compiled web runtime:** Playwright drove actual Exact-generated controls at
  390×844: one day **5 → 4**, three-day pending **4**, grant **4**, resume **1**.
  Actor-switched drafts survived. An aborted write showed the ambiguous-outcome
  message; a saved grant followed by a settings change and stale resume remained
  saved, with Leo's balance **5**. No horizontal document overflow/page errors
  were found in that scenario. Screenshots were read/inspected, not merely saved.
  See `artifacts/exact-web-report.json`, `exact-http-report.json`, and
  `exact-web-{pending,completed,stale}.png`.
- **Native Android build:** the actual pinned Rust/Hermes/Gradle APK build
  succeeded and installed `research.derived.exact` on local Pixel_7,
  `emulator-5554` (Android 14; emulator advertises arm64 translation). The cold
  build took 959.6 seconds; rebuilding/reinstalling final generated sources took
  42.9 seconds. Upstream dependency/Gradle deprecations and the inline-header
  warning remain; no errors. APK:
  `/tmp/opencode/exact-generated/target/android/app/outputs/apk/release/app-release.apk`.
- **Native Android execution:** bound `agent-device` operations drove the real
  native date pickers and actor selector: Maya's Friday **5 → 4**, three-day
  request **pending 4**, Sam's saved grant **4**, then separate completion **1**.
  After rebuilding final sources, Leo's independent three-day request again
  stayed **5** while pending and granted, then resumed to **2**. Read-only HTTP
  snapshots confirmed persisted balances, grant records and consumed requests;
  the native inbox and returned actor's records were inspected on-device.
  Draft dates survived the actor switch. No Exact Android test/agent driver,
  direct adb UI input, or alternate web client issued those mutations.
  `artifacts/exact-native-report.json` records both runs;
  `exact-native-build-report.json` records the APK hash and source hashes,
  independently checked equal to the generated `artifacts/exact-app/` files.
  `exact-native-{pending,granted,completed}.png` are the first native checkpoint;
  `exact-native-final-{pending,completed}.png` show the final rebuilt renderer,
  including its improved declared-field labels. All were read/inspected.
- **Remaining execution boundaries:** iOS was not executed. Native stale-resume,
  offline transport and exhaustive accessibility/layout conformance were not
  separately swept; the failure cases above were exercised in web/HTTP tests.

The isolated demonstration backend remains at `http://127.0.0.1:4186`, with
`/tmp/opencode/exact-native-20261114-b` data (Maya **1**, Leo **2**, both pending
requests consumed). This is not user data and was not reset. The final installed
native app is left open. Stop/relaunch the adapter host with that same directory
to preserve the demonstration; choose a new directory for a fresh scenario.
