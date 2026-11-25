# Generated durable v2 histories

Run bounded histories against actual Node SQLite (requires the installed Effect adapter):

```sh
node inventory/v2/generated.ts --seed 0x51a7 --runs 6 --steps 30 --report /tmp/opencode/durable-generated-report.json
node --test inventory/v2/generated.test.ts
node inventory/v2/generated.ts --replay /tmp/opencode/durable-generated-report.json --report /tmp/opencode/durable-replayed.json
```

The positional report-path form remains supported. Defaults are seed `0x51a7`,
six runs and 30 commands per run; seeds are uint32 values (including zero).
Subsequent run seeds add `0x9e3779b9` modulo 2³². Steps must be at least 30;
additional steps generate mixed reserve/cancel/expire/delete commands with varied
targets, actors, capacity requests and expiry boundaries.

## Generation and independent expectations

Each seed shuffles four scenario blocks and selects owners, unique IDs, quantities
and explicit clock offsets. Blocks restore available capacity but retain durable
pending requests. Every default run guarantees:

- Successful reserve, approved resume, owner cancellation, warehouse expiry and
  terminal deletion, not merely attempts that may reject.
- Unauthorized grant, unauthorized cancellation, early expiry, active deletion and
  terminal recancellation rejection.
- Granted but stale resume after an intervening real commit, and granted resume
  at the expiry boundary with otherwise unchanged state.
- Exact-command duplicate retries, changed-command ID-conflict rejection and
  one-shot request consumption rejection.

The checker predicts outcomes from an inventory-specific state machine, **before
checking observed outcomes**. It does not call the interpreter for predictions or
read action declarations to decide policy/precondition results. It independently
tracks capacity 8, active/terminal reservations, ownership, expiry, quantities,
versions/revisions, request prestates, grant eligibility, consumption and immutable
operation identities/historical outcomes. Missing an expected success fails even
when the actual adapter returns a plausible rejection and unchanged state.

Each step checks expected status/cause, returned and persisted domain state,
pending/grant/consumption projections, and event publication against predicted
record differences. Noncommits must preserve state and events. Event checks cover
action/change/create/delete contents, actor, invocation, clock and revision;
routing details and semantic event IDs receive exact replay comparison, not an
independent routing oracle. Request model binding is compared to the fixture model,
but its declarations are not interpreted by the oracle.

Each operation and snapshot reopens its SQLite handle. A second, fresh database
replays all commands and compares **every step's complete JSON outcomes, state, pending
projections and ordered event values**, excluding only paths and SQLite sequence
numbers (undefined optional JavaScript properties are omitted by JSON). `--replay`
also compares against saved observations when present. Pull
retry/acknowledgement checks run separately after the domain replay. Exclusive
temporary databases live under `/tmp/opencode/v2-generated-*`; no user database
is reset or removed.

## Replay and counterexamples

Report format is `inventory-v2-generated-report/2`. `cases[].commands` contains
complete durable API calls, not event labels: invocation IDs, action arguments,
actors, clocks, approval operation IDs, referenced pending invocation IDs, policy
IDs and trusted-host approver identities. Grants have no clock argument in the API;
resume commands explicitly include their fresh clock. `cases[].observations` stores
actual outcomes and snapshots. The report includes an executable replay command.

`runGenerated({seed, runs, steps, reportPath})` returns the report. It also accepts
`histories: [{seed, commands}]` (and optional saved `observations`) for exact replay.
`generatedHistory`, `checkHistory` and `mutationChecks` are exported for tests.

An execution/check failure gives report and case status `counterexample`, with
seed, failing index/command, actual cause and complete `failingPrefix`. Checker
failures additionally include predicted and observed outcomes. CLI writes the
report and exits 1 rather than losing the counterexample in a thrown assertion.
Configuration/input-file errors may still throw before a run starts. The prefix is
the first failing checked prefix, **not a minimal example or automatic shrink**.
Initialization failures have an empty prefix; post-history outbox/check failures
retain the complete history and identify their phase.

To replay only a failing prefix, save this shape as JSON and use `--replay`:

```json
{"seed": 20903, "failingPrefix": [{"api":"resume","command":{"id":"example","invocationId":"missing-request","clock":100}}]}
```

Use the actual report's prefix rather than the illustrative command above. To
regenerate a single generated case, use its decimal seed with `--seed SEED --runs 1`
and the original `--steps`. Commands remain authoritative for replay across
generator changes.

## Mutation sensitivity and evidence boundary

Executed sensitivity checks alter cloned **full history observations** and feed
them through the same `checkHistory` used for real execution: a stale resume
wrongly returned as committed, an extra decrement in returned/persisted state,
and a missing expected commit returned as rejected. Each must fail at the altered
step and records its actual diagnostic under `oracle.mutationChecks`. These are
observation mutations, not modified core/adapter implementations, and do not
claim sensitivity to every possible bug.

Read depth: full local README, generated-history/inventory/durable memos and model;
selected v2 interpreter and durable adapter source; independent execution of the
tests and report CLI. This is sampled bounded execution, not exhaustive search,
a proof, semantic/runtime correspondence, real authentication, process-crash or
power-loss certification, or external delivery evidence. The oracle is limited
to this inventory fixture and its generated API input vocabulary. Trusted inputs
include simulated host identities/clocks, Node/Effect, SQLite and filesystem
behavior; see [`durable-execution.md`](durable-execution.md).
