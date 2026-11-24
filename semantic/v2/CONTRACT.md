# Lifecycle and approval core — adapter contract v2

Status: implemented bounded reference profile, not a durable engine or authentication
system. Import `semantic/v2/core.mjs`; declarations are in `core.d.mts`.
This is an **opt-in new profile** (`semantic-core/v2`). v1 is neither modified nor
automatically migrated. Its existing adapters and Lean evidence still describe v1,
not this profile. No v2 theorem or runtime/proof correspondence is claimed.

## Exact model extension

Use v1's exact Model, State, Invocation, Schema and Expr structures from
[`../CONTRACT.md`](../CONTRACT.md), with these explicit replacements/additions:

```text
Model.format = "semantic-core/v2"
Action = {
  inputs, bindings, preconditions, policies, updates, observe, // all required
  inserts: [{id: SemanticID, resource: ResourceID, key: Expr,
             values: {[EveryDeclaredField]: Expr}}],
  deletes: [{id: SemanticID, target: ExistingBindingID}]
}
Policy = {id: SemanticID, when: BoolExpr, effect: "allow" | "deny"}
       | {id: SemanticID, when: BoolExpr, effect: "approval-required",
          approvers: StringExpr | IdsExpr, allowSelfApproval?: boolean}
Observation = {binding: ExistingBindingID | InsertDeclarationID,
               relationship: RelationshipID}
```

All arrays above are required, including empty `inserts`/`deletes`. Approval
policies must declare `approvers`; allow/deny policies cannot declare approvers or
self-approval options. All IDs, including insert/delete IDs, are globally unique.
Unknown members/operators, malformed/ill-typed unreachable declarations, incomplete
or extra fields fail closed. There are no inventory-specific opcodes.

Schema types, strict JSON bounds/identity restrictions, safe-integer arithmetic,
eager booleans and expression operators are exactly the v1 profile's rules. The
implementation imports only v1's public `jsonSnapshot`; v2 explicitly implements
its own schema/expression validation, evaluation and transitions (adapted from v1).
It does not lower v2 lifecycle or approval into a rewritten v1 model.

## Lifecycle law

Bindings resolve existing records from immutable prestate. Insert keys are explicit
caller/declaration expressions of type string and cannot contain field expressions,
just like binding keys. Keys must be valid identity strings; no ID generation,
implicit defaults, upsert or replace exists. Every inserted field is required, and
every insert/update RHS reads the same immutable prestate. Insert declarations
cannot be field-expression bindings, nor update/delete targets; their IDs may be
used only for observation. An insertion starts record `version: 0`.

The entire group rejects for an existing insert target, missing bound/delete
target, duplicate insert/delete target (including aliases), insert/delete collision,
or update/delete collision. Deleting and reinserting the same key in one group is
not replacement. Duplicate writes to one physical field reject through aliases;
distinct fields of one aliased record are allowed. No assignment order wins.
Runtime target checks occur after authorization/preconditions/approval; a pending
request is not a promise that its eventual transition is valid.

Updated records increment version once even on no-op assignments. Inserts begin
at zero, deletes remove records without incrementing their former version. Every
committed action increments global revision once, including an empty or no-op
group. Revision/version overflow, invalid resulting field or routing recipient
rejects the entire group, without mutation/events. Deleting a record at max version
is allowed if global revision can advance. Reusing a deleted key in a later action
is allowed; the global revision/full-state binding prevents stale-token ABA.

## Facts and recipient snapshots

Each commit emits `action`, then changed-field `change` facts in update declaration
order, then `create` facts in insert order, then `delete` facts in delete order.
These are a single atomic group, **not a causal sequence**.

- `action`: v1 common metadata and `semanticId: actionId`.
- `change`: common metadata, update `semanticId`, `resource,key,field,before,after`.
- `create`: common metadata, insert `semanticId`, `resource,key,after`, where `after`
  is the complete `{version:0,values}` record.
- `delete`: common metadata, delete `semanticId`, `resource,key,before`, where
  `before` is the complete prestate record including its version.

