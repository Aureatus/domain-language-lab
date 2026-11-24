# Check interactions

From a clean Linux clone, use Node.js 22.18 or newer (CI uses Node.js
24.22.3 with npm 11.19.1). No browser, Exact, Lean, or native build is needed
for the bounded checker and offline replay.

```sh
npm run adapters:install
npm run check:interactions -- leave/browser.domain leave.request --actor maya
```

The install uses the Effect adapter's lockfile (Effect 4.1.4). Expect
`"status": "bounded-pass"` for the Maya example.

No additional application declarations. Like `inspect:action`, the command selects example inputs, or takes `--args JSON`. It executes one isolated backend walkthrough to obtain **real snapshots and receipts**, then checks different orders in which a viewer could observe them. It does not re-execute the domain for each order.

The checker includes the original recorded schedule (both snapshot deliveries). For a successful capture with an alternate actor it also explores:

- All four placements of one observed snapshot around `lost → check → receipt`.
- All six interleavings of `refresh-start → refresh-end` with `check → receipt`, after transport loss.
- One late receipt for the originating form while another viewer is selected; a peer draft is populated when the action is available to them. Switching back must restore the original draft and receipt.

These are small model schedules, not claims that each renderer exposes an actor switch while its controls are busy. The oracle checks the observable state after each event without using the submission transition table as its expected answer. It checks draft retention, submission/check controls, identity isolation, retained records during refresh, and that an approval grant is not a completion. Grant checks require an actual approval branch. The report states whether it ran; a commit without approval does not exercise that rule. Unavailable or invalid inputs with no receipt report `not-exercised` (exit 2).

## Reproduce the negative control

```sh
scratch=$(mktemp -d)
trace="$scratch/snapshot-fault.json"
npm run check:interactions -- leave/browser.domain leave.request --actor maya \
  --mutant snapshot-unlocks --out "$trace"
# Expected exit 1 with rule submission.no-fresh-submit-before-receipt.
npm run inspect:action -- leave/browser.domain leave.request \
  --replay "$trace"
```

The mutant enables Submit after `snapshot → draft → submit → lost → snapshot`,
before a matching receipt arrives. The inspector should print
`Failure replay: reproduced (submission.no-fresh-submit-before-receipt)`.
The output file must not already exist. Keep it for the optional browser
replay below, or remove it with `rm -r "$scratch"` when finished.

CI runs the normal checker, verifies the mutant's exit, rule, event sequence
and enabled Submit control, then replays its trace. It also runs these targeted tests:

```sh
node --test application/interaction-check.test.mjs application/action-review.test.mjs application/submission.test.mjs
```

## Optional renderer conformance

After [setting up Chromium and Exact](exact-adapter.md#chromiumexact-conformance),
run the same prefix against the two unmodified web renderers:

```sh
npm run application:review:test -- "$trace"
```

The explicit mutant changes the test projection, not either shipped renderer.
Offline replay checks the model contract and checker/projection source fingerprints
and reruns the oracle. The Chromium test expects both renderers to keep Submit
disabled and Check enabled without a receipt.

“Shortest” means the shortest observed failing prefix across the enumerated schedules, including the initial snapshot and draft setup. A pass is bounded by the selected command, input, real backend capture, modeled event families, oracle and controls. Concurrent refresh requests, browser geometry, native hosts, and arbitrary transport failures are outside this check.
