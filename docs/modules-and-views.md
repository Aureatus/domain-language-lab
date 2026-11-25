# Modules, references and three views

Status: implemented bounded text modules and generic HTTP CLI for the experimental
time-away slice. Not a general package system, production compiler or native renderer.

## Source layout

| Source | Responsibility |
|---|---|
| `leave/time-away.domain` | Resources, relationships, actions and policies only |
| `leave/demo.domain` | Explicit demonstration records; imports/uses the domain |
| `leave/browser.domain` | Browser presentation, actors and named host input mappings |
| `leave/cli.domain` | Explicit alternative CLI presentation declaration |
| `leave/mobile.domain` | Explicit alternative mobile presentation declaration |
| `leave/model.ts` | Compatibility bridge loading **browser.domain** |

All three view entries directly import/use the **same domain** and import the same
demo module. Tests compare their entire domain and initial state, not only their
names. No policies are copied into a view. They may vary labels, columns and order.
View declarations are alternative presentation projections; they are not three
independent databases. `npm run leave:cli -- list` loads `cli.domain` for presentation,
checks exact full domain identity against the backend, and consumes the backend's
served contract including its host input mappings. It does not execute local actions
or treat `cli.domain` as an alternative authorization authority. Likewise a mobile renderer
must connect to the running backend rather than launch a separate demo server.
This change does not implement or claim a native renderer.

```domain
module "time-away-mobile" view
import "./time-away.domain"
import "./demo.domain"
use "time-away"
```

`module "ID" domain|data|view` declares a bounded role. Imports are explicit
relative `.domain` paths, resolved from the importing file, canonicalized using
real paths. `use` names a **directly imported domain module**. Dependencies are
visited in written order, once per canonical path; cycles, duplicate imports,
duplicate module IDs and semantic declarations, missing paths/use targets, and
role-inappropriate declarations reject. Domain modules contain domain declarations,
data modules contain initial records, and view modules contain application metadata.
The closed graph is composed before existing model/state/application validation.
There is no `eval`, JavaScript import, remote import, wildcard, export namespace,
package search, override/merge or executable module initialization. A legacy
single-file domain/initial/application declaration is still accepted.

Each semantic span maps to the actual file and local byte-string offset/line/column
(offsets are JavaScript UTF-16 string positions, not encoded UTF-8 byte positions).
Imported headers are blanked without changing lengths before composition. Errors
are remapped to the originating file. Some core-wide validation failures still
point to the domain header rather than the exact offending expression.

## Implicit record references, not identifier guessing

```domain
resource settings singleton key "leave-rule"
```

This declares an exact selector, **not** “the first settings record.” It remains
outside the runtime resource schema. Missing selected records reject at execution.
Additional settings records do not change the declared key. There is no implicit
global scan or assumption that the initial data will always contain one record.

```domain
action "leave.request" identity request
  inputs
    employeeId reference employee as employee
    leaveId string
    start like leave.start
    end like leave.end
    days like leave.days
  end
```

`employeeId` remains a wire-level string, but its **explicit reference type** names
the resource and expression alias. `employee.balance`, `employee.manager`, update
targets and observation subjects lazily materialize the needed binding. A plain
`employeeId string` never implies an employee lookup. Unknown resources/aliases and
ambiguous aliases (including reference/singleton collisions) reject, even if the
duplicate declaration would not be used. An unused typed reference adds no lookup.
Explicit `bind`/`bindings` remain available for complex keys; no arbitrary query
inference is implemented. The input reference form, not an action-subject form,
is the implemented authoring path.

`identity request` preserves `request.employee` and `request.settings`; the settings
action uses `identity edit` to preserve `edit.settings`. Without an explicit prefix,
the action ID is the prefix. `bindingOrigins` records derived binding IDs, aliases,
identity prefixes, reference/selector kinds and lowered keys, separately from IR.
The independently fixed prior fixture is exactly equal to the complete new browser
declaration and derived contract. Existing SQLite pending requests are tested
across the old-model/new-loader reopen and can still be granted/resumed. No model
migration or changed-model parity is being claimed.

Lowering creates the existing core binding nodes; policies, preconditions, inserts,
updates and relationship observations use those IDs. Bindings therefore remain in
the core read/prestate dependency boundary. Record lookup grants no authority:
the core still checks owner denial, manager policies, approval requirements, grouped
updates and full-state stale/consumed rejection. Exact IR equality also preserves
the existing all-bindings-before-guards execution order, rather than introducing
conditional lazy **runtime** reads. “Lazy” here describes elaboration only.

## Run browser and CLI on one HTTP/database host

