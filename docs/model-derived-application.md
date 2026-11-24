# Model-derived experimental application

Status: implemented for the time-off vertical slice and a small non-leave **model test fixture**. This is a bounded web renderer/application host, not a general application compiler.

## Authoring boundary

The single author entry is now **[`leave/time-away.domain`](standalone-syntax.md)**,
a standalone keyword/block text source. `leave/model.mjs` is a 10-line framework
loading bridge retaining the compatibility default export:

```js
{ domain, initialState, application }
```

`domain` is the actual data-only `semantic-core/v2` declaration. `initialState` is validated against it. `application` is versioned, data-only presentation/input configuration. It contains labels, the local actor menu, summaries/lists, input defaults, trusted input bindings and named adapters. It contains no templates, callbacks, copied permission guards, manager routing rules, handlers or browser functions.

`leave/server.mjs` is an optional 11-line compatibility launcher for existing commands and the existing database filename. It passes the declaration to `createApplicationServer`. No application-specific server/client/HTML implementation remains. The former `leave/app.mjs`, `index.html`, CSS and explanation UI have been replaced by reusable assets in `application/` after inspecting their existing behavior. Original MP4s, audio and historical evidence artifacts are retained.

### Executable authored-source count

```sh
npm run application:count -- leave model.mjs server.mjs \
  --report artifacts/model-derived-application-count.json
```

The import-closure report now follows the explicit text loader URL and counts
**3 production per-application files, 206 physical lines / 194 nonblank lines /
5,679 bytes**: `leave/time-away.domain` (185 lines), `leave/model.mjs` (10) and the
optional launcher (11). The text is the only application author entry; the bridge
and launcher are counted rather than hidden. Framework imports, test/scenario/
video/audio tooling and the optional demonstration-only source adapter are listed
separately and excluded. Unsupported import/loading syntax fails rather than
silently undercounting. These are present-source counts, **not savings against a
nonexistent baseline**, and not a measure of framework complexity. The old model's
roughly 115 JS lines are not a meaningful comparison: formatting differs. The
report must be regenerated after source changes.

## Runtime derivation, not checked-in generated application files

1. `application/derive.mjs` validates the domain with the existing v2 interpreter and validates metadata references, supported members, bindings, formats, defaults and widgets. Unsupported configurations throw at startup; there is no `eval` or executable configuration escape hatch.
2. It derives one `derived-application/v1` contract: actions, exact input schemas, fields/widgets, policy/precondition declarations, references, resource views and actor labels. Every domain action appears by default. Adding an input/action does not require adding a form or route.
3. `application/server.mjs` uses that contract to build invocations, applies named host adapters, then calls the existing interpreter/Effect durable adapter. Core decisions and writes are never implemented in the UI or metadata.
4. `GET /api/contract` serves the same contract used by dispatch. Its `contractId` hashes the validated domain plus derived contract. Snapshots and action responses carry that ID. The browser refuses to use mismatched responses and asks for a reload.
5. `application/browser.mjs` fetches the contract and creates labels, input controls, forms, summaries, resource lists and approval controls at runtime. `application/index.html` is an application-independent HTML shell served for both `/` and `/index.html`; its title/content are populated from the contract. CSS and renderer code are reusable framework assets. There is **no app HTML generation/build step**, and no generated asset to hand-edit.

The server serves full resource state to all local simulated identities. View composition and actor ownership filters are display features, **not row authorization**.

## Metadata and defaults

The `model-application/v1` metadata supports:

