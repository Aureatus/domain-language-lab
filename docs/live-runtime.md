# Live runtime: experimental issue tracker

`live/core.ts` is a dependency-free, browser-safe ES module implementing the
[live integration contract](../live/CONTRACT.md). It is separate from the earlier
approval prototype, precomputed workbench and Lean model. Their proofs do not
establish correspondence with this runtime.

## Exact API

```js
import {createApp} from './core.ts';
const app = createApp({clock: () => 1794391200000});
const result = app.dispatch('comment', {issueId: 'i1', body: 'Reproduced.'}, 'u1');
const why = result.ok ? app.explain(result.event.id) : result.reason;
```

- `createApp(options = {})` makes a fresh seeded application, or reconstructs
  `options.workspace` using the import checks below (invalid initial data throws).
  Only `clock` and `workspace` are supported options; unknown options or a
  non-function clock throw. The default clock is
  `Date.now`. Each accepted invocation samples the clock once, after validation
  and policy/precondition checks. Clock errors/non-finite or out-of-Date-range results reject without
  a runtime state change. Clock callbacks are trusted synchronous, non-reentrant
  inputs, not sandboxed effects. Use an injected clock for reproducible timestamps.
- Read `state` and `model` at use time. Both are deeply frozen JSON snapshots.
  Successful actions replace state; rule edits replace model. Retained snapshots
  remain unchanged. Reset by constructing another app. Users/roles are seeded and
  not editable through this API; watch membership changes through `watch`.
- `dispatch(action, args, actorId)` is synchronous. Success returns
  `{ok:true,event,value}`, where `value` is the resulting issue for **every** action.
  Failure returns `{ok:false,reason}` and leaves state/model identities unchanged.
  An actor ID is required; the UI should supply its default actor `u1`.
- `invokeTool(name,args,actorId)` is the exact same dispatch function, with no
  bypass for tool calls. `tools()` returns frozen descriptors with
  `{name,label,description,parameters,inputs,allowedRoles,notify,revision}`.
  `parameters` and `inputs` contain the declaration's same schema. Enumeration is
  not actor-filtered; consumers use `explainAction` for contextual availability and
  dispatch always rechecks the current declaration.
- `explainAction(action,args,actorId)` is a synchronous, effect-free current query:
  `{available,category,reason,revision,source,missingRequirements,scope}`. `source`
  is `actions.<name>` (or `null` for unknown actions), `scope` is
  `current-pre-execution`, and the result is deeply frozen. Categories are
  `available`, `action`, `actor`, `policy`, `missing-input`, `schema`, and
  `precondition`. `missingRequirements` lists absent required input paths, e.g.
  `['args.issueId','args.assignee']`, only after actor/policy checks pass; explicit
  `null` is a supplied assignee, not a missing input. Blank inputs are schema errors.
  It uses the **same preparation function as dispatch**, in the same order:
  known action → known actor → role policy → schema/defaults/references → domain
  preconditions. It reports the first rejection (same reason as dispatch), not an
  exhaustive set of failures. Partial inputs never produce `available:true`.
  Policy denial does not inspect references, disclose record contents or list
  missing inputs. Results include no issue/actor snapshots or normalized args.
  Querying never calls the clock, publishes state/model changes, or appends to the
  journal. Availability is not authorization held for later: dispatch rechecks,
  and execution clock failures and history/document/materialized-state resource
  limits can still reject. There is no approval token or cross-client guarantee.
- `setRule(action,patch)` accepts only a nonempty patch of `allowedRoles` and/or
  `notify`. Values must be duplicate-free arrays of known roles/paths. Empty
  arrays mean deny everyone / notify nobody. Success returns `{ok:true}` and
  increments global model revision once, including valid no-op patches. Invalid
  patches return `{ok:false,reason}` without changes. Inputs are copied, not kept
  by reference. This is an unrestricted developer-lab operation, not a protected
  domain action; it creates no issue event or notifications.
- `explain(eventId)` returns the captured, frozen event, or `null` if unknown.
- `check()` returns an array of `{name,ok}` current-state audits, not a proof,
  a generated test run, or a claim about arbitrary future executions.
- `exportWorkspace()` returns a fresh, deeply copied/frozen JSON document as
  specified below. It contains successful commands, not a mutable state dump.
- `restoreWorkspace(document)` returns `{ok:true}` or `{ok:false,reason}`. It
  reconstructs privately from the seed, then replaces state/model/journal together.
  On failure, all previous identities and contents (including events) remain intact.
- `previewWorkspace(stepCount)` returns `{ok:true,state,model}` for the first N
  journal entries, or `{ok:false,reason}`. N must be an integer from zero through
  current journal length. Both returned snapshots are deeply frozen; the result
  exposes no dispatch methods. Preview never changes live state/model/journal.

### Trusted runtime forks

