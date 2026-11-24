# Stockroom: second application on shared semantics

Status: implemented experimental offline application, 2026-11-11. This consumer
imports `semantic/core.mjs` unchanged and uses the exact `semantic-core/v1` IR in
`semantic/CONTRACT.md`. The existing issue application, package configuration,
semantic directory and adapters were not modified by this consumer. Root scripts
and adapter integration were added afterward. Generated outputs are under
`artifacts/inventory*`.

## Open and reproduce

From the repository root:

```sh
node --test inventory/inventory.test.mjs
node inventory/build.mjs
node inventory/browser-test.mjs
node inventory/video.mjs
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height -of json artifacts/inventory-demo.mp4
```

Open `artifacts/inventory.html` directly as a file. No server, installation,
network, remote font, framework or backend is needed. Browser tests and recording
use the existing Chromium tooling imported from
`/tmp/opencode/workbench-tooling/node_modules/playwright/index.mjs`. Recording also
requires `ffmpeg` on PATH. These scripts do not install dependencies.

1. **Run broken host** executes two preparations and two stale-snapshot commits.
   Read the actual oracle failure, inspect each step and its facts.
2. **Replay & verify** executes the recorded operations with a new interpreter and
   checks exact observations, events, oracle outcomes and final records. A failed
   invariant is reproduced, not turned into success.
3. **Run correct host + retry** executes latest-state commits. The losing token
   rejects stale; retrying three rejects capacity; retrying two succeeds.
4. Export JSON, reset, then import it. Imported evidence is re-executed, not just
   displayed. Exported preparations are descriptions; opaque tokens are rebuilt.
5. For expiration: reset; reserve slotA as alice at clock 10, expiry 30. Choose
   Expire as warehouse at 29 (rejected), then 30 (committed). Cancellation instead
   requires alice. Clock units are abstract integer ticks.

Schedule buttons start a fresh workspace. Selecting a historical step reconstructs
the exact snapshot, oracle and observed events at that step and disables command
controls. Return to latest to act. No local-storage persistence is implemented;
export before closing. Reset does not promise to reset every form preference.

## Declarations and API

`inventory/model.mjs` exports:

- `inventoryModel`: complete data-only IR with stable declaration IDs.
- `initialState`: validated frozen seed, five field cameras and three slots.
- `runtime`: shared interpreter instance for direct execution/testing.
- `invocation(id, kind, slotId, actor, clock, quantity, expiresAt)`: input helper;
  only reserve has quantity and expiry arguments. There are no domain writes here.

Resources:

- `stock.camera`: `capacity`, `available`, `watchers`, `operator`.
- `reservation.slotA/slotB/slotC`: `stockId`, `owner`, `quantity`, `expiresAt`,
  `status`. Owners are alice, bob, alice respectively.

**Existing reservations are an explicit profile limit.** Core v1 has no insert or
delete. Reserve activates a preallocated free record; it does not create one.
Cancelled/expired records are terminal, not automatically recycled. No owner
change, capacity adjustment, new product, fulfillment or stock replenishment is
implemented. Expiration does not happen merely because time passes; an explicit
operator invocation is required.

Every action binds the supplied stock and reservation keys. A declaration checks
that the slot's `stockId` matches the bound stock input (binding keys cannot read
other bindings in v1). Policies and preconditions are separate:

| Action | Policy | Preconditions | Grouped assignments |
| --- | --- | --- | --- |
| reserve | actor = slot owner | stock match; free; positive schema quantity ≤ available; clock < expiry | subtract available; set active, quantity, expiry |
| cancel | actor = slot owner | stock match; active | return stored quantity; set cancelled |
| expire | actor = stock operator | stock match; active; expiry ≤ clock | return stored quantity; set expired |

Cancel is allowed even after the expiry tick if expiration has not run. All RHS
expressions read the same prestate. The core validates the full group, increments
stock and reservation versions once each and emits one action plus changed-field
facts. There is no handwritten action-name mutation switch. Expression-construction
helpers only construct declarations; the shared interpreter executes them.

Observed relationships are `stock.watchers` and `reservation.owner`. The core
reads poststate, excludes actor, sorts/deduplicates recipients, retaining distinct
support paths. Alice receives two paths when warehouse expires slotA. These are
recipient snapshots, not delivered notifications. Same-group facts are sibling
assignments, not an invented causal sequence.

`inventory/host.mjs` exports:

```js
const h = createHost();
h.step({type: 'prepare', token: 'A', invocation: command});
h.step({type: 'commit', token: 'A', mutant: false});
// Or: h.step({type: 'execute', invocation: command});
h.state; h.steps; h.events; h.oracle;
const bundle = h.export();
const reconstructed = replay(JSON.parse(JSON.stringify(bundle)));
competition(false, ['B', 'A']); // reverse commit order, also tested
```

The host snapshots the model and initial state. It rejects duplicate invocation IDs
within its workspace, including IDs of rejected/prepared commands; retries use new
IDs. It does not implement a global/durable deduplication ledger. Unknown host
operations/tokens throw rather than silently succeed. A step records exact operation,
status/code/reason, visible revision, oracle result and only actual committed facts.
`inventory-replay/v1` includes host version, full declarations, initial state,
schedule, observations and final state. Replay checks those observations rather
than trusting their claims. Imported files are data, never executable modules.
Bundles are not signed or a tamper-proof audit: a coherent replacement model and
schedule can of course produce a different valid replay. UI import is intended
for this application's exports, not arbitrary non-inventory resource layouts.

