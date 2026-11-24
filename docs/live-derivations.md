# Live declaration impact and generated checks

`live/derive.mjs` is a synchronous, dependency-free browser module. It imports
`createApp` and the identity-branded `forkApp` helper from `live/core.mjs`. The API follows
[`live/DERIVATION-CONTRACT.md`](../live/DERIVATION-CONTRACT.md).

## API

```js
describeChange(app.model, 'comment', {allowedRoles: ['member'], notify: ['assignee']});
const report = runDerivedChecks(app.exportWorkspace());
```

`describeChange(model, action, patch)` validates the same role/path patch subset
as `setRule`, without applying it or incrementing revision. Invalid patches return
`{ok:false,reason}`. Valid patches return `{ok:true,action,revision,roleChanges,
routes:{added,removed},unchanged,scope}`. Revision identifies the input model;
role changes contain `{role,before,after}` membership booleans. Empty change lists
are explicit. `unchanged` compares exact declaration arrays, so reordering paths
is a change even when no paths are added/removed: order affects evidence ordering.
This is declaration impact, not a complete reachable-behavior prediction or a
retroactive change to historical inbox records.

`runDerivedChecks(workspace)` accepts an exported workspace document, or a runtime
whose `exportWorkspace()` supplies that document. It returns
`{result,revision,cases,scope}`. Every case has
`{id,action,actorId,expected,actual,status,reason?}`; result/status are
`passed`, `failed` or `unknown`. Reconstruction errors use null revision/action/
actor and an explicit unknown case. IDs include action, actor, entry point and
variant; positive-coverage cases use a null actor.

## Generated coverage

- Enumerate **current** action declarations and available users. Expected role
  outcomes come from current `allowedRoles`, not historical event declarations.
- Reconstruct and validate the document once, then exercise both `invokeTool` and
  `dispatch` on isolated cheap forks of runtime-owned immutable snapshots.
  Each entry point prepares its own setup baseline; trials fork that baseline,
  never an already successful trial. Each uses an explicit fixed clock; live
  methods other than export are never called. No raw state import is accepted.
- Build arguments from current input properties/enums and known issue/user IDs.
  Assignment chooses a different assignee. Resolve selects an open issue; reopen
  selects a resolved issue. If needed, setup uses a currently authorized actor to
  resolve/reopen/create, without editing any tested rule. Failed setup is unknown
  and includes the dispatch error; unavailable permission is not a passed witness.
  Invalid-input cases can still run when positive setup is unavailable, since
  schema rejection precedes these domain preconditions.
- Authorized actors also exercise missing required fields, wrong object/field
  types, extra keys, blank minimum-length strings, excessive lengths, invalid
  enums and unknown references where applicable. Denied actors test denial
  separately: invalid input rejection is not attributed to validation when policy
  would reject first.
- Rejected cases compare state/model identities (their contents are deeply frozen)
  and exact serialized journal contents. They do not repeatedly serialize the large
  immutable materialized state. Successful witnesses compare independently derived
  recipients, supporting paths, actor exclusion, recipient deduplication and exact
  newly appended notifications. Expected relationship inputs come from the
  pre-action issue plus this finite domain's create/assign/watch transformations,
  not the event's claimed relationship snapshot or recipients.

The aggregate is failed if any observed result contradicts its expectation,
otherwise unknown if any case is unknown, otherwise passed. An action with no
authorized actor always adds an unknown positive-coverage case, even when every
denial passes. A history/document/materialized-state resource rejection of a
positive witness is unknown (provided no mutation occurred), not success. Setup
can itself exhaust the core's 500-entry history budget.

## Evidence boundaries

These are finite generated contract cases, not exhaustive properties or formal
assurance. Tools and schemas share the runtime declaration; policy expectations
are a separate membership calculation, routing expectations are a separate
relationship projection, and the oracle never calls `core.check()`. Domain
precondition/setup knowledge is explicitly specific to this six-action issue
slice. Schemas are not replaceable via the public workspace API; this generator
does not implement arbitrary JSON Schema, arbitrary action bodies, scheduling,
authentication, persistence I/O or external delivery. It does not enumerate all
argument values, histories, issue references or role combinations. Entirely
denied actions cannot establish input-validation or positive-routing coverage.

Read depth: complete local derivation contract and core source, plus the live
runtime memo and repository overview. No new upstream research or claim about
earlier workbench/Lean artifacts is involved.

Run implementation regressions with:

```sh
node --test live/derive.test.mjs live/core.test.mjs
```

## Interactive execution and measured performance

The UI runs the same synchronous generator **inside a Web Worker**, not on the
main thread. The builder generates a self-contained Blob-worker source from the
same core and derive modules used by the UI/Node tests; there is no copied
interpreter, external worker URL, importScripts, dependency download or server.
Running status disables duplicate starts; Cancel terminates the worker and reports
unknown, not a partial pass. Unsupported/blocked workers, startup/execution/message
errors and a 60-second worker budget also report unknown, with no synchronous
fallback. Actual history/materialized-state resource rejections retain their
per-case unknown outcomes. A new run, live commit, applied rule, successful import,
reset or history preview terminates/invalidate the old job. Generation and
state/model identity guards also discard obsolete delivered responses.

Local measurements (2026-11-11, Linux, Node v25.2.0; single sequential sample per
size before and after; not a statistical benchmark): seeded app, fixed clock 123,
20 or 100 successful `comment` entries on i1 by u2 with body `Existing history`.
Time surrounds `runDerivedChecks(app.exportWorkspace())`, including export,
validation/replay and all trials, excluding fixture construction.

| Comment entries | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| 20 | 536.88 ms | 77.34 ms | 6.94× |
| 100 | 30,497.51 ms | 770.19 ms | 39.60× |

All four runs returned passed with 280 cases. The review's 1.36 s / 45.55 s were
not these local baseline measurements; hardware/load/runtime differences matter.
An after-run concurrent with tests/build measured 101.49 ms / 2,022.79 ms; the
table uses an otherwise idle rerun. Worker startup, structured cloning, DOM table
rendering and browser scheduling are not included in these Node measurements.
The browser suite separately verifies at least three animation frames during real
100-comment computation, usable search, exact worker case results, cancellation,
replacement jobs, delayed obsolete responses after every invalidation path, worker
unavailability/failures, exhausted-history unknowns and zero HTTP(S) requests with
the context offline. Delay instrumentation holds real results, not fake passes.

Limits remain: initial reconstruction still replays the full journal; accepted
dispatch still serializes/copies bounded full event evidence; comment before/after
lists grow quadratically. Import, preview, ordinary dispatch and result-table
rendering remain synchronous UI operations. This change removes long synchronous
**declaration checks**, not all possible UI latency. Browser execution evidence is
Chromium-only, not arbitrary browser worker/CSP support or a formal proof.
