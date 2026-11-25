# Typed JSON Boundaries (Effect Schema Audit & Migration Order)

This document records the audit of `JSON.parse` and `JSON.stringify` boundaries across Premise and the tiered migration order to Effect Schema (`effect/Schema` 4.1.4 via `adapters/effect/json.mjs`).

## Shared codec module

- `adapters/effect/json.mjs` (tested by `adapters/effect/json.test.mjs`) provides Effect Schema `Schema.fromJsonString(...)` codecs, strict request decoders (`onExcessProperty: 'error'`), open-record persistence decoders (`Schema.StructWithRest`), and compact, pretty, and deterministic lexicographic-key canonical JSON encoders.
- All Node-side runtime boundaries import `adapters/effect/json.mjs` directly, resolving `effect/Schema` from `adapters/effect/package.json` without adding a root runtime dependency.

## Migration order and status

| Tier | Boundary class | Files | Status |
| --- | --- | --- | --- |
| 1 | Durable SQLite persistence & Effect adapter | `adapters/effect/durable.mjs`, `adapters/effect/index.mjs` | Migrated |
| 2 | HTTP request/response & SSE server boundaries | `application/server.mjs`, `workspace/server.mjs`, `adapters/exact/serve.mjs` | Migrated |
| 3 | Node CLIs, replay traces & verification tools | `application/cli.mjs`, `application/inspect-action.mjs`, `application/check-interactions.mjs`, `application/inspect-submission.mjs`, `application/count.mjs`, `application/inspect-loading.mjs`, `adapters/lean/check.mjs`, `adapters/lean/inventory.mjs`, `inventory/v2/generated.mjs`, `inventory/v2/demo.mjs`, `syntax/lint.mjs` | Migrated |
| 4 | Bundled Effect UI browser storage boundary | `adapters/effect-ui/browser.mjs` | Migrated |
| 5 | Unbundled static browser scripts & zero-dependency cores | See below | Deferred (explicit boundary) |

## What each migrated tier enforces

1. **Tier 1 (Durable SQLite & Effect adapter):** Decodes `durable_invocations` (`command_json`, `outcome_json`), `durable_operations.outcome_json`, `durable_pending.request_json`, `durable_grants.receipt_json`, `durable_outbox.event_json`, and `durable_meta.state_json` through typed Effect Schema unions/structs (`DurableOutcomeSchema`, `DurableOperationOutcomeSchema`, `DurablePendingRequestSchema`, `DurableReceiptSchema`, `DurableInvocationSchema`, `DurableEventSchema`) composed with `jsonSnapshot` and profile state validation. Encodes canonical storage keys and values with `encodeCanonicalJson`.
2. **Tier 2 (HTTP & SSE servers):** Replaces raw `JSON.parse` and hand-rolled `exact(...)` / type checks on `application/server.mjs` (`/api/actions/{preview,execute,reconcile}`, `/api/approvals/{grant,resume}`) and `workspace/server.mjs` (`/api/{execute,approve,resume}`) with strict Effect Schema request codecs (`onExcessProperty: 'error'`, bounded identities, safe nonnegative integer clocks). Encodes HTTP JSON responses, SSE `data:` frames, `application_submissions` rows, and `adapters/exact/serve.mjs` error responses with Effect Schema encoders.
3. **Tier 3 (CLIs, replay & verification tools):** Validates CLI `--args` JSON objects (`decodeJsonObject`), `action-events/v1` replay traces (`ActionEventsTraceSchema`), submission traces (`SubmissionTraceSchema`), Lean CLI JSON inputs, and generated-history replay inputs, and encodes CLI/report JSON output via `encodeJson` / `encodeJsonPretty`.
4. **Tier 4 (Bundled Effect UI spike):** Replaces raw `sessionStorage` `JSON.parse` / `JSON.stringify` in `adapters/effect-ui/browser.mjs` with `StorageKeyCodec` and `SavedSubmissionCodec` using the package's bundled `effect` `Schema`.

## Remaining Tier 5 sites (explicitly outside this migration)

These modules currently run either directly in browsers without a JS bundler or as zero-dependency pure-JS cores/build scripts:

- **Unbundled browser modules served as static `.mjs` / `.html`:** `application/browser.mjs`, `application/client.mjs`, `application/submission.mjs`, `workspace/app.mjs`, `workspace/derive.mjs`, `live/app.mjs`, `live/core.mjs`, `live/derive.mjs`, `live/build.mjs`, `live/generated.mjs`, `inventory/app.mjs`, `inventory/host.mjs`, `inventory/build.mjs`, `workbench/template.html`, `workbench/build.ts`, `workbench/presentation.ts`, `adapters/exact/client.mjs`, `adapters/exact/generate.mjs`.
- **Zero-dependency semantic cores, parser & prototype scripts:** `semantic/core.mjs`, `semantic/v2/core.mjs`, `adapters/lean/generate.mjs`, `syntax/frontend.mjs`, `prototype/engine.ts`, `prototype/demo.ts`, `prototype/property.ts`, `proof/check.mjs`.

**Next step for Tier 5:** Migrating unbundled browser modules (`application/browser.mjs`, `application/client.mjs`, `workspace/app.mjs`) requires either bundling them (as `adapters/effect-ui` already does with esbuild) or serving an import-mapped browser bundle for `effect/Schema`. Migrating `semantic/core.mjs` / `semantic/v2/core.mjs` requires deciding whether the semantic cores should take a dependency on `effect` or stay zero-dependency with `adapters/effect/json.mjs` wrapping their boundaries.