```sh
# Terminal 1: persistent existing leave database; default http://127.0.0.1:4174
npm run leave

# Terminal 2: reads and writes against that exact host, not another local model
npm run application:cli -- list --url http://127.0.0.1:4174
npm run application:cli -- inspect leave.request
npm run application:cli -- preview leave.request --actor maya \
  --args '{"start":"2026-11-23","end":"2026-11-25"}'
npm run application:cli -- execute leave.request --actor maya \
  --args '{"start":"2026-11-23","end":"2026-11-25"}' --json
npm run application:cli -- inbox --actor sam --json
npm run application:cli -- grant REQUEST_ID --actor sam --policy leave.manager-approval
npm run application:cli -- resume REQUEST_ID --actor sam
npm run application:cli -- list employee

# Same generic CLI, with the explicitly imported CLI view's presentation:
npm run leave:cli -- list
npm run leave:cli -- inbox --actor sam --json
```

`APPLICATION_URL` or `--url` selects the backend; no separate CLI database exists.
Generic `application:cli` also accepts `--view PATH.domain`. It validates the view,
then recomputes the server's existing contract hash from the local normalized full
domain plus the **served** contract. Mismatched domain IDs, actions, updates or
policies reject before any command is sent. Local labels can differ, but visible
arguments, hidden bindings and adapters always come from the backend contract.
`--actor` is required for preview/execute/grant/resume. `list` and `inspect` derive
commands, schemas and visible arguments from `GET /api/contract`; `--args` is a JSON
object, not application-specific flags. Do not submit hidden employee/operation IDs;
the backend supplies them and computes days through the declared named host adapter.
Normal mutation output reports the real status/message/revision; `--json` returns
the complete response for scripts. Transport/usage errors exit nonzero. A valid
HTTP response containing a semantic rejection is returned as data (exit zero);
machine consumers must inspect `status`/`code`. Grant and resume remain separate.

`application/client.ts` is shared by browser and CLI, checks contract IDs and does
no local authorization or execution. The browser retains SSE and snapshot ordering.
Inbox filtering is display only; the server authorizes every operation. Local actor
selection is **not authentication**. The existing endpoint envelopes remain:

- `GET /api/contract` → `{contractId,contract}`
- `GET /api/snapshot` → state, ledger projection, defaults and availability
- `POST /api/actions/preview`, `/api/actions/execute` ← `{actor,action,args}`
- `POST /api/approvals/grant` ← `{actor,requestId,policyId}`
- `POST /api/approvals/resume` ← `{actor,requestId}`

No application-specific handler was added. Existing v1 contract shape is unchanged.
Adapters must use actual returned requirements/grants, preserve exact request IDs,
and never equate a saved grant with a committed action. There is no automatic write
retry, client request idempotency key, rebasing, authentication, migration, native
renderer conformance claim or external exactly-once guarantee. A lost write response
is ambiguous: inspect the durable state/inbox before retrying. One-shot consumed
resume rejection does not make arbitrary repeated execute calls idempotent.

## Tooling and evidence

```sh
npm run syntax:check -- leave/browser.domain
npm run syntax:check -- leave/cli.domain
npm run syntax:check -- leave/mobile.domain
npm run syntax:lint -- leave/browser.domain --strict
npm run syntax:reader -- leave/browser.domain artifacts/time-away-highlighted.html
npm run application:count -- leave model.ts server.ts cli.domain mobile.domain \
  --report artifacts/model-derived-application-count.json
npm test
npm run application:test
npm run leave:test
npm run syntax:browser
npm run syntax:reader:test
npm run application:cli:test
```

The source reader shows **each complete imported file**, separately labeled, with
its entire exact original source and per-file copy/download. It does not concatenate
away import declarations or omit author presentation/demo code. Lexer/editor grammar
recognize module/reference/selector/identity keywords. Lint CLI follows the real
import closure. `lintSource` remains the single-file/programmatic API (callers can
provide a loaded parse result for module text). Source counts traverse the actual
text graph and include the bridge/launcher and every explicitly selected view entry;
there is no source-reduction percentage or hidden-file exclusion claim.

Executed mapping tests cover exact legacy equality, all three views, file-local
spans, missing/ambiguous references, raw-string non-inference, unused lazy references,
systematic resource renaming, role leakage, graph failures, old SQLite pending
reopen, and spawned CLI advancement through the real durable host. The browser/CLI
integration uses one host/database: CLI request → browser grant → CLI resume → live
browser balance update; duplicate consumed and browser-rule-edit stale boundaries
are checked. CLI process tests also check durable reopen and retained stale grants.
Reader checks sample Chromium at 1440/728/390px and check exact per-file downloads.
These are tests of this mapping, not compiler correspondence proofs.

Read depth: full README/design brief and relevant application/syntax source and
local memos; independent execution of repository and named browser suites. No
external research, dependency installation, Exact adapter changes or delegates.
Trusted boundaries remain the parser/loader, interpreter, host input registry,
HTTP framework, Node/Effect/SQLite, local identities/clock and filesystem. There is
no sandbox claim for reading a user-selected local relative import graph.
