# Shared executable semantics — adapter contract v1

Status: implemented bounded reference interpreter, not a general language compiler.
Ownership: this directory and `docs/semantic-core.md` only. No existing live app
integration, inventory app, Effect dependency or Lean output is implemented here.

## Import and use

Browser and Node use the same dependency-free ES module:

```js
import {createInterpreter} from './core.ts';
import {issueModel, issueState} from './issues.ts';

const runtime = createInterpreter(issueModel);
const invocation = {
  id: 'request1', action: 'issue.resolve', args: {issueId: 'i1'},
  actor: 'maya', clock: 1730000000000,
};
const result = runtime.execute(issueState, invocation);
if (result.status === 'committed') {
  // Atomically publish result.state and retain result.events in the host.
}
```

Types are in `types.ts`.
`issues.ts` is an executable second-domain consumer, independent of `live/`.
Tests edit its declarations and observe different state transitions.

## API

| API | Contract |
| --- | --- |
| `jsonSnapshot(value)` | Validate bounded strict JSON, copy and deep-freeze; throws on invalid data. |
| `validateModel(source)` | Validate **all** declarations and expression types; returns a copied frozen model or throws. No unreachable-code exemption. |
| `validateState(model, source)` | Validate both model and exact state schema; returns copied frozen state or throws. |
| `createInterpreter(model)` | Validates/copies/freezes model once; throws for unsupported/invalid model. Returns `model`, `prepare`, `commit`, `execute`. |
| `prepare(state, invocation)` | Returns `{status:'prepared', prepared}` or pending/rejected. Evaluates the entire candidate; publishes neither mutation nor events. |
| `commit(currentState, prepared)` | Returns committed or rejected. Only opaque tokens from this exact interpreter are accepted. Revalidates full current state against captured prestate. |
| `execute(state, invocation)` | `prepare` followed by `commit` against that same state; pure synchronous single-step convenience. |

Results:

- `committed`: `{status, state, events}`. State/events are new deep-frozen JSON.
- `pending`: `{status, policyIds, state}`. No token, events or mutation. Not an
  approval workflow: no approval grant, resumption, inbox or bypass exists.
- `rejected`: `{status, code, reason, state}`. No token/events/mutation. The reason
  is diagnostic text, not a versioned machine protocol; use `code`.
- Pending/rejected return the **original caller state reference**, without copying
  or freezing it. Their wrapper is frozen. Invalid state is never laundered into
  an accepted snapshot. Caller-owned objects are never mutated or frozen.

Current rejection codes: `invalid`, `schema`, `missing-record`, `denied`,
`precondition`, `overflow`, `conflicting-update`, `routing`, `invalid-token`, `stale`.
The internal evaluator also guards unknown operators as `unsupported`; validated
models cannot reach that branch. Invalid models throw before an interpreter exists.

## IR: exact structures

All listed properties are required unless explicitly optional. Unknown properties,
operators, schema constraints, formats and references fail closed. Empty lists/maps
are allowed; no policy match is **deny**, not allow.

```text
Model = {
  format: "semantic-core/v1", id: SemanticID,
  resources: {[ResourceID]: {fields: {[FieldName]: Schema}}},
  relationships: [{id: SemanticID, resource: ResourceID, field: FieldName}],
  actions: {[ActionID]: {
    inputs: {[InputName]: Schema},
    bindings: [{id: SemanticID, resource: ResourceID, key: Expr}],
    preconditions: [{id: SemanticID, when: Expr}],
    policies: [{id: SemanticID, when: Expr,
                effect: "allow" | "deny" | "approval-required"}],
    updates: [{id: SemanticID, target: BindingID, field: FieldName, value: Expr}],
    observe: [{binding: BindingID, relationship: RelationshipID}]
  }}
}
State = {revision: NonnegativeSafeInt, records: {
  [ResourceID]: {[RecordKey]: {
    version: NonnegativeSafeInt,
    values: {[FieldName]: string | SafeInt | boolean | RecordKey[]}
  }}
}}
Invocation = {id: InvocationID, action: ActionID, args: {[InputName]: Value},
              actor: RecordKey, clock: NonnegativeSafeInt}
```

Model/resource/action/binding/relationship/precondition/policy/update IDs are
globally unique within a model. Field/input names are local. All object keys and
identity strings use `[A-Za-z][A-Za-z0-9_.:-]*`, except `constructor` and `prototype`
are reserved (and `__proto__` is disallowed). Scalar string values need not be IDs;
binding keys, actor, invocation IDs and relationship recipients must be IDs.
IDs are supplied by declarations/caller, never inferred from array positions.
Preserve IDs when editing the same semantic entity; version the model ID when
changing its contract. IDs alone are **not content hashes**: bind evidence to the
complete declaration and adapter version, not just `model.id`.

