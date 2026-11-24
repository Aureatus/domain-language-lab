# Initial semantic laws and scenarios

These are proposed requirements, not implemented tests or checked proofs. Formulas are explanatory pseudocode. Each obligation must ultimately identify its domain, quantifiers, initial states, transition relation, frame conditions, assumptions and observable result.

## Law catalogue

### L1 — Frontend agreement

Equivalent elaborated semantic models yield equivalent observations under the same execution inputs/interpreters. Textual and TypeScript frontends cannot silently diverge on nullability, default evaluation, error or cancellation semantics.

Scenario: elaborate the same action through both frontends; compare normalized IR and run both against a small reference interpreter. Start with differential/property tests; compiler correspondence is a separate proof obligation.

### L2 — Authorization at execution

Every protected commit has valid authorization for its actual invocation under the chosen policy/revalidation semantics. Pending, denied and completed are distinct outcomes. Approval of arguments A cannot silently authorize changed arguments B.

Scenario: approve, edit arguments, race execution with revocation. Check permitted outcomes at the specified atomicity point. Positive witness: an eligible, unmodified invocation can complete. Scope must name how external irreversible operations relate to the commit.

### L3 — Atomic grouped state update

All assignments in one grouped update read the same prior state; observers see either the prior committed version or the resulting version. Unmentioned fields remain unchanged unless an explicit derived rule says otherwise.

Scenario: swap two fields; fail one validation; concurrently read the record. The rollback case must not publish a committed change fact.

### L4 — Event provenance and retry identity

A committed mutation produces its specified implicit facts with stable logical identity. Retrying delivery preserves that identity. Do not universalize exactly-once external effects: state adapter-specific idempotence assumptions and retention windows.

Scenario: crash after commit and before acknowledgment, retry, then reconnect a listener. Check the outbox/runtime integration, not upstream queue internals.

### L5 — Maintained relationship equivalence

At a completed logical epoch, incremental query results equal full recomputation for the supported query fragment. Supporting-path changes must not duplicate recipient identity.

Scenario: a person qualifies through two memberships; remove one, then the other. Replacing a supporting path may change explanation without causing a new message. State set/bag semantics and recipient snapshot policy.

### L6 — Scoped interop

Delegated authority cannot exceed the parent handle's authority. Capability expiry prevents later mediated invocations; it does not undo already committed effects.

Scenario: a widget receives read-only access to one record and attempts mutation/enumeration. A type-only wrapper is not sufficient evidence against arbitrary in-process code; name the enforcement boundary.

### L7 — Interaction lifecycle preservation

An adapter advertising a capability preserves its normalized semantic interactions, ownership and cleanup. Platform layout and gestures may differ.

Scenario: open documents A/B, focus B, close B; restore valid focus and release B's subscriptions. A late response for a closed/obsolete generation cannot replace the current selection. Separate focus/accessibility/native integration checks from pure state-model tests.

### L8 — Explanation fidelity

Every explanatory fact resolves to a declaration, trace, verified result or labeled assumption. Presentation cannot create causation or upgrade evidence strength.

Scenario: after commit, two branches run independently. Show them concurrently or explain their independence while narrating serially. A static possible edge cannot be labeled an observed execution.

### L9 — Evidence binding

Evidence is valid only for its exact law, semantic profile, artifacts, assumptions and dependency versions. A changed law/body/adapter invalidates affected evidence. Unknown, tool failure and unsupported constructs never become proof success.

Scenario: inject a timeout, exclude a foreign call, alter integer overflow semantics and weaken a precondition. Verify distinct diagnostics and invalidation.

## Verification strategy

- Start with a deterministic reference interpreter for a small core, injectable clock/randomness/external responses and replayable schedules.
- Use generated values and command histories with shrinking. Persist the seed, generator version and minimized trace.
- Model-check bounded workflow/concurrency fragments; report exact bounds and completeness/reduction assumptions.
- Generate Lean definitions/obligations from the same typed core. Check proofs and enumerate axioms; a trusted translation remains a declared gap until correspondence is established.
- Evaluate Bend 2 as another proof/execution target and law-authoring precedent; evaluate Lynx's shallow embedding approach. Do not require runtime migration to either.
- Every law gets a non-vacuity witness and deliberate bad implementation that it should detect. These checks improve the specification but do not prove it complete.

Full result taxonomy and adapter fields: [verification memo](../research/verification.md#proposed-verification-adapter-contract).