Common metadata is `id,modelId,actionId,invocationId,actor,clock,revision,recipients`.
IDs are `event:<encodeURIComponent(invocation.id)>:action`, or
`event:<escaped-invocation-id>:<change|create|delete>:<escaped-declaration-id>`.
Event identity does not include model ID: hosts must scope/deduplicate invocation IDs.

All facts share one recipient snapshot: observations of surviving/inserted records
use **poststate** fields; observations of deleted records use **prestate** fields.
Thus deletion can notify former owners, while ordinary owner reassignment only
notifies new owners unless another declared path retains old owners. Path shape
remains `{relationship,resource,key}`; recipients and paths deduplicate and sort
canonically, excluding the invocation actor. Snapshot paths may point to a now
deleted record. Delivery-time membership/revocation is outside this core.

## Exact runtime API

```js
const rt = createInterpreter(model);
rt.model;
jsonSnapshot(value);                 // frozen strict JSON copy or throws
validateModel(source);               // frozen Model or throws
validateState(model, source);        // frozen State or throws
rt.prepare(state, invocation);       // PreparedResult | Pending | Rejected
rt.commit(latestState, prepared);     // Committed | Rejected
rt.execute(state, invocation);        // Committed | Pending | Rejected
rt.approve(request, {policyId, approver}); // Approved | ApprovalFailure
rt.prepareResume(latestState, originalInvocation, request, receipts, {clock});
                                    // PreparedResult | Rejected
rt.resume(latestState, originalInvocation, request, receipts, {clock});
                                    // Committed | Rejected
```

`execute` is prepare + commit against the supplied state. `resume` is
prepareResume + commit against the supplied state. Use `prepareResume` when storage publication
requires an optimistic interleaving boundary; commit **must receive latest state**.

```text
PreparedResult = {status:"prepared", prepared: OpaqueToken}
Pending = {status:"pending", policyIds: PolicyID[], request: ApprovalRequest,
           state: OriginalCallerStateReference}
Rejected = {status:"rejected", code:string, reason:string,
            state: OriginalCallerStateReference}
Committed = {status:"committed", state: FrozenState, events: FrozenFact[]}
Approved = {status:"approved", receipt: ApprovalReceipt}
ApprovalFailure = {status:"rejected", code:string, reason:string}
ApprovalRequest = {
  format:"semantic-approval-request/v2",
  model: FullFrozenV2Model,
  invocation: FullOriginalInvocationIncludingCapturedClock,
  prestate: FullFrozenStateIncludingRevisionAndAllRecordVersions,
  requirements:[{policyId:ID, approvers:ID[], allowSelfApproval:boolean}]
}
ApprovalReceipt = {
  format:"semantic-approval-receipt/v2", request: FullApprovalRequest,
  policyId:ID, approver:ID
}
```

Request/grant/options/receipt objects have exactly these members; no implicit
defaults for omitted API arguments. Requirements follow policy declaration order;
eligible approvers are deduplicated, sorted and filtered to remove the actor unless
`allowSelfApproval:true`. An empty eligible set stays pending and cannot be granted.
One eligible approver per matching approval policy suffices; every matching policy
needs its own receipt. Duplicate policy receipts and unrelated receipts reject.
No bulk/self override exists. `approve` checks original model, policy context and
eligibility; it has no current-state argument and does not claim freshness at grant
time. Resume/commit are the freshness boundary.

Pending/rejected wrappers are frozen, but their state is the untouched original
reference (possibly malformed); it is never frozen or laundered into valid state.
Requests/receipts and successful state/facts are copied/frozen strict JSON; they can
roundtrip through JSON and survive interpreter restart. Tokens cannot: they are
WeakMap capabilities belonging to the exact interpreter instance. Wrappers contain
no committed facts or token on pending/rejection. Preparation publishes nothing.

