# Lean approval pilot

**Evidence class:** `proof_checked` for the Lean model only. This is a small
formalization, not an end-to-end verification result.

## Model and claims

[`proof/Approval.lean`](../proof/Approval.lean) defines a transition system whose
state carries ticket version, action arguments, policy revision, an optional
approval binding and commit status. Approval snapshots all three binding
components. The only successful commit transition requires that snapshot to
equal the current version/arguments/policy tuple.

The file proves:

- every committing step has an approval bound to its exact pre-state;
- an approval followed by commit is reachable (a positive, non-vacuity witness);
- changing arguments after approval yields a concrete stale binding that does
  not match current state.

These are claims about the explicitly defined Lean relation. `Nat` values are
mathematical naturals; there is no runtime overflow, concurrency, persistence,
authentication, hashing, effects, or delivery model. In particular, the Lean
binding is a tuple equality, not the TypeScript interpreter's SHA-256 hash.

## Proof execution and evidence

Run `proof/run.sh` from any working directory. It resolves paths relative to
itself and writes `artifacts/lean-report.json` and `artifacts/lean-proof.log`.
It uses `LEAN` when supplied, otherwise `lean` on `PATH`, then elan under
`ELAN_HOME` or `~/.elan`. The pinned toolchain is Lean 4.19.0 in
`proof/lean-toolchain`. No global toolchain defaults are changed by this pilot.
The report binds to the SHA-256 of `proof/Approval.lean` and records tool
version, transitive axioms, scope and status. Missing Lean or any Lean failure
returns a nonzero exit and a `tool_error` report, never a pass.

The checked declarations report Lean's core `propext` axiom. The runner checks
the pinned version from the proof directory and parses every expected theorem's
complete transitive axiom list. Missing/unrecognized reports and any axiom other
than `propext` fail closed. JSON is encoded rather than shell-interpolated.
There are no project axioms or `sorry` in the current proof.

On this session's machine, Lean was installed in isolated tooling storage. Run:

```sh
LEAN=/tmp/opencode/elan/toolchains/leanprover--lean4---v4.19.0/bin/lean pnpm run proof
```

That temporary path is environment-specific. On another machine install the
pinned toolchain using elan or provide `LEAN` as an executable path.

## Correspondence boundary

No relation between this model and `prototype/engine.ts` is formalized or
checked. The TypeScript interpreter, its binding construction and hash, policy
evaluation, event traces, and runtime behavior remain outside the theorem.
There is no verified extractor, translation validation, or proof that the Lean
model faithfully represents the implementation. Consequently this proves no
property of the executable application. Establishing a source/IR-to-Lean
correspondence is a separate future obligation.

Read depth: prototype model/interpreter and the selected verification memo were
inspected; Lean proofs were independently executed with Lean 4.19.0. No claim is
made about full upstream Lean soundness auditing.
