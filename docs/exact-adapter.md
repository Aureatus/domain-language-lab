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

## Chromium/Exact conformance

This is separate from the [bounded checker and offline replay](check-interactions.md).
Use the same Node version and run `pnpm install --frozen-lockfile` in this repository.
Install [Bun 1.4.2](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2),
[rustup](https://rustup.rs/) and a Linux C toolchain (e.g. `build-essential` on
Ubuntu). On Linux x86-64, use glibc 2.36 or newer (e.g. Ubuntu 24.04);
the pinned Hermes compiler does not start on Ubuntu 22.04's glibc 2.35.
Exact's setup uses its locked dependencies, including Rust 1.97.0, web Rust
nightly-2026-08-21, wasm-bindgen 0.2.127, Binaryen 132, the Hermes
`hermes-vanilla-d412d3bd8512-v6` host bundle and Playwright Core 1.64.1 with
its matching Chromium.
Keep the Exact checkout and template outside this repository.

```sh
tools_dir=$(mktemp -d "$HOME/maya-exact.XXXXXX")
export EXACT_ROOT="$tools_dir/exact"
export EXACT_TEMPLATE="$tools_dir/template"
export BUN="$(command -v bun)" # Or the absolute path to the Bun 1.4.2 binary.
export EXACT_FEEDBACK=0
"$BUN" --version
git clone https://github.com/expo/exact "$EXACT_ROOT"
git -C "$EXACT_ROOT" checkout --detach d8863f736172954b605c3bff22f51337c6983170
"$BUN" "$EXACT_ROOT/scripts/exact.mjs" setup
"$BUN" "$EXACT_ROOT/scripts/exact.mjs" setup --check --platform web
node "$EXACT_ROOT/node_modules/playwright-core/cli.js" install chromium
"$BUN" "$EXACT_ROOT/scripts/exact.mjs" new "$EXACT_TEMPLATE" \
  --name Derived --bundle-id research.derived.exact

pnpm run application:review:test
# Or replay the lost-then-snapshot prefix using the trace from check-interactions.md:
# pnpm run application:review:test "$trace"
```

If Chromium reports missing Linux libraries, install them using the same
Playwright CLI's `install-deps chromium` command (requires system package
access). The conformance runner loads Playwright from `EXACT_ROOT`, copies
only the template launcher and package manifest, and builds in a fresh OS
temporary directory. It does not need a prebuilt app or any Android or iOS build.

On an older Linux host, you can run this setup in an Ubuntu 24.04 container
(e.g. `docker run --rm -it --shm-size=1g ubuntu:24.04 bash`). Inside a fresh
container, install `build-essential ca-certificates curl git pkg-config xz-utils`
with apt, then install Node, Bun, and rustup and use a fresh clone. Replace
`install chromium` above with `install --with-deps chromium` to install
Chromium and its system libraries together.

## Standalone gateway and optional native demo

Reuse the pinned Exact checkout and Bun above. Set the same `tools_dir` in
both terminals. Run the gateway from the repository root with a fresh data
directory outside this repository.

```sh
# Shared backend in fresh isolated data; gateway serves compiled web at its origin.
node adapters/exact/serve.ts leave/model.ts "$tools_dir/android-demo/dist" \
  4186 "$tools_dir/android-data"

# In another terminal, from the repository root:
export EXACT="$EXACT_ROOT" # The generated launcher's checkout override.
"$BUN" "$EXACT_ROOT/scripts/exact.mjs" new "$tools_dir/android-demo" \
  --name Derived --bundle-id research.derived.exact --with android
node adapters/exact/generate.ts http://127.0.0.1:4186 "$tools_dir/android-demo"
cd "$tools_dir/android-demo"
"$BUN" exact.mjs contract build app.contract --json --errors-only
"$BUN" exact.mjs web-build --out dist
```

Web is served at `http://127.0.0.1:4186`, **not** a separate-origin Exact dev
server. The scoped adapter gateway forwards to an ephemeral shared backend.
Do not weaken global origin checks to make a cross-origin web loop work.

The gateway closes every API connection after responding. The pinned Exact
Android transport can automatically resend a POST if a reused connection
drops before any response arrives. Closing all API connections (including
snapshot reads) keeps execute on a fresh connection, where Exact reports a
disconnect instead. After a lost reply, use **Check submission** before
retrying. This applies to the loopback gateway, not to other hosts given to
the generator.

