# Syntax ergonomics: implemented bounded sugar

**Decision:** organize the actual language, not conceal repetition with HTML folds.
The production source remains `leave/time-away.domain`; no language name is chosen.
Resources group fields; actions group inputs, bindings, preconditions, eligibility
policies, atomic changes and observation paths. Legacy singular syntax still parses.
The whole-file reader now shows all source continuously, including data and IDs.

## Types and validation can grow vertically

This exact excerpt is in the executed non-leave fixture
[`syntax/fixtures/schema-groups.domain`](../syntax/fixtures/schema-groups.domain):

```domain
resource supply
  fields
    title string
    balance
      type integer
      min 0
      max 30
    end
    status
      type string
      enum "ready" "held" "spent"
    end
    manager string
  end
end
```

The inline equivalent of balance is `balance integer min 0 max 30`; enum likewise
supports several quoted values inline. Tests compare expanded and inline full IR,
execute 30 successfully and reject -1, 31 and unknown enum values at runtime.
This is the existing value-schema contract, not an arbitrary validator language.
Cross-field comparisons belong in preconditions. Custom callbacks, regex, database
queries and arbitrary validation dependencies remain unsupported.

## What was duplicated in relationships?

The old declaration had two distinct pieces: a stable semantic ID (e.g.
`"employee.manager"`) and the source recipient field (`employee.manager`). They
coincided by convention. A grouped `employee.manager` row now derives that exact
ID; `supply.manager id "supply.supervisor"` shows the explicit override in the
executed fixture. This is **an observer recipient field**, not a foreign-key,
join, inverse, cardinality or referential-integrity constraint.

Declaring a relationship sends nothing. Actions select paths in `observations`;
the existing runtime derives implicit action/change/create facts and recipient
snapshots (poststate for surviving/inserted records, actor excluded). Application
SSE broadcasts full snapshots to local clients independently—it is not these
recipient-specific notifications or a delivery guarantee.

## Which inputs derive?

This exact excerpt is in the migrated time-away action:

```domain
  inputs
    employeeId string
    leaveId string
    start like leave.start
    end like leave.end
    days like leave.days
  end
```

`like` copies schema, never values or intent. `days like employee.balance` would
copy min 0, not the required min 1: therefore it is not inferred. Likewise
`threshold like settings.threshold` copies its min 1. Caller inputs and computed
insert/update expressions are different categories; not every field becomes an
input. Actor, operation-ID and clock host bindings already hide server-owned
inputs when explicitly configured. Time-away explicitly maps actor and operation
ID; its named `utc-weekday-range/v1` adapter computes days from dates and hides it.
The adapter's real-calendar/weekdays/range rules are trusted framework behavior,
not the date-unaware core's static analysis. No automatic inference expands access.

## Are actions checked against resources?

**Yes, within this profile**, by parser checks plus authoritative v2 and application
validation (`semantic/v2/core.ts`, `application/derive.ts`):

- Declared binding resources, input names, bound fields, update targets and selected
  relationship paths must exist. Observation resource/path compatibility is checked.
- Binding/insert keys are string expressions without bound-field reads. Inserted
  aliases cannot be used as expression/update bindings. Every insert field must
  be present, with no extras.
- Expressions are checked for primitive operand/result types, including boolean
  guards, string/ids approvers, and compatible update/insert target types. Schemas,
  initial values, presentation references/defaults/widgets and adapters are checked.
- **Not refinement proofs:** integer type compatibility does not prove an expression
  stays inside min/max or a string expression stays inside an enum. Invocation
  schemas and candidate resulting field values are validated at runtime. Missing
  records, identity validity, overflow, physical alias collisions and routing values
  also have runtime checks. Failed candidates roll back the whole atomic group.

Preconditions express business requirements (e.g. sufficient balance); policies
express eligibility/approval. No matching allow/approval is still denied, matching
deny still wins, and approval cannot be bypassed by allow. Grouping adds no default
authority. `changes` visually collects update/create while all RHS expressions
retain immutable-prestate evaluation, not sequential assignment semantics.

## IDs, parity and evidence

Only uniquely specified IDs derive: relationship `resource.field`, binding
`actionId.alias`. Explicit overrides are supported; collisions fail. Existing
time-away binding IDs differ from that convention, so retain explicit annotations.
Policy/precondition/change IDs remain explicit to avoid inventing durable identity.

Full deep equality against `syntax/fixtures/prior-leave.ts` covers domain, initial
state and presentation, including ordering and IDs. A persisted prior-model pending
request reopens/grants/resumes under the migrated source. Source mutation tests now
target the real grouped syntax and retain their original assertions. Browser mapping
tests still add a real enum input and change threshold 3→2, then check generated
form, captured invocation, pending, grant/resume and balance 5→3. Reader tests assert
every original line is present and visible at desktop/tablet/mobile widths.

No v2/core or application authority laws changed. This evidence is tested mapping,
not a proof of parser correctness, full ORM, custom-validator support, authenticated
identity, external delivery, deterministic I/O or formal resource refinements.
Read depth: local documentation and selected validator/derivation/frontend source;
independent test execution, no external research or new proof audit.

Executed November 14, 2026: full suite **225/225**, syntax suite **56/56**,
strict actual-source lint **0 errors / 0 warnings**, all three requested browser
scenarios passed. Desktop/action/mobile screenshots were inspected. Per-app source
counts include the real 185-line `.domain` file: **206 physical lines** including
bridge and optional launcher, not a claim that the application is only 10 lines.
## Reserved block terminator

A bare `end` on its own line closes a block. To give a field named `end` an
expanded schema, write its name as `"end"`, followed by the indented schema and
closing `end`. The inline `end string` form is unambiguous and remains accepted.
Both forms produce the same field schema; quoted names do not change identity.
