# Durable Effect execution

Status: experimental SQLite adapter for explicitly selected `semantic-core/v1`
and `semantic-core/v2`. The semantic interpreter remains the source of decisions.
Delivery transport is not implemented.

## API

`adapters/effect/durable.mjs` exports:

- `makeDurableRuntime(model)` — validates and snapshots the model through
  the interpreter selected by the exact `model.format`: `semantic-core/v1` or
  `semantic-core/v2`. Unknown formats throw; there is no migration or fallback.
  State initialization, recovery and outcome decoding use that profile's validator.
- `makeDurableStore(path, {busyTimeout})` — Effect value that opens a Node
  `DatabaseSync`. `initializeDurableState(runtime, db, state)` binds the database
  once to validated initial state and complete model content.
- `durableExecute(runtime, db, invocation, {beforeCommit})` — runs the shared
  interpreter and atomically persists the next state, the outcome ledger, and
  committed implicit facts in the outbox. Replays return
  `{status:'duplicate', result:<stored outcome>}`. A reused ID with changed command
  or model returns `rejected` / `invocation-conflict`.
- `durableState`, `pullOutbox(db, {limit})`, `acknowledgeOutbox(db, sequence)`,
  `closeDurableStore(db)`.
- v2 only: `durableApprove(runtime, db, {id, invocationId, policyId},
  {authenticatedApprover, beforeCommit?})`. The second object is a **trusted-host**
  argument, not client identity claims. Local simulation trusts that host to
  authenticate the approver. Returns the core `approved`/`rejected` result.
- v2 only: `durableResume(runtime, db, {id, invocationId, clock}, {beforeCommit?})`.
  The host supplies a trusted fresh clock. Original invocation/request and receipts
  are loaded internally; no client receipt/request argument is accepted.
- v2 only: `durablePending(runtime, db, invocationId)` returns `null` or
  `{invocationId, status:'pending'|'consumed', request,
  grants:[{policyId, approver}], resumeId:null|string}` for CLI/UI lookup.
  This read projection is not approval authority.
- `DurableStore` and `durableStoreLayer(path)` for Effect service acquisition and
  scoped close. Callers should use the scoped layer or explicitly close the DB.

Every valid invocation outcome is durably reserved, including `pending` and
`rejected`. This makes retries stable and means a later approval/resume API must
use a distinct bounded operation and durable transition, not mutate state through
an arbitrary setter. Approval/resume IDs share one namespace with invocation IDs;
same command/host identity retries return `{status:'duplicate', result}` and changed
commands return `rejected` / `invocation-conflict`. Denied operations reserve their
IDs but create no grant. Missing requests and premature resumes are also reserved;
use a new operation ID after obtaining grants. Pre-storage failures
(for example invalid non-JSON command data) reserve nothing. `beforeCommit` is a
synchronous failure-injection hook; throwing rolls back all writes.

Commands have exactly the listed members; unknown members (including fabricated
`receipts`) fail before reserving an operation ID. Operation references are nonempty
strings of at most 1000 UTF-16 code units. Clocks are nonnegative safe integers.
`authenticatedApprover` participates in immutable approval command identity, so
retrying an ID as another host identity conflicts. All APIs other than runtime
construction return Effect values.

The original execute outcome remains `pending` forever in the invocation ledger;
read `durablePending` for its current workflow status. A successful resume consumes
the request atomically and names its resume ID. Even a different resume ID cannot
consume it again. Failed resumes leave it pending and persist their rejected
outcomes. Each policy has at most one grant; another grant operation for that policy
returns `already-granted`. Retries of the original grant still return its stored
outcome after consumption. Missing request lookup returns `null`; operations on a
missing request return `missing-request`; operations on a consumed request return
`consumed`. v1 approval operations fail rather than reinterpret v1 pending data.

Grants validate original eligibility, not freshness; only resume validates the
current full model/state and reevaluates policies, requirements and preconditions
at its supplied clock. Stale or denied resumes never publish state/events. The
database is bound to complete model content, so reopening with changed model
content fails closed; there is no model-upgrade API. No arbitrary state setter,
request replacement, cancellation, revocation or bulk approval API is provided.

