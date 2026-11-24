# Live issue-tracker integration contract

Implementation handoff for the next experimental slice. This browser-local app
executes actions live. It does not replace the earlier verification workbench or
claim persistence, authentication, distributed delivery or formal correspondence.

## Core module: `live/core.mjs`

Export `createApp(options = {})`. Return a synchronous object:

- `state`: current state object (read at use time; mutations may replace it).
- `model`: current declaration object (read at use time).
- `dispatch(action, args, actorId)`: returns `{ok, reason?, event?, value?}`.
- `setRule(action, patch)`: update that action's allowedRoles and/or notify paths;
  validate values and return `{ok, reason?}`. Increment declaration revision.
- `tools()`: derive JSON-schema-like action descriptors from declarations.
- `explain(eventId)`: historical explanation including captured declaration revision,
  actor, changes and recipient relationship paths; return null for unknown ID.
- `check()`: run explicit invariants against current state, returning named outcomes.

Options may include injected `clock` returning a number. No Node-only imports.

State has `users`, `issues`, `events`, `notifications`; arrays throughout.
Users: `{id,name,role}` with roles `member` and `lead`. IDs `u1`, `u2`, `u3`.
Issues: `{id,title,description,status,priority,opener,assignee,watchers,comments,version}`.
Status `open|resolved`; priority `normal|high`; assignee nullable user ID.
Comments: `{id,author,body,createdAt}`. Notifications:
`{id,eventId,issueId,recipient,action,reasons}` with relationship paths as reasons.
Events at least `{id,action,actorId,issueId,revision,changes,recipients}`.

Actions and args:

- `create`: `{title, description?, priority?}` returns issue as value.
- `assign`: `{issueId, assignee}`.
- `comment`: `{issueId, body}`.
- `resolve`: `{issueId}`.
- `reopen`: `{issueId}`.
- `watch`: `{issueId}` toggles the invoking actor's watch membership.

Model: `{revision, actions}`. Each action is declared with
`{label, allowedRoles, notify, inputs}`. Inputs use JSON-schema-like
`{type:'object',properties,required}`. Supported notification paths are `opener`,
`assignee`, `watchers`. Actions and tool definitions use the same declaration.
The original opener need not receive every update; default relevant rules exclude
the actor from human notifications and deduplicate overlapping relationship paths.
Set-rule edits are a development lab operation, not a production user capability.

## UI module

Use the API above rather than implementing another interpreter. UI reads model
labels/input requirements and current policy availability. Author a real issue
workspace with compact list/detail/comment/assignment interactions and a recipient
inbox. Put Inspect/Why and declaration editing in contextual disclosure.

Changing a rule should immediately affect available actions/tool descriptors and
future notification routing. Past event explanations must retain their original
rule revision and relationship reasons. No automatic retroactive notifications.

The app is local ephemeral state with explicit reset. Exports are truthful JSON.
Build a self-contained offline artifact with inline core and UI, without requiring
a server. Browser tests use actual actions, not precomputed executions.
