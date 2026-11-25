# Effect adapter

Status: bounded in-memory adapter for `semantic-core/v1`; not durable storage.

## Use

Install with `pnpm install --frozen-lockfile` from the repository root and import `makeRuntime`, `makeStore`,
and `execute` from `index.ts`. `execute(runtime, store, invocation)` is an Effect
value and must be run by the Effect runtime (for example `Effect.runPromise`).
The invocation's `clock` is mandatory caller-supplied data; the adapter never
reads a system clock.

The adapter calls the shared interpreter without action-name branching. Invalid
models still throw during `makeRuntime`; rejected and pending interpreter results
are returned unchanged and do not modify storage. Committed state and event facts
are replaced together under one `SynchronizedRef.modifyEffect` critical section.
An optional `beforePublish(result)` failure is an Effect failure and occurs before
replacement. Cancellation before the synchronized modification completes publishes
nothing; after the atomic Ref transition, cancellation cannot undo it. This is
process-local atomicity, not crash consistency, disk durability, or distributed
transactionality.

Successfully committed invocation IDs are deduplicated in this store instance: an identical replay returns
`duplicate` and does not publish again; a differing invocation with the same ID
returns `rejected`/`invocation-conflict`. This ledger is neither persistent nor
shared across processes and does not authenticate actors or validate clock units.
Identity compares strict JSON content independent of object-key order, including
the runtime model content. Initial state and committed invocation data are copied
and frozen; later caller edits cannot rewrite the ledger. Pending/rejected calls
do not reserve IDs and may be retried with changed arguments. Invalid non-JSON
invocations fail the Effect snapshot step. The synchronous `beforePublish` hook
is for failure injection, not asynchronous external side effects.
No retry, approval granting/resumption, delivery or outbox transport is provided.

## Evidence and limits

Pinned package: `effect@4.1.4` (exact in `package.json` and `package-lock.json`).
API evidence: inspected the installed package entry points and exercised
`Effect.gen`, `Effect.try`, `Effect.all`, `Effect.runPromise`,
`SynchronizedRef.make`, `SynchronizedRef.modifyEffect`, and
`SynchronizedRef.get` in the adapter tests. Read depth: selected installed API
exports plus independent execution of adapter tests; not a full source audit of
Effect. The synchronization guarantee is trusted to this package implementation
and scoped to this single in-memory Ref. It does not establish interpreter
correspondence beyond differential use of the same `createInterpreter`, nor
database isolation or exactly-once external effects.

Run `node --test adapters/effect/*.test.ts` for actual Effect-runtime tests.