`forkApp(runtime, {clock?})` is an additive module helper for private generated-test
runtimes. A module-private WeakMap recognizes only actual `createApp`/fork runtime
identities. It captures the current runtime-owned, deeply frozen state/model and
journal roots, journal size accounting and original seed-version audit baseline.
Only those roots are shared; each fork has independent publication variables and
future appends/replacements. Prepared setup can be forked without replaying it.
Forking does not sample a clock; the default inherits the parent's clock callback
contract (including any externally shared callback state), or callers inject an
independent clock. Restore retains each runtime's own future clock. Existing
forks retain their snapshots when parents/siblings restore or change rules.

There is no public snapshot argument, raw-state constructor option, deserialization
shortcut or ability to brand a fabricated/frozen object as trusted. External
documents still require full schema validation and replay. The helper is exported
for the generator, but its trusted snapshot capture and installation are private.
Replay compares each canonical entry directly with its private generated journal
entry rather than repeatedly copying the entire exported prefix. Public exports
remain fresh detached frozen documents. Fork isolation trusts the same single-realm
deep-freeze and non-reentrant-clock assumptions as the rest of this runtime.

## Workspace document and replay

The exact v1 envelope is:

```js
{
  format: 'live-issue-workspace/v1',
  seedVersion: 1,
  journal: [/* ordered entries below */]
}
```

Each entry has exactly one of these shapes; `step` is its one-based position:

```js
{step, kind: 'dispatch', action, args, actorId, createdAt, eventId, issueId, revision}
{step, kind: 'setRule', action, patch, revision}
```

Dispatch stores the exact **validated** arguments, including applied defaults and
untrimmed strings; actor ID; the single captured clock value; generated event and
issue IDs; and the declaration revision used. Rule edits store the accepted patch
and resulting revision, including accepted no-op edits. They do not sample the
clock or invent an actor. Tool invocations use dispatch entries. Rejected actions,
failed clocks and rejected rule edits never append entries. Event, comment and
notification IDs are reconstructed by the unchanged deterministic counter rules.

Import accepts an object, not JSON text; callers parse stored text first. It checks
the exact envelope and entry keys, format/seed versions, contiguous steps, known
operations/actions, canonical validated arguments, actor/reference IDs, schemas,
policies, transitions, roles/notification paths, generated IDs and revisions.
Unknown versions fail explicitly. Imported schemas/state/event dumps are not
accepted. Each replayed entry must match the entry produced by the same normal
runtime operation (object key order is immaterial; array order is significant).
JSON values must be finite, plain data without cycles, sparse arrays, symbols,
accessors or executable/custom objects. Timestamps must also fit JavaScript's
Date range; chronological monotonicity is not required.

Limits: 500 entries, 2,000,000 serialized JSON UTF-16 code units, nesting depth
20, 100,000 inspected values, and 10,000 items per array. Materialized state is
also capped at 8,000,000 serialized JSON code units because full comment-list
before/after evidence can grow faster than the journal. Live appends enforce
the history/document/state limits before publication; reaching a limit rejects the new
operation without changing state/model/journal. These bounds keep synchronous
reconstruction practical for this small local experiment, not unlimited histories.

Replay uses each captured timestamp and never calls the live injected clock or
external services. Reconstruction appends once per entry in an isolated runtime;
it does not dispatch into the live app, recursively journal restore operations, or
append entries twice. After restore, **future** dispatches still use the original
injected clock. Export and preview are not journaled. Historical explanations
retain event-time rule, actor, relationships and differences across rule edits.
Retained snapshots remain unchanged after successful restore as well.

This is local deterministic reconstruction, not cryptographic integrity checking:
a deliberately edited but valid journal can describe another valid history. The
core performs no storage I/O; the renderer owns saving and reporting storage
failures. Inputs are trusted-realm data, not a sandbox for hostile JavaScript
Proxies or reentrant callbacks.

## Declaration-driven behavior

The declaration is the single source for action labels, allowed roles, input
schemas and notification paths. The small built-in domain implementations are
explicitly a finite action set, not a general compiler or arbitrary model loader.
Schemas are not replaceable through `setRule`; attempts to inject a new schema
or model fail. The internal validator rejects unsupported schema types/keywords.

| Action | Inputs | Default roles | Domain behavior |
| --- | --- | --- | --- |
| `create` | `title`, optional `description`, `priority` | lead, member | Create open issue, actor as opener, no assignee/watchers/comments |
| `assign` | `issueId`, `assignee` | lead | Set known user ID or `null` to unassign; unchanged assignment rejects |
| `comment` | `issueId`, `body` | lead, member | Append authored, timestamped comment |
| `resolve` | `issueId` | lead | Open → resolved; already resolved rejects |
| `reopen` | `issueId` | lead, member | Resolved → open; already open rejects |
| `watch` | `issueId` | lead, member | Toggle only actor's membership |

