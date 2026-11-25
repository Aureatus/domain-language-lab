# Lifecycle and policy-derived approvals (v2)

The isolated `semantic/v2/core.ts` implements generic grouped create/update/delete
and serializable approval requests/receipts. v1 source, consumers and existing Lean
evidence are unchanged. **No v2 Lean proof is claimed.** A separately implemented
[SQLite host](durable-execution.md) now persists this core's requests/grants and
executes one-shot resumption; see the [inventory acceptance](inventory-v2.md).

See the exact integration contract in
[`semantic/v2/CONTRACT.md`](../semantic/v2/CONTRACT.md) and strict public declarations
in [`types.ts`](../semantic/v2/types.ts).

```js
import {createInterpreter} from '../semantic/v2/core.ts';
const runtime = createInterpreter(model); // format: semantic-core/v2
const result = runtime.execute(currentState, invocation);
if (result.status === 'pending') {
  // Host durably stores result.request. No writes/events have occurred.
  const grant = runtime.approve(result.request, {
    policyId: result.policyIds[0], approver: authenticatedApproverId,
  });
  if (grant.status === 'approved') {
    // Persist grant.receipt in the trusted ledger; gather ALL required grants.
    const resumed = runtime.resume(latestState, invocation, result.request,
      [grant.receipt], {clock: explicitResumeClock});
    // Publish only a committed result, atomically with deduplication and outbox.
  }
}
```

The snippet is illustrative core wiring; the separately tested durable workflow
uses the SQLite adapter rather than caller-supplied receipt authority.
For interleaving work use `prepareResume` and `commit(latestState, prepared)`.
The host must authenticate identities and load receipts from trusted storage:
receipt JSON alone grants no authentication. Full model, original invocation and
full prestate bind every request/receipt. State/model changes require a new request
and grants. Resume uses a required fresh clock to recheck policies/preconditions;
approval is never implemented by changing a policy to allow. If time changes which
approval requirements apply, resume rejects instead of silently dropping review.

Insert keys are explicit, every inserted field is declared, and all grouped RHS
expressions use immutable prestate. Conflicting physical writes reject the whole
group. Create/delete facts include complete record snapshots. Observation of a
deleted record uses its prestate recipients; surviving/inserted records use poststate.
No-op assignments still increment written record versions; every commit increments
revision, including an empty group. See the contract for precise event ordering,
failure shapes and trust boundaries.

## Reproduce scoped checks

```sh
node --test semantic/v2/*.test.ts semantic/*.test.ts
tsc --strict --noImplicitAny false --noEmit --allowImportingTsExtensions --module nodenext --target es2023 semantic/v2/types.test.mts
```

Core-only tests need no additional dependencies. The integrated `npm test`
script now includes v2, inventory and durable-adapter tests.
Tests exercise this interpreter mapping, not upstream suites. Browser safety is by
dependency inspection only; browser execution and formal verification of v2 remain
outside this milestone.