There must be exactly one collection per declared resource, exactly the declared
fields on every record, and exactly the declared input arguments. No optional
values, defaults, implicit coercion, nullable values, foreign code, inserts,
deletes, loops, joins, filters or dynamic property access exist in v1.

Schemas:

```text
{type: "integer", min?: SafeInt, max?: SafeInt}
{type: "string", enum?: nonempty distinct string[]}
{type: "boolean"}
{type: "ids"}  // dense array of identity strings; duplicates allowed
```

Schema types must match update expression types statically; schema bounds and
enums are checked dynamically. String literals cannot stand in for integer
values. `ids` can be copied from an input/field but has no literal constructor or
equality operator. Relationships read `string` or `ids` fields; they are not
foreign-key integrity constraints and recipients need not have resource records.

## Expressions and evaluation

```text
{op: "literal", value: string | SafeInt | boolean}
{op: "input", name: InputName}
{op: "actor"}                         // string
{op: "clock"}                         // integer, caller supplied
{op: "field", binding: BindingID, field: FieldName}
{op: "not", value: BoolExpr}
{op: "add" | "sub", left: IntExpr, right: IntExpr}  // integer
{op: "lt" | "le", left: IntExpr, right: IntExpr}    // boolean
{op: "eq", left: ScalarExpr, right: ScalarExpr}     // same scalar type
{op: "and" | "or", left: BoolExpr, right: BoolExpr} // boolean
```

No other operators exist. `and`/`or` are **eager**, left then right, not
short-circuiting; an overflowing RHS rejects even if the LHS determines the
boolean result. Record binding keys can use inputs/literals/actor (and well-typed
expressions over these), but **no field expressions**, including earlier bindings.
Every binding resolves an existing record from the immutable prestate.

All numeric inputs, literals, stored numbers and intermediate results are integers
in `[-9007199254740991, 9007199254740991]`. Negative zero, fractional/nonfinite
numbers and unsafe integers are rejected. `add` and `sub` use transient BigInt
arithmetic and reject overflow before conversion to Number; BigInt is never in IR
or outputs. Revision/version increments also reject overflow. There is no implicit
wrapping, saturation, float arithmetic, multiplication, division or randomness.
Clock is an explicit nonnegative safe integer input with application-defined unit;
the runtime never calls `Date.now` or assumes monotonicity.

## Execution order and atomicity

1. Validate/copy state and invocation, validate exact input schemas, resolve bindings.
2. Evaluate all policy guards. Any matching deny wins; no matching allow/approval
   is denial. A matching approval prevents commit even alongside matching allow.
3. Check preconditions in declaration order; report the first failure. Thus a
   failed precondition returns rejected rather than pending, even if review would
   otherwise be required. Policies and preconditions remain separate declarations.
4. Return pending if required. No candidate writes/events are produced.
5. Evaluate every grouped assignment against **the same prestate**, validating
   each resulting field. Detect two assignments to the same physical field even
   through different bindings: reject rather than choose last writer.
6. Copy and apply all assignments atomically; increment each written record's
   version once and global revision once, including no-op assignments. Empty
   update lists still increment revision and emit a committed action fact.
7. Derive recipients from observed relationship fields in the **poststate**, exclude
   actor, deduplicate recipients and supporting paths, sort deterministically.
8. Capture an opaque preparation token. Commit validates current state then
   compares the entire state (including all record versions/revision) with captured
   prestate using key-order-independent canonical equality. Reject any difference.
   Unchanged immutable model/invocation/prestate imply the same authorization and
   preconditions; these cannot be silently substituted at commit.

Any failure leaves every supplied object untouched and publishes no committed
events. One invalid field/routing recipient/version increment rejects the whole
group. This is deterministic synchronous derivation, **not** a database isolation
or external-execution guarantee.

## Events and routing

Commit emits one `action` fact and one `change` fact per assignment whose JSON
value actually differs. Change facts identify the update declaration as
`semanticId`, plus `resource`, `key`, `field`, `before`, `after`. All events carry
`modelId`, `actionId`, `invocationId`, `actor`, explicit `clock`, resulting global
`revision`, and the same recipient snapshot:

```text
[{recipient: ID, paths: [{relationship: SemanticID, resource: ResourceID, key: ID}]}]
```

