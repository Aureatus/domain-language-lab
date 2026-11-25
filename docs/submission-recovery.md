# What happened to my submission?

All declared actions get submission recovery on execute without a new form or policy declaration. Execution evidence answers “what happened to this submit?” A current snapshot answers “what is true now?” A recorded *pending* receipt remains pending even after the approval workflow completes; it should not be interpreted as a current inbox item.

The shared JSON reducer is `application/submission.ts`. It captures the body and identity before dispatch. Loss of a response leads to `unknown`: the UI offers a read-only check, not another submit. If checking also fails, the outcome is still unknown. A missing receipt allows retry of the captured command with the **original** ID. Absence is only an observation at lookup time; a late original request and its retry may race. Safe redelivery relies on the server's durable identity binding. A confirmed pre-execution validation error instead returns the form to editing.

Inspect a trace, then run the real cross-client scenario:

```sh
node application/inspect-submission.ts leave/browser.domain leave.request maya
pnpm run application:submission:test
```

The inspector accepts an optional fourth argument: a JSON array of reducer events. It prints the state and permitted controls after each event. Its built-in traces and receipts are illustrative; replay itself neither contacts the backend nor verifies a supplied receipt.

## HTTP and CLI

- `POST /api/actions/execute` optionally takes `submissionId`. Under the same database and contract, identical actor, action and original arguments recover the first journaled result. A different owner or changed body does not run. Legacy unkeyed callers retain their prior behavior.
- `POST /api/actions/reconcile` takes `{actor, submissionId}`. It never executes the command. A match returns original execution evidence with a fresh snapshot; absence returns `status: "not-found"`. Server-owned clocks and computed inputs are taken from the original invocation on replay.
- `pnpm run leave:cli reconcile ID --actor maya --json` looks up the same submission. CLI execute accepts `--submission-id ID`; if scripting across process death, allocate and save it **before** execute. Without one, the CLI generates an ID and reports it on completion or ambiguous transport failure.

The browser stores unresolved submissions per contract in tab session storage and restores their original drafts after reload. Recovery is scoped per actor and action. The Exact client keeps its driver in the mounted application; app termination is a separate storage boundary. The durable receipt is stored alongside the SQLite invocation in the same transaction; access in this demo uses simulated local actors, not authentication. Grant and completion remain separate durable commands with their existing behavior. This contract does not promise network delivery or exactly-once external effects.
