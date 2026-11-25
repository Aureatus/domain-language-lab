# Local durable workspace server

This is a loopback **simulation**, not an authentication service. It implements
the HTTP handoff in [completion-contract.md](completion-contract.md) over the
actual Effect/SQLite adapter. No inventory transitions are implemented in HTTP.

```sh
node workspace/server.ts
# Optional: WORKSPACE_DIR=/path/to/data PORT=4173 node workspace/server.ts
node --test workspace/derive.test.ts workspace/server.test.ts
```

`createWorkspaceServer({directory, port:0})` in `workspace/server.ts` resolves
`{url, close()}` after binding `127.0.0.1`. `close()` is idempotent, terminates SSE
and active HTTP connections, closes the listener, then closes both databases.
The CLI defaults to `artifacts/workspace-data` and port 4173. The import API
defaults to an ephemeral port. Existing files are never reset. `v1.sqlite` binds
the complete `inventory/model.ts` model; `v2.sqlite` independently binds
`inventory/v2/model.ts`. Reopen with changed declarations or invalid stored state
fails, rather than migrating or reinitializing the database. Startup listener
failure cleans up databases opened by this server.

## API

See the exact endpoints/envelopes in `completion-contract.md`. Snapshot includes
the complete model/state, all current/consumed pending request projections, all
historical implicit facts, derived tools, sequence and scope. Actor is accepted as
explicit simulation context, **not** a row-access filter or authentication.
Execute preserves invocation actor/clock. Approval accepts only operation references
and a simulated approver identity; receipts supplied by a client are rejected.
Resume accepts the explicit simulated clock and reads original requests/grants
inside the adapter's transaction. Clocks use the models' logical units, not wall
time. A deployed trusted host must replace these simulated identities and clocks.

Domain `committed`, `pending`, `approved`, `rejected`, and `duplicate` results are
returned unchanged with HTTP 200. Malformed envelopes, unknown profile/method,
bounded-JSON failures, SQLite locking/corruption and transport failures use non-2xx
`{error}`. Input schema/policy/precondition decisions remain interpreter results.
Bodies must be `application/json`, at most 262144 bytes, and additionally satisfy
the shared strict JSON bounds. Commands/envelopes have exact members. Unknown API
routes fail closed; frontend serving is an explicit `/`, `/index.html`, `/app.ts`,
`/derive.ts` allowlist (missing concurrently-built frontend files return 404).

Host must be the listener's exact `127.0.0.1:port` or `localhost:port` authority.
When present, Origin must equal `http://Host`; cross-site/same-site Fetch Metadata
is refused. No wildcard CORS or OPTIONS write bypass is provided. These checks
bound a local demo's browser attack surface, not local-process attackers, reverse
proxies, untrusted extensions or remote deployment. Never expose this listener as
an authenticated service. Local callers can deliberately impersonate any actor.

## Consistency, events and derivation

Snapshots use **one SQLite read transaction** spanning validated state/model
binding, pending/grants, history and sequence. This read-only projection is coupled
to the adapter's `durable-effect/v1` table schema because adapter read APIs start
their own transactions. It reproduces the documented `durablePending` projection;
requests are reconstructed through the interpreter and grants checked against
their exact receipt content. No snapshot or SSE connection acknowledges, deletes,
or discards any outbox row. History includes acknowledged rows too.

Snapshot/SSE `sequence` is the durable count of immutable invocation and operation
ledger entries **within that profile**. It advances for pending, grants and stored
rejections as well as commits; exact retries do not advance it. It is distinct
from each historical fact's outbox `sequence`, which orders facts within atomic
committed groups. Neither ordering establishes causal order among a group's facts.

Every SSE connection, including one with `Last-Event-ID`, immediately sends
`event: change` with `reason:'resync'`, current sequence and
`invalidations:[{view:'snapshot'}]`. It intentionally does not replay an ephemeral
notification buffer: clients fetch `/api/snapshot` to obtain complete durable
state/history after every notification. Committed facts remain recoverable across
disconnect/restart even though SSE messages themselves are not durable delivery.
Slow streams are disconnected on backpressure and resync on reconnect. Shutdown
terminates all streams. No database polling or timer is used.

After each newly persisted operation all connected clients for that profile get
`{sequence,invalidations,recipients,reason}`. No actor filter suppresses view refresh.
`deriveTools(model)` returns exact action input schemas and policy/precondition
IDs. `deriveDependencies(model)` projects each action's writes and declared
observations. `deriveChange(model, events, options)` combines those dependencies
with actual implicit facts, without branching on an action name:

- `{view:'resource',resource}` refreshes an action's written collection (including
  no-op assignments that change versions without a changed-field fact).
- `{view:'resource',resource,key}` refreshes the fact's changed/created/deleted entity.
- `{view:'relationship',relationship,resource,key}` refreshes that entity's
  declared relationship projection, not a recipient's private view.
- `{view:'history'}` refreshes committed historical facts.
- `{view:'pending'}` explicitly refreshes request/grant/consumption projections.

`recipients` are the core's historical `{recipient,paths}` routing snapshot,
deduplicated across the atomic group. Human notification routing excludes the
actor as declared by the core; resource invalidation does **not**. Relationship
paths describe notification support, not arbitrary foreign-key joins or bidirectional
propagation. Reasons are `commit`, `approval-ledger`, `outcome` and `resync`.

All mutations must pass through this single server instance. Another direct DB
writer/server is outside live-notification scope: SQLite still serializes writes,
but this process has no cross-process event bus. Reconnect always recovers durable
snapshot facts. These guarantees assume the adapter, interpreter, Effect 4.1.4,
Node SQLite and local filesystem locking/durability; they add no external exactly-once
delivery, production authentication, model migration or proof correspondence.

## Evidence/read depth

Full local README, completion and durable execution memos, v2 contract; selected
v1 contract sections; source inspection of durable adapter, both inventory models
and issue fixture; independent execution of the workspace tests. No upstream suite
copy or proof audit. Tests cover schema/tool parity, v1/v2 actions, restart after
pending/grants/consumption, one-shot resume, stale/expired evidence, competing
commands, duplicate results, two SSE clients, reconnect/restart history, non-destructive
outbox reads, grant invalidation, local-origin guards, bounded input, SQLite lock
and corruption failures, port conflicts and SSE shutdown. This is bounded backend
evidence, not browser end-to-end evidence or exhaustive verification of the profiles.

Executed on Node v25.2.0 with installed Effect 4.1.4:

```sh
node --test workspace/derive.test.ts workspace/server.test.ts adapters/effect/*.test.ts semantic/*.test.ts semantic/v2/*.test.ts
# 66 passed, 0 failed (11 workspace tests plus 55 existing regression tests).
```
