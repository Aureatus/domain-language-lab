# Review an action

```sh
npm run inspect:action -- leave/browser.domain leave.request --actor maya
```

This runs the selected action in a **disposable SQLite database**, initialized from the entry's declared data. It does not connect to the live demo. No per-action UI script is required. By default it tries the declared inputs and a bounded set of nearby dates, quantities, booleans and enum values to find an approval example via the actual interpreter. If none is found, it uses the defaults; this says nothing about whether approval is reachable. Use `--args '{"start":"2026-11-23","end":"2026-11-25"}'` to choose the example yourself. Add `--json` for machine-readable step records (`npm run --silent inspect:action -- …` to omit npm's banner).

`--record PATH` saves the full input event sequence, including fixture snapshots and receipts, to a new file. `--replay PATH` projects that sequence without starting a server. The file is checked against the selected contract and action but is not signed: replay does not independently establish a receipt's provenance.

Read each step from the requester's perspective:

1. The runner withholds the execute reply. A **recorded** snapshot can already put an item in the inbox, even while the submit is in flight.
2. A **simulated** transport failure changes the submission to `unknown`. The interaction now allows **check**, not a fresh submit: the requester still has not observed a receipt for this ID.
3. The read-only check observes the original execution receipt. If it was pending, the runner asks an eligible simulated actor to grant each captured requirement, then the requester attempts completion. A grant alone does not imply a successful completion.

The review combines the shared loading projection, record selectors, inbox and submission state. Its controls describe the submission lifecycle; native focus, field validation, animations, and individual renderer widgets are not modeled. Clocks, actual storage responses and generated operation IDs are external observations. This is a sampled walkthrough, not exhaustive schedule exploration. The isolated browser conformance trace separately checks observable behavior with a real intercepted POST.

Run `npm run application:review:test` with the local pinned Exact toolchain and Chromium to exercise the same approval scenario in both web renderers. The browser test observes actual controls; the inspector alone is not renderer conformance evidence.