All inputs are objects; unknown keys, wrong types and unknown user/issue IDs
reject. Title/body must contain non-whitespace text; lengths cap at 160/5000 JS
string code units. Strings are preserved, not trimmed. Description defaults to
`''` and caps at 5000; priority defaults to `normal` and accepts `normal|high`.
Only assignee is nullable. No status restriction applies to comments, assignments
or watch changes. Every accepted invocation increments issue version once (new
issues start at one), including watch toggles. Initial issues `i1`/`i2` start at
version one without invented historical events. New issue/event/comment IDs are
local deterministic counters; comment IDs use their event's counter and can have
gaps. There is no delete or retry/idempotency protocol. Persistence uses the
versioned command journal above, not arbitrary state replacement.

## Grouped publication and historical explanations

Dispatch builds a candidate issue, field differences, implicit action event and
inbox intents before one frozen state replacement. No observer sees an issue
commit without its event/inbox records through this synchronous API. This is
local grouped publication, **not** a database transaction or concurrency protocol.
Create changes use `null` for previously absent fields; other differences are
`{field,before,after}`, including version. A create still creates an event even
though actor exclusion normally leaves its recipient set empty.

Every event captures:

- `id, action, actorId, issueId, revision, createdAt, args`;
- `actor`: complete event-time user snapshot;
- `source`: stable declaration path such as `actions.comment`;
- `rule`: complete action declaration as used at commit;
- `changes`: copied before/after field data;
- `relationshipSnapshot`: post-mutation issue ID/version, opener, assignee and
  watcher IDs;
- `recipients`: `{recipient,reasons,paths}[]`, with reasons like `watchers` and
  concrete path records `{from:issueId,relationship:'watchers',to:userId}`.

Routing is event-scoped full recomputation over the declared `opener`, `assignee`
and `watchers` paths in declaration order. All actions default to these paths
except `watch`, which defaults to no notifications. It uses the **resulting**
issue snapshot: assignment notifies the new assignee, not the removed assignee.
The actor is excluded through every path. Recipients are deduplicated by user ID,
retaining all supporting relationship reasons. Inbox records are one per
event/recipient, with `{id,eventId,issueId,recipient,action,reasons}`. These are local
intents, not evidence of external message delivery. Changing a rule or watch
membership never reroutes past events or produces retroactive notifications.

## Evidence and limits

Read depth for this implementation: complete local `live/CONTRACT.md`, the
language/UI/reactivity research memo, proposed laws/scenarios, and the earlier
prototype model source. The finite runtime is an implementation decision informed
by those proposals, not an implementation of their full language architecture.

Run the independent live test file with:

```sh
node --test live/core.test.ts
```

Tests cover live workflows, policy/routing edits, denial/nonmutation, input/ID
failures, duplicate relationship support, immutable historical evidence,
tool/direct agreement, grouped updates and failing clocks. Persistence tests cover
mixed-action roundtrips, exact IDs/defaults/timestamps, rule revisions and historical
Why, every read-only replay prefix, restore/future-clock separation, deeply frozen
exports, rejected-command journal exclusion, malformed/late-failing imports,
unsupported versions, JSON/document/state bounds and history-cap atomicity. `check()` separately
audits unique IDs, issue/reference validity, captured event authorization,
snapshot-routing agreement, unique inbox keys, exact event-intent correspondence,
and issue-version/commit counts. Its routing audit uses the runtime's routing
function and is therefore not an independent routing oracle; example tests assert
specific expected routes independently. Some audit clauses are defensive for
future internal changes because the public API cannot mutate frozen state.

Scope: one trusted JavaScript realm, immutable runtime-owned JSON data and
synchronous invocation. Actor IDs are supplied by the caller, not authenticated.
The core provides no durable storage I/O, external delivery, distributed ordering, model
checking, arbitrary recursion, bidirectional relationship engine or formal
correspondence proof. No upstream tests are copied and no previous verification
artifact is replaced or upgraded by this experiment.

### Earlier current-availability slice

This update changes only shared pre-execution preparation, the additive
`explainAction` query, renderer availability presentation, their tests and these
two live guides. Action mutations, precondition/validation ordering, error reasons,
clock timing and the serialized v1 journal format remain unchanged. No derive,
build, recording or package source changes. Generated HTML/test reports are build
outputs, not new semantic authorities. Query tests check frozen results, state/model
identity and journal preservation with zero clock calls; table cases compare
availability/reasons against fresh actual dispatches, including policy-before-reference
denial, missing/invalid inputs, transitions and nullable/unchanged assignments.
Applied-rule revision changes and execution clock failure are also covered.
Read depth: README, both live guides, full core and selected contract/UI/test source;
independent execution: `npm test`, `npm run live:build`, `npm run live:test`.
No external research, proof audit or upstream-suite copying.

### Fork/worker performance slice

The subsequent performance update changes core/derive/build/UI and tests without
changing dispatch outcomes, v1 journal serialization, import validation, grouped
publication or public export semantics. Tests add sibling/prepared-fork isolation,
parent/child restores and rules, audit baseline preservation, explicit/inherited
clocks, fake-runtime rejection and a 100-comment derivation regression. Interactive
checks execute off-thread using the shared bundled modules, with no synchronous
fallback. See [measured timings and limits](live-derivations.md#interactive-execution-and-measured-performance).
