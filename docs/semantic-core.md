# Shared executable semantic core — first milestone

Implemented experimental profile: `semantic-core/v1`. The source of execution is
a typed JSON action IR, interpreted by [`semantic/core.mjs`](../semantic/core.mjs).
The same declaration contains resource schemas, explicit input schemas, record
bindings, separate policy/precondition guards, grouped updates and relationship
observations. No action-name switch or domain-specific opcode implements updates.

The authoritative integration guide is
[`semantic/CONTRACT.md`](../semantic/CONTRACT.md), with the exact expression grammar,
numeric/error semantics, API, optimistic transaction obligations and instructions
for inventory, Effect and Lean consumers. Type declarations are
[`semantic/core.d.mts`](../semantic/core.d.mts).

## Implemented decisions

- Strict whole-model validation rejects unknown and unreachable unsupported IR;
  exact input/state schemas reject coercion, extras and missing fields.
- Every grouped update across records reads the immutable prestate. Duplicate
  physical-field writes reject, including aliases through separate bindings.
  Invalid values/overflow reject the entire operation, with no change facts.
- Authorization yields deny, allow or genuinely non-mutating pending. Denial
  dominates. Preconditions have a distinct failure code and declaration identity.
  Approval infrastructure/resumption is **not** implemented.
- Signed safe integers have exact intermediate checked addition/subtraction.
  Clock and actor identity are explicit invocation data; no hidden clock/random
  source or application authentication exists in the interpreter.
- Prepared tokens bind the immutable model, invocation and full versioned
  prestate. Commit rejects a changed state; the host still owes atomic current-state
  publication/CAS. Pure replay against an old snapshot is not durable concurrency
  safety, and no duplicate invocation ledger/outbox is supplied.
- A successful action emits an implicit action fact and actual field-change
  facts, stable declaration IDs and escaped logical event IDs. One-hop recipients
  derive from poststate relationships, with actor exclusion, support-path retention
  and recipient deduplication. This is full recomputation, not incremental query
  maintenance or notification delivery.

[`semantic/issues.mjs`](../semantic/issues.mjs) is the second-domain declaration:
resolving an issue changes status/time and increments a separate counter record.
It is illustrative data **executed by the tests**, not a replacement or integration
for the existing `live/` issue workspace. Existing live files are untouched.

## Evidence and scope

Read depth: README and design brief/laws read in full; source inspection of
`live/core.mjs` in full (410 lines). No additional upstream research or proof
audit was performed. Implementation decisions above specialize the proposed
design laws, rather than claiming all laws are implemented.

Independent execution command: `node --test semantic/*.test.mjs`. Tests exercise
declaration edits changing real execution, multi-record prestate swaps, implicit
facts/routing, policy denial and pending, precondition failure, stale commit with a
separate deliberately bad stale-read host, immutable snapshots/no caller mutation,
malformed/unsupported data, exact numeric boundaries, schema rollback and aliased
writes. This is finite executable evidence, not a formal proof or exhaustive
property check. There is no full-app/browser integration claim.

The restricted numeric fragment and generated-Lean obligations are specified in
the contract. Actual Effect integration, generated Lean output/proofs, the inventory
application, approval flows, inserts/deletes, multi-hop/bidirectional propagation,
durability and external effects are outside this first-milestone ownership. Any
adapter theorem must identify its subset, checked arithmetic, trusted translator,
host atomicity assumptions and omitted routing/authorization obligations.