- `title`, optional `eyebrow`, `subtitle`, `scope`; `actors: [{id,label,name?}]` for the local identity simulator. A role in a label does not grant permission.
- Optional `actions[actionId]: {label?,description?,fields?,adapters?}`. Unknown action/input names fail. Actions and inputs need no override to appear.
- Inputs derive labels from identifiers; integer inputs become bounded integer controls, booleans checkboxes, enums selects, and strings text controls. A binding whose key is an input automatically supplies a resource reference/select. `reference: {resource,labelField?}` can choose its display label. An explicit reference must point to existing declared fields.
- A field may override `label`, supported `widget`, and `default`. A default is a schema-compatible literal or `{resource,key,field}` lookup; `key:'$actor'` means the selected actor's record. Defaults initialize per-actor/action drafts; they are not server authorization/default injection. Actual submitted input validation remains with the semantic interpreter.
- `binding: {source:'actor'|'operation-id'|'clock'}` or `{source:'constant',value}` supplies hidden server-owned inputs. Clients cannot submit those fields. Top-level invocation IDs/clocks are also host-owned. This profile does not permit arbitrary expressions, JavaScript functions or template strings in presentation configuration.
- `views` composes `summary`/`list` blocks with a declared `resource`, `label`, optional `key` (`'$actor'` supported), optional `ownerField`, and `fields` or `columns: [{field,label?,format?}]`. Formats are `text` or UTC `date`. Declared relationship fields display known actor names. Without `views`, every resource gets a list. Unknown resources, fields, record keys, formats and view kinds fail.

Visible `ids` inputs and richer widgets are explicitly unsupported rather than silently mapped to text. This renderer covers simple forms/lists/summaries; it is not the proposed rich T3-like workspace interaction system. There is no arbitrary author callback/HTML escape hatch. Additional reusable renderers/adapters require framework work and a versioned contract.

### Trusted date boundary

`application/inputs.mjs` owns the named **`utc-weekday-range/v1`** adapter. The application provides only `{start,end,output}` input-name mappings. The framework validates string/string/integer schemas, distinct names and supported adapter version; it hides the computed output and derives date controls for the two source fields.

At preview and execution it validates real `YYYY-MM-DD` calendar dates, rejects reversed/weekend-only ranges, bounds the inclusive range (end minus start at most 3,660 days), and computes inclusive UTC Monday–Friday days. An optional supplied output must equal the computed value. It does not consult holidays/time zones/half-days, prevent overlapping requests, accrue leave or enforce future dates. This is **trusted host behavior outside the date-unaware semantic core**; direct core callers must uphold the same input contract. Named adapters contain trusted framework JavaScript, not sandboxed foreign code.

## Generic HTTP and durable workflow

| Endpoint | Contract |
|---|---|
| `GET /api/contract` | `{contractId,contract}` |
| `GET /api/snapshot` | `{contractId,state,pending,defaults,availability}` |
| `GET /api/events` | SSE `update` with a full fresh snapshot; immediate initial/reconnect resync |
| `POST /api/actions/preview` | `{actor,action,args}` → actual `prepared` / `pending` / `rejected`, captured/derived `args`, actual requirements and evidence; no persistence |
| `POST /api/actions/execute` | Same body → actual durable execution result, snapshot and evidence |
| `POST /api/approvals/grant` | `{actor,requestId,policyId}` → real durable grant only; no domain mutation/resume |
| `POST /api/approvals/resume` | `{actor,requestId}` → resume using internally stored original request/grants and a fresh host clock |

There are no `/request`, `/rule` or `/approve` domain endpoints. POST bodies are exact and bounded (16 KiB); unsupported/missing envelope members fail. Hidden bindings cannot be spoofed. Core input types, policies, preconditions and grouped transition validity remain interpreter decisions. Host/Origin/Sec-Fetch-Site checks limit browser cross-site use but do not authenticate local callers.

Pending projections read the **real durable ledger**, retaining invocation args, every captured approval requirement, grants, consumed status and full-prestate staleness. The inbox filters by actual requester/eligible approvers. One control per eligible ungranted policy appears; only complete grant coverage exposes completion. No resource/action/field/actor identifiers are special-cased in the framework. Multiple matching policies require multiple real grants. Eligibility is checked by `durableApprove`, not the display filter. The generic resume host gate permits only requester or captured eligible approvers; `durableResume` still checks coverage/freshness/consumption and loads receipts internally.

Grant and resume are visibly **separate transactions and controls**. A saved grant followed by stale/failed resume remains saved; the UI explicitly reports “Approval is saved, but completion failed,” without pretending the action committed. Full-state binding rejects even unrelated/no-op commits; requests are never rebased. There is no cancellation, supersession, revocation or model migration.

