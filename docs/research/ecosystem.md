# Ecosystem evidence carried forward

Investigation context: 2026-11-11. This memo summarizes source/documentation research from the preceding conversation, not a fresh compatibility test. No stack implementation or durability test was run. Moving links should be pinned again before implementation decisions.

## Ash

Inventory sources: [ecosystem](https://ash-hq.org/ecosystem/) and [organization repositories](https://github.com/ash-project).

- Core/Spark: declarative resources, actions, policies, transformer/verifier extension machinery.
- Data: AshPostgres/AshSqlite; API: AshGraphQL/AshJsonApi/AshTypescript/AshRPC.
- Workflow: AshStateMachine, Reactor, AshOban, community AshWorkflow/Magma.
- History/events: AshEvents, AshPaperTrail, signals and AshOban signal delivery.
- UI: AshPhoenix, AshAdmin and community PyroManiac.
- Scoped AI/scripting: AshAI, AshLua. Other candidates: AshSync, AshStorage, AshArchival, AshMoney, AshDoubleEntry, AshGrant. Inventory inclusion is not an endorsement of maturity.

[AshWorkflow](https://github.com/team-alembic/ash_workflow) generates state-machine transitions, jobs and policy-protected manual actions, including human approval examples, deadlines/reminders and logs. [Recipes](https://github.com/team-alembic/ash_workflow/blob/main/documentation/recipes/index.md) generate application-owned code; they do not continuously regenerate it. This corrects the earlier overly broad suggestion that Ash's ecosystem lacks durable approvals.

[Magma](https://github.com/team-alembic/magma) composes Reactor, Oban and Ash with checkpoints and durable signal waits. Its README installation references mbuhot/magma rather than the unrelated Hex package. Evaluate current installation/source alignment before adoption.

[AshEvents](https://github.com/ash-project/ash_events) records create/update/destroy action events with versions/changes; replay routes versioned actions and skips lifecycle hooks. Its wrapper has restrictions around existing manual actions. Do not equate it with arbitrary pure event-sourced replay.

[AshOban Signals](https://github.com/ash-project/ash_oban/blob/main/documentation/topics/signals.md) supports listener-specific inline/job delivery. Transaction/repository placement and actor persistence matter; default uniqueness concerns incomplete jobs, not eternal exactly-once business effects.

[AshLua](https://github.com/ash-project/ash_lua) carries actor/tenant/context into domain calls and exposes manifest-driven discovery. This is a useful scoped-interface precedent, not automatic confinement of all foreign code.

## UI precedent

[PyroManiac](https://github.com/frankdugan3/pyro_maniac) separates its domain-aware UI DSL from rendering. Its ExpandFormActions source resolves action references and validates field contracts. It supports multiple views and forms but is not evidence of a completed universal rich-workspace language. Former ash_pyro_components features moved here.

[AshPhoenix](https://github.com/ash-project/ash_phoenix) supplies action forms and relationship form inference. LiveView helpers mainly subscribe/refetch rather than supply a general incremental-query engine. [AshAdmin](https://github.com/ash-project/ash_admin) demonstrates derived resource exploration and administration, not the full target UI scope.

[Foldkit](https://github.com/foldkit/foldkit) provides schema Model, Messages, pure update, Effect Commands, Subscriptions, Submodels, OutMessage, Ports and custom DOM mounting. A renderer adapter and domain-aware interaction IR would still be our work.

## Alchemy and Distilled

[Alchemy](https://github.com/alchemy-run/alchemy) source inspected at `861b5cf439067bf5efd8b8004bf8f5d7803988a0`; tagged release observed `v2.0.0-beta.85`. Snapshot uses Effect 4.1 and Distilled in AWS/Cloudflare providers. Domain source includes aggregates, queries, views, sagas and hosting implementations; cloudflare-domain examples demonstrate Foldkit wiring.

Alchemy `Policy` is event reaction, not Ash-style authorization. Local-first documentation does not establish general aggregate synchronization. Open PRs observed: [#3252](https://github.com/alchemy-run/alchemy/pull/3252) duplicate saga commands on retries, [#3220](https://github.com/alchemy-run/alchemy/pull/3220) stalled delivery after dead drain leases. These were open at inspection; re-check status before relying on them.

[Distilled](https://github.com/alchemy-run/distilled) inspected at `72203ddf7328f4dc1661355afcb2d79ab6ca4ffb`. OperationMethod exposes typed Effect input/output/error/requirements and runtime schemas. Response validation defaults lenient; SDK retry composition alone does not establish safe replay of mutations. IAM metadata PRs [#1070](https://github.com/alchemy-run/distilled/pull/1070) and [#1072](https://github.com/alchemy-run/distilled/pull/1072) were open at inspection.

## Implication

Reuse library mechanisms. Specify and test the additional derivation and integration contracts: authorization semantics, event/transaction mapping, relationship routing, interaction meaning, compiler correspondence and evidence-preserving outputs. The upstream test suites do not automatically establish these compositions.