Fact IDs are `event:<escaped-invocation-id>:action` or
`event:<escaped-invocation-id>:change:<escaped-update-id>`, where escaping is
`encodeURIComponent`. Declaration order orders changes, not an invented causal
sequence: all changes belong to one atomic group. Multiple support paths produce
one recipient with all unique paths; relationship routing is one-hop full
recomputation, not incremental maintenance or bidirectional propagation. No
explicit business-event mechanism, transport, notification record, delivery retry
or outbox is implemented. Poststate routing may include newly assigned recipients;
it does not notify former recipients unless another declared path retains them.

## Inventory/host instructions

Declare resource fields, bindings to existing records, numeric preconditions and
grouped assignments in JSON. There are no inventory-specific opcodes. For example,
represent capacity as an integer field; declare `amount >= 1` in the input schema,
`amount <= capacity` as a precondition and `capacity - amount` as an update. Put
authorization in policies, not in that precondition. Bind multiple records for a
transfer; all RHS expressions use the original values. Initialize records in the
host's initial state; insertion is outside this profile.

Store `currentState` in the host. For optimistic work:

```js
const p = runtime.prepare(currentState, invocation);
// Work may interleave here. No mutation/events have been published.
if (p.status === 'prepared') {
  const c = runtime.commit(currentState, p.prepared); // MUST pass latest state
  if (c.status === 'committed') currentState = c.state;
  // Persist state and events in one host transaction before delivery.
}
```

The host must make **read-current + commit + replace-current + outbox persistence**
one atomic publication boundary, using compare-and-swap/transactional storage when
there is concurrency. Passing the old state again is a deliberate stale-read
mutant, not a safe use of the API; the test suite demonstrates its lost-write
outcome separately. Tokens are interpreter-bound WeakMap capabilities, cannot be
serialized, and do not lock anything. They can be reused against the same
prestate for pure branching/replay. No durable token consumption/deduplication
ledger exists. The host must enforce globally unique invocation IDs (including
across models/workspaces) or scope event IDs externally, deduplicate retries,
authenticate the actor and validate the clock. An actor string is not authentication.

## Effect adapter instructions

Wrap these functions rather than reimplementing updates in action-name switches.
Keep invalid-model exceptions, rejected, pending and committed outcomes distinct;
do not turn pending into success or automatically grant approval. Provide clock
input explicitly as an environment value. A storage service must implement the
atomic publication boundary above, including rollback/no emitted committed facts
on failure. Observe the exact poststate routing snapshot. Any external delivery,
retry, cancellation, failure and idempotence behavior belongs in the adapter's
versioned contract. This module contains **no Effect integration** or claims about
Effect's runtime.

## Lean adapter instructions: restricted numeric fragment

Start with integer-only fields/inputs and statically named records/bindings, and
guards over `literal(integer/boolean)`, `input`, `clock`, `field`, `add`, `sub`,
`lt`, `le`, integer/boolean `eq`, `not`, `and`, `or`. Actor/policy decisions can be
explicit model inputs only if that restriction is declared; do not silently erase
string authorization/routing from a theorem about the full action. Keep stable
declaration IDs on generated definitions and obligation metadata.

Translate finite resource/record/field maps, versions and revision explicitly.
Use Lean `Int` for signed values with the safe-range predicate and nonnegative
version/clock predicates. Each arithmetic operator returns success or overflow,
checking its intermediate range, not merely the final expression. Translate
eager boolean evaluation and error results; unbounded mathematical integer
execution is a **different semantics**. Preconditions and policy outcomes are
separate from transition equations. Grouped assignments read the original record
map, enforce non-aliasing, validate destination bounds and increment versions.
Model stale commit as equality of full snapshots unless explicitly proving a
declared weaker read-set profile. Do not prove only a per-record postcondition and
claim concurrency correctness.

Unsupported schemas/operators/relationships must return **unsupported**, not be
omitted or modeled as successful no-ops. Bind evidence to full IR content,
semantic-core/v1, adapter version, theorem/assumptions and Lean version. Include
positive witnesses, overflow/grouping/stale counterexamples and executed
cross-checks against this interpreter. A generated/checked theorem proves its
generated model; translation/runtime correspondence remains a separate gap. No
Lean generation, proof, actual Effect execution or correspondence proof is
provided by this milestone.

## Verification

Run `node --test semantic/*.test.ts`. These are tests of this mapping/interpreter,
not copies of upstream suites. Browser compatibility is by dependency inspection
(ES modules, standard JSON/Map/WeakMap/BigInt), not a browser execution claim.
JSON input is bounded to depth 40, 100000 nodes and 100000 UTF-16 code units per
string. Prototype-bearing exotic objects, accessors, symbol/nonenumerable object
properties, sparse arrays, cycles and lossy numbers are rejected. These limits and
trusted JS intrinsics are implementation boundaries, not a sandbox for arbitrary
same-process executable code.