## Guarantees and boundaries

`BEGIN IMMEDIATE` serializes writers using SQLite's locking and transaction
semantics. State update, immutable command/model identity, the serialized outcome,
and committed event rows share one transaction. Pending requests, approval operation
outcomes/grants, and resume outcomes/consumption/state/events likewise share their
respective transactions. Receipts are read only from the internal grant ledger in
the resume transaction; exported receipt JSON is never accepted as authority.
SQLite constraint or injected
failure rolls the transaction back. A process restart recovers the last committed
state and ledger; persisted JSON is parsed, bounded/snapshotted, canonicalized,
and state is checked against the bound model schema. A different model binding,
format, malformed JSON, or invalid state fails closed. The unique primary key on
invocation ID prevents simultaneous writers from both reserving the same ID.

These are adapter guarantees conditional on SQLite's implementation, successful
filesystem/database operations, and the configured storage medium honoring its
durability contract. Node `node:sqlite` is experimental in Node v25.2.0. This
adapter uses synchronous `DatabaseSync` calls and does not claim cancellation
inside a database call: Effect interruption is observed only at surrounding
runtime boundaries. `busyTimeout` bounds lock waiting; a lock/busy error is
surfaced as an Effect failure, never treated as a successful race or retried
silently. Use a local filesystem with SQLite-compatible locking; network filesystems,
storage-controller caches, power-loss behavior, backup/restore and multi-host
deployment are not certified here. The default SQLite journal/synchronous policy
is left to SQLite; applications needing a particular power-loss durability level
must configure and validate it for their deployment.

Outbox pull is ordered and non-destructive. A consumer may deliver a row and die
before acknowledging it, so delivery is **at least once**. Acknowledgement is
explicit, and duplicate delivery is possible. The adapter performs no external
sending and makes no exactly-once delivery claim. There is no business-fact API;
only the interpreter's implicit action/change/create/delete facts are stored
(create/delete are v2 only).

This is not a sandbox against malicious same-process JavaScript or direct edits to
the SQLite file. SQLite and trusted Node intrinsics, the Effect 4.1.4 API, and the
semantic interpreter are in the trusted computing base. No proof of semantic
correspondence, distributed transaction or authentication is added. Policy decisions
are enforced by the selected semantic interpreter, not reimplemented by this adapter.
Invocation actor, authenticated approver and fresh resume clock must be supplied by
a trusted host; the local simulation does not authenticate them. Never expose these
host arguments directly as untrusted client authority. The host must supply real
fresh time on every new resume operation; this adapter does not read wall time or
enforce host clock monotonicity. Stored retries return historical outcomes, not a
fresh authorization check, and do not republish events.

## Verification

Read depth: full local README, v2 contract and durable memo; source inspection of
the durable adapter, selected v2 runtime/fixtures and existing v1 tests; independent
execution, no proof audit. Earlier v1 work inspected selected `semantic/CONTRACT.md`,
`docs/effect-adapter.md` and the installed dependency declaration. Tests execute
the installed `effect@4.1.4` API and Node v25.2.0 `node:sqlite`. Run:

```sh
node --test adapters/effect/*.test.mjs semantic/*.test.mjs semantic/v2/*.test.mjs
```

Tests use database reopen, independent child processes, concurrent writer
serialization, before/after-commit process death, injected rollback, pending and
rejected ledger persistence, replay identity, outbox acknowledgement and malformed
stored JSON. They test this mapping, not upstream Effect or SQLite suites.
The v2 suite additionally reopens after pending/grant/consumption, checks one-shot
resumption, exact/reordered operation identity, unauthorized/self grants, rejected
client receipts, stale state/changed model/fresh-clock invalidation and transaction
rollback across every ledger, consumption, state and outbox write. These are bounded
executed examples, not exhaustive proofs or v2 cross-process crash certification.
