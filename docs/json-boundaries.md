# Typed JSON Boundaries (Effect Schema Audit & Migration Order)

This document records the audit of `JSON.parse` and `JSON.stringify` boundaries across Premise and the tiered migration order to Effect Schema (`effect/Schema` 4.1.4 via `adapters/effect/json.ts`).

## Shared codec module

- `adapters/effect/json.ts` (tested by `adapters/effect/json.test.ts`) provides Effect Schema `Schema.fromJsonString(...)` codecs, strict request decoders (`onExcessProperty: 'error'`), open-record persistence decoders (`Schema.StructWithRest`), and compact, pretty, and deterministic lexicographic-key canonical JSON encoders.
- All Node-side runtime boundaries import `adapters/effect/json.ts` directly, resolving `effect/Schema` from `adapters/effect/package.json` without adding a root runtime dependency.

## Migration order and status

| Tier | Boundary class | Files | Status |
| --- | --- | --- | --- |
| 1 | Durable SQLite persistence & Effect adapter | `adapters/effect/durable.ts`, `adapters/effect/index.ts` | Migrated |
| 2 | HTTP request/response & SSE server boundaries | `application/server.ts`, `workspace/server.ts`, `adapters/exact/serve.ts` | Migrated |
| 3 | Node CLIs, replay traces & verification tools | `application/cli.ts`, `application/inspect-action.ts`, `application/check-interactions.ts`, `application/inspect-submission.ts`, `application/count.ts`, `application/inspect-loading.ts`, `adapters/lean/check.ts`, `adapters/lean/inventory.ts`, `inventory/v2/generated.ts`, `inventory/v2/demo.ts`, `syntax/lint.ts` | Migrated |
| 4 | Bundled Effect UI browser storage boundary | `adapters/effect-ui/browser.ts` | Migrated |
| 5 | Vite-bundled browser JSON boundaries | `application/{browser,client,submission}.ts`, `workspace/app.ts`, `live/app.ts`, `inventory/app.ts` | Migrated |

## What each migrated tier enforces

1. **Tier 1 (Durable SQLite & Effect adapter):** Decodes `durable_invocations` (`command_json`, `outcome_json`), `durable_operations.outcome_json`, `durable_pending.request_json`, `durable_grants.receipt_json`, `durable_outbox.event_json`, and `durable_meta.state_json` through typed Effect Schema unions/structs (`DurableOutcomeSchema`, `DurableOperationOutcomeSchema`, `DurablePendingRequestSchema`, `DurableReceiptSchema`, `DurableInvocationSchema`, `DurableEventSchema`) composed with `jsonSnapshot` and profile state validation. Encodes canonical storage keys and values with `encodeCanonicalJson`.
2. **Tier 2 (HTTP & SSE servers):** Replaces raw `JSON.parse` and hand-rolled `exact(...)` / type checks on `application/server.ts` (`/api/actions/{preview,execute,reconcile}`, `/api/approvals/{grant,resume}`) and `workspace/server.ts` (`/api/{execute,approve,resume}`) with strict Effect Schema request codecs (`onExcessProperty: 'error'`, bounded identities, safe nonnegative integer clocks). Encodes HTTP JSON responses, SSE `data:` frames, `application_submissions` rows, and `adapters/exact/serve.ts` error responses with Effect Schema encoders.
3. **Tier 3 (CLIs, replay & verification tools):** Validates CLI `--args` JSON objects (`decodeJsonObject`), `action-events/v1` replay traces (`ActionEventsTraceSchema`), submission traces (`SubmissionTraceSchema`), Lean CLI JSON inputs, and generated-history replay inputs, and encodes CLI/report JSON output via `encodeJson` / `encodeJsonPretty`.
4. **Tier 4 (Bundled Effect UI spike):** Replaces raw `sessionStorage` `JSON.parse` / `JSON.stringify` in `adapters/effect-ui/browser.ts` with `StorageKeyCodec` and `SavedSubmissionCodec` using the package's bundled `effect` `Schema`.
5. **Tier 5 (Vite-bundled browsers):** Uses the shared codecs for HTTP JSON bodies, SSE snapshots and change envelopes, saved application submissions, Live workspace storage and imports/exports, Inventory replay files, and editable tool JSON. Workspace's editable commands still reach the server's strict request validator unchanged; Live and Inventory still validate and replay imported artifacts in their respective cores. The Live worker uses structured clone, not JSON.

## Remaining sites (outside the Vite browser migration)

- **Separate browser build paths:** Workbench's static HTML and presentation scripts do not use Vite. The Exact generator copies its client and submission helpers into the generated app; Exact compiles that app through its own toolchain, not the Premise Vite build.
- **Zero-dependency cores and derivations:** `live/{core,derive}.ts`, `inventory/host.ts`, `workspace/derive.ts`, and `semantic/{core,v2/core}.ts` remain independent of Effect. Internal copies, equality comparisons, map keys, and display-only JSON are not boundary migrations.
- **Build and verification tooling:** Remaining JSON in the build scripts, `live/generated.ts`, `adapters/{exact,lean}/generate.ts`, `syntax/frontend.ts`, `prototype/` and `proof/check.ts` is outside the browser runtime.
