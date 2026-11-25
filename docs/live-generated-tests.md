# Generated tests for the live runtime

Run with `node --test live/generated.test.ts`; run the report-producing CLI with
`node live/generated.ts` (optional `SEED`, `RUNS`, `MAX_STEPS` environment
variables). The CLI writes `artifacts/live-generated-report.json` and exits
nonzero on a counterexample.

`runGenerated({seed,runs,maxSteps,wrapper})` performs deterministic seeded
sequential histories containing the six declared actions and `setRule`. Its
report is either `sampled_pass` with actual action/denial/rejection/rule-edit,
invalid-reference and declared-path counts, or `counterexample` with seed and
replay history. Counterexamples use deterministic prefix minimization; this is
a simple prefix reducer, not general delta debugging.

The test oracle does not call `app.check()`. It independently evaluates actor
role authorization from the current declaration, input/reference validity and
domain preconditions, issue transitions, and routes over the declared paths
from the post-action relationships. It checks rejected calls preserve state
and model identities, event policy/revision snapshots, and retained historical
values against serialized baselines captured before mutation. Successful runs
also reconstruct the final exported journal and compare model/state. Coverage
distinguishes attempted actions from accepted actions. Deliberate route-result,
policy-result and weakened-freeze snapshot-corruption mutants confirm that the
generated checks report counterexamples.

## Evidence boundary

This is deterministic sampled testing, not proof, model checking, exhaustive
coverage, or runtime correspondence evidence. The core remains trusted to
provide the seeded user/issue model, synchronous dispatch behavior, serialization
and snapshot mechanics, and rule declarations. The oracle independently encodes
the finite actions and current schema constraints, so shared misunderstandings
of the documented law remain possible. Clock is explicitly deterministic in
each trial; external I/O, concurrency, storage I/O, authentication, and delivery
are outside scope. Read depth: complete `live/core.ts` and selected contract
sections in `docs/live-runtime.md` for this implementation.