Rejection codes include v1's `invalid,schema,missing-record,denied,precondition,
overflow,conflicting-update,routing,invalid-token,stale`, plus `existing-record`,
`approval` (invalid approver expression, missing/duplicate receipts) and
`unauthorized-approval` (ineligible grant/receipt). `unsupported` is the defensive
unknown-expression branch; validated declarations cannot reach it. Diagnostics
are not stable protocol; switch on `status`/`code`. Invalid model construction
throws; transition/grant API validation failures return rejected.

## Approval law and resume clock

1. Validate exact state/invocation, bind prestate records, evaluate all policy
   guards. Matching deny wins. No matching allow/approval is denied.
2. Evaluate preconditions; failure rejects before pending. Evaluate matching
   approver expressions against this same model/actor/args/clock/prestate context.
3. If approval policies match, return pending and the complete request. Even a
   simultaneous allow cannot bypass approval. No candidate writes/events occur.
4. `approve` reconstructs that original pending context and checks an eligible
   identity for the specified policy; returns the bound serializable receipt.
5. Resume validates the request by reconstructing its original context. Require
   full model content, full original invocation and full latest prestate to equal
   their captured snapshots (canonical key-order-independent equality). Changing
   even unrelated model/state content invalidates old evidence. Never patch a
   stale request and reuse its receipt; start a new pending request/grant.
6. `{clock}` is **required**, a nonnegative safe integer at least the captured
   invocation clock. The original invocation argument must still equal the captured
   one, including its old clock. Reevaluate policy guards, approver expressions,
   preconditions and all transition expressions using the **resume clock**. Denial
   or failed precondition rejects. The resulting approval requirements must equal
   the captured requirements exactly, even if a guard ceased requiring approval
   while an allow remained. Changed requirements reject stale; no downgrade to
   allow occurs. Events carry the resume clock, not the captured clock.
7. Validate all receipt bindings/eligible approvers, require coverage of every
   matching approval policy, then derive the grouped candidate with unchanged
   policies. Commit compares the complete latest state again.

Equal deterministic inputs give equal derivation. The runtime never reads the
wall clock, authenticates identities, performs I/O, or modifies policy declarations.
Clock progression has no implicit timeout; expiry must be a declared guard or
precondition. Once prepared, the resume clock is captured in the token: commit
does not read a new time. Hosts needing expiry at publication must reprepare at
their publication clock rather than hold tokens across time boundaries.

## Trusted host / durable-agent obligations

**Requests and receipts are data, not authentication or signatures.** A hostile
caller can fabricate eligible receipt JSON or create a new independently valid
request. The core cannot distinguish that from an actual approved host record.
The trusted host must authenticate invocation actor and approver; persist the
original request and grant ledger; permit approval only through authorized host
operations; pass only receipts retrieved from that trusted ledger to resume;
verify user-supplied references against persisted content; and supply a trusted
clock. Never accept arbitrary client receipt JSON as authority.

Persist state replacement + invocation deduplication + outbox facts atomically
with latest-state compare-and-swap. Persist request/grant status atomically as
needed for the durable workflow. Tokens, requests and receipts are not consumable
by this pure core: the host owns one-shot consumption, cancellation, retries,
grant revocation, cross-workspace scoping and ledger security. Equal old prestate
can be replayed for pure branching; passing old state is not safe publication.
No durable storage, scheduling, transport, external exactly-once execution,
reactive propagation, business facts or v2 verification adapter is implemented.

## Evidence and implementation boundaries

`node --test semantic/v2/*.test.mjs semantic/*.test.mjs` exercises the new mapping
and the unchanged v1 core. v2 tests cover lifecycle grouping/rollback/aliasing,
snapshots/no-ops/version bounds, malformed IR, approval outcomes, unauthorized and
self grants, serialization/restart, exact binding invalidation, fresh-clock policy
checks, no bypass and a positive resumed lifecycle commit. These are executed
examples, not exhaustive proofs. Strict declarations are checked using local `tsc`
against `types.test.mts` (see `docs/semantic-v2.md`).

Read depth: full local README, v1 contract, design brief and selected v1 runtime/
declarations; independent execution of the tests, no proof audit. The inherited
strict JSON limits (depth 40, 100000 nodes/string units) also apply to whole request
and receipt envelopes, so a deeply nested valid standalone model may exceed an
approval-envelope limit and reject. Trusted JS intrinsics are assumed; this is
not a sandbox for executable same-process adversaries or malicious prototypes.