## Actual failure, independent oracle

Both clients request three from five. Both prepare against revision zero. With
the correct host, A commits against latest state, then B's token is stale. B's
fresh three-unit command fails capacity; its fresh two-unit command succeeds.
The reverse order is tested as well. This is synchronous simulated interleaving,
not actual parallel threads or distributed transactions.

The deliberate mutant changes only the host mapping: it passes the preparation's
old snapshot into `commit`, then publishes the resulting whole state over the
current state. Both commits genuinely succeed against their supplied snapshots.
The second overwrites the first slot, leaving revision 1, available 2 and one
active reservation for 3. A snapshot-only `available + active = capacity` check
would falsely reassure the user. The retained accepted-command ledger instead
contains **two promises totaling 6 from capacity 5**. This is a real lost accepted
reservation and overselling of promises, not an interpreter isolation failure.

`inventory/oracle.mjs` does not import/evaluate the IR or use change patches to
calculate expected stock. It independently accounts for quantities in accepted
reserve commands and removes them on accepted cancel/expire. BigInt summation
avoids oracle arithmetic overflow. It checks:

- snapshot available + active quantities = capacity;
- accepted outstanding quantities ≤ capacity;
- available + accepted outstanding quantities = capacity;
- every slot's active status, stock and quantity agree with the accepted ledger.

Its scope is the seeded inventory profile: no initially active reservations,
constant capacity, and only reserve/cancel/expire. The action-name switch belongs
to this **independent test oracle**, not application mutation. It is not a second
interpreter or proof of all model declarations. Tests separately check authorization,
expiry boundaries, routing and rejection atomicity.

## Build and evidence

`inventory/build.mjs` bundles the actual shared core source plus model, host,
oracle and UI into an inline offline module; it does not substitute precomputed
outcomes. `artifacts/inventory-build.json` records SHA-256 source hashes. Rebuild
after any source changes; model IDs alone are not content hashes. The builder is
intentionally narrow for these known module sources, not a general JS bundler.

Executed verification:

- `node --test inventory/inventory.test.mjs`: 11 passing tests covering all three
  actions, ownership policies, inclusive expiration boundary, stock pairing,
  quantities, clock, insufficient stock, missing records, overflow/routing group
  rejection, both competing schedules, both actual mutant failures, deterministic
  JSON replay, tampered observation rejection, independent accounting, declaration
  edits, initial snapshot isolation and duplicate IDs.
- `node inventory/build.mjs`: generated offline HTML from shared source.
- `node inventory/browser-test.mjs`: Chromium file:// tests of actual UI reserve,
  cancel, expire, policy denial, expiration boundary, mutant failure, correct
  rejection/retry, history, JSON download/import, replay and 390px mobile overflow.
  No page errors or non-file network requests. Machine result in
  `artifacts/inventory-browser-test.json`.
- Inspected desktop failure/correct and mobile full-page PNGs. Desktop signature
  is a five-bin allocation shelf; held bins use diagonal hatch as well as color.
  Offline Georgia display, Trebuchet body and monospace evidence; blue warehouse
  labeling, pale steel backgrounds, amber allocations and raspberry failures.
- `node inventory/video.mjs`: one continuous, paced browser recording; actual
  mouse movement is exposed with a DOM cursor. No spliced screenshots or invented
  trace. ffmpeg transcodes the original WebM to H.264 MP4, 1440×1100; metadata in
  `artifacts/inventory-video.json`. `ffprobe` checked the output. Duration is about
  one minute; small timing variation is expected between runs.

Evidence files include `inventory-initial.png`, `inventory-mutant.png`,
`inventory-correct.png`, `inventory-mobile.png`, `inventory-mutant-replay.json`
and `inventory-demo.mp4` under `artifacts/`.

Read depth: README and design brief read in full; exact shared contract and core
source inspected; inventory mapping independently executed in Node and Chromium.
No independent specialist review was requested because this implementation task
explicitly prohibits delegates. Self-review found and corrected stale replay-status
text, historical oracle selection and caller-owned initial/model snapshot exposure.

## Assumptions and uncovered boundaries

This is bounded experimental evidence, not a production guarantee or proof.
Trust the unchanged shared interpreter, JS intrinsics, validated seed, host
single-thread synchronous publication and oracle implementation. No database,
cross-tab coordination, crash recovery, durable outbox, authentication, clock
authority, monotonic-clock enforcement, transport delivery, approval workflow,
automatic timer or theorem correspondence is supplied. Arbitrary caller mutation
of exposed host history arrays is outside the API's usage contract. A real storage
host must atomically read current, commit, replace and persist state/facts, then
deliver; it must scope IDs across workspaces and enforce authentication and clock
contracts. These obligations are not provided by an opaque preparation token.

The UI is handwritten presentation over shared declarations, not a generally
derived renderer. The independent ledger and explanation phrasing deliberately
know the inventory profile. Routing is one-hop observation, not bidirectional
propagation. No application or upstream tests have been copied; these are tests
of this consumer's declarations and host mapping.