Action availability is an advisory read-only `prepare` of defaults against current state, hiding `denied`/`missing-record` forms when determinable. Invalid defaults can make availability undecidable, in which case the form appears and the actual preview explains the failure. This is not a new authorization implementation. Submission is always independently authorized against fresh durable state.

The browser locks overlapping local commands, ignores stale preview responses, and preserves per-actor/action drafts across SSE and actor switches. Drafts/evidence are memory-only. SSE broadcasts full snapshots to loopback clients, not authorized per-recipient notifications or an exactly-once transport. A lost HTTP result is ambiguous: inspect saved state before retrying. Server-generated operation IDs do not establish client-request idempotency.

## Optional evidence companion

Snapshot responses also carry `snapshotVersion`, the total append-only durable
invocation and operation ledger row count. Under the sole-writer/no-ledger-deletion
contract, it survives reopen and advances for pending requests and grants even
when domain revision stays unchanged. The browser rejects older snapshots so a
delayed HTTP response cannot overwrite a newer SSE view. This is not a distributed
clock or support for restoring an older database beneath connected clients.

`/?explain=1` uses the **same generic browser renderer and `application-evidence/v1` response projection**. It shows the actual selected action's policy/precondition/group AST, captured invocation and returned result/events. Current preview and saved action result can be selected separately; automatic previews/SSE do not replace saved evidence. This is declaration/result evidence, **not exact authored-source excerpts, execution-order instrumentation, a parser trace or a proof**. No leave-specific protocol/header is required.

`leave/explain.mjs` remains an optional **demonstration-only source-excerpt adapter**
with separately tested contiguous source selection and read-only diagnostic replay.
It now uses parser-produced semantic ID spans in `leave/time-away.domain`, not
the JS loading bridge. Neither the generic server nor browser imports it. The
historical recordings show the former hand-authored source companion/UI; they do
not demonstrate this migration. The new video entrypoints use the updated generic
scenario/selectors and, when run, record new WebM paths without overwriting
original MP4/audio artifacts. Recording a new video was not required or performed
for this migration.

## Verification and scope

```sh
npm test
node leave/browser-test.mjs
node leave/explained-video.mjs --test
npm run application:test
```

Executed mapping tests exercise the real Maya Friday **5→4**, three-day pending **4**, grant-without-deduction then grouped resume **1**; Leo's two-day preview before/after threshold **3→2**, pending **5**, then grant/resume **3**. They check dates, permissions, exact captured inputs, grouped implicit facts, one-shot consumption, stale rejection with saved grants and unchanged balance, SQLite reopen and cross-origin boundaries.

The small supply model fixture exercises a resource reference/select, number bounds, enum and boolean. A variant **systematically renames resource/action/field/binding/policy/record/actor IDs** and executes through identical server/browser code. Another adds an input and action and changes the policy's approver: the actual generated form and inbox change without app code. A two-policy test checks incomplete coverage rejects resume and that both real grants enable the commit. Invalid metadata, schema/widget/default/binding mismatches and unsupported configurations fail closed. HTTP/browser tests compare the served contract with the same derivation used server-side.

Browser scenarios use independent contexts for SSE, duplicate submit locking, drafts, role/actor switches, rule edits, failures, saved evidence, restart/resync and 390px/no-overflow checks. New screenshot/reports use `artifacts/derived-time-off-*`; the source count is `artifacts/model-derived-application-count.json`. Screenshots were inspected at desktop/mobile dimensions; that is sampled UI evidence, not a proof.

All semantic/durable guarantees retain the scope, assumptions and uncovered boundaries of [v2](../semantic/v2/CONTRACT.md) and [Effect/SQLite](durable-execution.md). Trusted components include interpreter, framework derivation/renderer/input registry, Node/Effect/SQLite, host clock/identity and local filesystem. Deterministic derivation does not make wall clocks, scheduling, storage or HTTP outcomes deterministic. No core/Effect semantics were changed; no v2 theorem, authentication, multi-process UI coherence, migration engine, external exactly-once execution or compiler correspondence proof is claimed.

Read depth: full README, design brief, time-off demo/companion memos, v2 contract and durable memo; source inspection of leave and workspace derivation/server/browser/recording patterns and selected shared core behavior; independent execution of mapping, browser and repository tests. No external research, delegates or proof audit.
