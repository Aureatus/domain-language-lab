# Sampled approval-property adapter

Implemented in `prototype/property.ts`, using the existing `Runtime`; no dependencies or engine changes. Read depth: local prototype source inspection and selected verification/law memos; execution evidence is provided by `prototype/property.test.ts`. This is **sampled testing, not formal verification or exhaustive model checking**.

## Law and oracle

`L2/current-approval-snapshot/1`: when current policy requires approval, a new commit must have a reviewer approval of the exact current invocation ID, requesting actor, summary, whole ticket and whole model. Current denial forbids execution. Current allow does not require approval. Restoring an exact old snapshot makes its approval valid again; invalidation is snapshot-based, not an irreversible dirty flag. Repeat execution after completion is a no-op.

The independent oracle maintains its own state machine from command inputs and compares outcomes, public invocation state, ticket and model after every action. It does not call the runtime's binding/hash/decision helpers or inspect event subject/approval-match diagnostics. It independently captures reviewer-approved snapshots and uses Node structural equality. Runtime traces are included for explanation, not used as the oracle. Unexpected discrepancies are `snapshot-oracle-mismatch`; the deliberate runtime mutant accepting any prior approval produces `stale-approval-commit`.

Trusted boundaries: this oracle implementation, Node structural comparison/cloning, the test harness and the runtime's observable public state. Both implementations share the initial model/type vocabulary; this is not a wholly independent domain specification or proof of interpreter correctness. Only these exposed state/outcome observations are compared; delivery correctness, trace completeness, arbitrary engine mutants, authentication and concurrent/external execution are not established.

## API

```ts
import { runProperties, replayHistory, generateHistory, shrinkHistory } from './prototype/property.ts';

const report = runProperties({
  seed: 24301, samples: 200, maxSteps: 32, shrinkBudget: 2000,
  staleApprovalMutant: false,
});
const replayed = report.failures.length ? replayHistory(report.failures[0].replay) : null;
```

All functions are synchronous. Import and `runProperties` write no artifacts. Infrastructure/invalid-option errors throw, never return a pass. Results are JSON serializable.

- `runProperties(options?: PropertyOptions)` returns `approval-property-report/1`: `result` (`sampled_pass` or `counterexample`), law ID, root `seed`, executed `sampleCount`, `skipped: 0`, `bounds`, engine provenance, coverage and `failures`. Defaults are shown above (`seed: 0x5eed`). All samples run even after failures. Each failure includes zero-based sample index, `sampleSeed`, original history/failure, `minimalHistory`, shrink attempts/budget status/minimality, exact `replay` and `minimized` replay result/trace.
- Numeric options must be integers: seed `[0, 2^32-1]`, samples `[1, 10000]`, maxSteps `[1, 1000]`, shrinkBudget `[0, 100000]`. Small sample/depth choices may be vacuous; inspect coverage. A pass is only completion of the requested samples, not an adequacy assertion.
- `generateHistory(sampleSeed, maxSteps = 32): Action[]` generates one history. The report's root PRNG emits one unsigned sample seed per sample; each history uses its own PRNG. Recreate a sample with its recorded `sampleSeed` and depth bound.
- `replayHistory(data: ReplayData)` returns `result`, `coverage`, first `failure` (or null), and runtime `trace`. The exact replay contract is `{ format: 'approval-property-replay/1', clock: 1000, staleApprovalMutant: boolean, history: Action[] }`. Replay validates command tags/value domains before execution and rejects unknown commands/roles, then starts from the imported model and `ticket()` fixture with no invocation; it stops at the first discrepancy. This validation is not a sandbox or resource limit for untrusted JSON. A passing single replay uses `sampled_pass` and does not establish a general property.
- `shrinkHistory(history, mutant = false, budget = 2000)` requires a failing history and preserves the first failure's kind. Returns `minimalHistory`, `attempts`, `budgetExhausted`, `minimality` and exact `replay`. Run `replayHistory` on that replay to inspect the witness. It throws for a passing input.

`Action` includes request (actor + summary), approve (actor), edit (summary), execute, policy (role/priority/decision), revision (numeric value), and resource edits (version, priority or watchers). Resource edits directly change the runtime's public ticket, representing explicit environment interference; they are not authorized production actions. Policy/revision edits call `replaceModel`. Roles are support/reviewer/viewer, priorities normal/high and decisions allow/deny/approval. Request/approver actor IDs are actor-1/actor-2; summaries come from the finite list in `bounds`. Revision/version mutations use 0–3; watcher sets are empty, user-1, or duplicate user-2. Shrinking additionally uses actor ID `a` and empty watcher arrays.

## Generation, shrinking and replay

The versioned dependency-free Mulberry32 generator uses explicit unsigned 32-bit arithmetic. Seed zero is valid; no ambient randomness/time enters execution. Histories vary lengths, values, action order, actors, rejected operations, approvals/reapprovals, edits, executions and policy/resource changes. Half are biased toward request → reviewer approval → random mutation → execute, when the bound permits four actions; the remaining suffix and other histories are random command sequences. This bias is intentional, not uniform sampling. No fixed permutation list stands in for generation.

The shrinker first removes chunks, then repeatedly tries single-action deletion and listed value simplifications. A candidate is retained only if independent replay still fails with the same kind. Values shrink toward short summaries, short actor IDs, zero versions/revisions and empty watcher lists. On convergence the result is locally minimal for single deletion and those listed simplifications, **not necessarily globally shortest**. Exhausting the replay budget is explicitly `budget-limited`, never a minimality claim. The original history and exact shrunk commands are retained, so replay does not depend solely on generator internals or a shrink-path encoding.

Every report includes SHA-256 of engine/model/adapter source bytes, Node version, interpreter ID, generator/PRNG/oracle IDs and the mutant flag. These identify this execution's source inputs, not a compiler or deployment attestation. Replay uses current imported sources: compare provenance before replaying across revisions. Clock is fixed at 1000. Histories are sequential, single-ticket, single-invocation, synchronous in-memory simulations, with no real delivery or persistence and no liveness claim.

## CLI and checks

```sh
node prototype/property.ts --seed 24301 --samples 200 --max-steps 32 --shrink-budget 2000
node prototype/property.ts --seed 24301 --samples 40 --mutant
node --test prototype/property.test.ts
pnpm test
```

The CLI writes `artifacts/property-report.json` relative to the working directory. Exit status is 0 for `sampled_pass`, 1 for counterexamples (including expected deliberate mutant failures); argument/setup errors also fail visibly. Save reports before rerunning, since this output path is overwritten. No package-script changes are required; a parent integration may optionally add a script that invokes this CLI.

Tests cover reproducible generation/reports, JSON round trips, non-vacuous fixed-seed coverage, generated mutant detection, exact original/shrunk replay, deterministic shrinking and deletion-local minimality, edits/resource/model invalidation, current-policy deny/allow, restoration/no-op updates, reapproval, idempotent execution and explicit budget exhaustion. Node native TypeScript stripping executes these tests; it is not static type checking. These checks test this adapter and its mapping, not an upstream property-testing suite.
