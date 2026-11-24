# Check interactions

```sh
npm run check:interactions -- leave/browser.domain leave.request --actor maya
```

No additional application declarations. Like `inspect:action`, the command selects example inputs, or takes `--args JSON`. It executes one isolated backend walkthrough to obtain **real snapshots and receipts**, then checks different orders in which a viewer could observe them. It does not re-execute the domain for each order.

The checker includes the original recorded schedule (both snapshot deliveries). For a successful capture with an alternate actor it also explores:

- All four placements of one observed snapshot around `lost → check → receipt`.
- All six interleavings of `refresh-start → refresh-end` with `check → receipt`, after transport loss.
- One late receipt for the originating form while another viewer is selected; a peer draft is populated when the action is available to them. Switching back must restore the original draft and receipt.

These are small model schedules, not claims that each renderer exposes an actor switch while its controls are busy. The oracle checks the observable state after each event without using the submission transition table as its expected answer. It checks draft retention, submission/check controls, identity isolation, retained records during refresh, and that an approval grant is not a completion. Grant checks require an actual approval branch. The report states whether it ran; a commit without approval does not exercise that rule. Unavailable or invalid inputs with no receipt report `not-exercised` (exit 2).

## Reproduce the negative control

```sh
npm run check:interactions -- leave/browser.domain leave.request --actor maya \
  --mutant snapshot-unlocks --out /tmp/opencode/snapshot-fault.json
# Expected exit 1. The output file must not already exist.
npm run inspect:action -- leave/browser.domain leave.request \
  --replay /tmp/opencode/snapshot-fault.json
npm run application:review:test -- /tmp/opencode/snapshot-fault.json
```

The explicit mutant changes the test projection, not either shipped renderer. Failure replay checks the model contract and checker/projection source fingerprints and reruns the oracle, reporting whether the same rule fails at the same step. The Chromium test runs the supported lost-then-snapshot prefix against the two **unmodified** web renderers and expects safe controls. `npm test` includes the model check, mutation detection, and offline replay on a non-leave fixture. The separate browser command needs Chromium and the pinned Exact build tools.

“Shortest” means the shortest observed failing prefix across the enumerated schedules, including the initial snapshot and draft setup. A pass is bounded by the selected command, input, real backend capture, modeled event families, oracle and controls. Concurrent refresh requests, browser geometry, native hosts, and arbitrary transport failures are outside this check.