### Android

Install a JDK (17 or newer) and the Android SDK command-line tools. Set
`ANDROID_HOME` to your SDK and, if necessary, `JAVA_HOME` to your JDK.
The APK is arm64-only: use an arm64 device or an emulator image that lists
`arm64-v8a` in `adb shell getprop ro.product.cpu.abilist`.

```sh
sdkmanager "platform-tools" "platforms;android-37.2" "build-tools;37.0.0" "ndk;27.1.12297006"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006"
"$BUN" "$EXACT_ROOT/scripts/exact.mjs" setup
"$BUN" "$EXACT_ROOT/scripts/exact.mjs" setup --check --platform android
```

Exact setup needs to see the Android SDK to install the pinned Rust Android
target and Hermes bundle. From `"$tools_dir/android-demo"`, build and install
without using upstream `--run`, `agent android` or `verify android`:

```sh
export ANDROID_SERIAL=emulator-5554 # Set this to the serial from adb devices.
"$BUN" exact.mjs android
adb -s "$ANDROID_SERIAL" reverse tcp:4186 tcp:4186
```

If building in a container separate from the emulator, use
`"$BUN" exact.mjs android --no-install --json` and install its reported APK
with `adb -s "$ANDROID_SERIAL" install "$apk"` on the emulator host.

Open `hostId=local`, `deviceId=emulator-5554` with the device tool; use only its
returned bound `agent-device` command for app launches, taps, typing and captures.
Package: `research.derived.exact`. No remote publication or feedback was
authorized or performed.

### iOS Simulator

The pinned Exact Swift host needs **Xcode 27.1 or later** with the iOS Simulator
27.1+ SDK. A bootable simulator alone does not meet the build requirement. Set
`DEVELOPER_DIR` if the supported Xcode is not selected. Use the pinned checkout
and Bun above. Start the loopback gateway as shown above, replacing the
Android paths with `"$tools_dir/ios-demo/dist"` and `"$tools_dir/ios-data"`.

```sh
export EXACT="$EXACT_ROOT"
"$BUN" "$EXACT_ROOT/scripts/exact.mjs" setup --check --platform ios
"$BUN" "$EXACT_ROOT/scripts/exact.mjs" new "$tools_dir/ios-demo" \
  --name Derived --bundle-id research.derived.exact --with ios
node adapters/exact/generate.ts http://127.0.0.1:4186 "$tools_dir/ios-demo"
cd "$tools_dir/ios-demo"
"$BUN" exact.mjs ios --no-install
# With a usable iOS Simulator, build and launch:
# "$BUN" exact.mjs ios --run
```

Exact supports `"$BUN" exact.mjs verify ios --json`, but its scaffold tests
do not exercise this app.
The adapter's approval and lost-then-snapshot renderer replay tests are Chromium
tests; a build or scaffold verification is not evidence that either scenario
passed on iOS.

Mapping tests:

```sh
node --test adapters/exact/test.ts
node adapters/exact/run-web-test.ts # requires compiled /tmp/opencode/exact-generated/dist
```

These execute real isolated HTTP/Effect/SQLite preview → pending → grant → resume,
check **5 → 5 → 5 → 2** balance, one-shot rejection, retained saved grants after a
stale completion, mismatch refusal and transport failure. They are not native UI
evidence. Generated snapshots use `artifacts/exact-*`; do not reset user data.

`serve.ts` also accepts a standalone view entry such as `leave/mobile.domain`
instead of `leave/model.ts`. Its declared input bindings/defaults/views then
drive the generated client; the adapter does not supply leave-specific metadata.

## Executed evidence

### Portability follow-up (2026-11-24)

- **Android:** The pinned Exact build produced an arm64 APK on Ubuntu 24.04.
  Maven Central returned HTTP 429 on the first attempt; retrying with its Google
  mirror for Maven Central dependencies succeeded without changing dependency
  versions. The APK installed as `research.derived.exact` on an Android 14
  emulator, and ADB reverse was configured for the isolated gateway. The bound
  device tool was unavailable, so native interaction and visual checks were not rerun.
- **iOS:** On macOS, Exact refused to compile or run simulator verification
  with Xcode 27.0 RC and Simulator SDK 27.0. An installed simulator did not
  satisfy the SDK 27.1 requirement.

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
