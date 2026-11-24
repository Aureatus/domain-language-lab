# Rule impact and derived-check handoff

Browser-safe module `live/derive.mjs` imports createApp from core.

Exports:

1. `describeChange(model, action, patch)` returns JSON:
   `{ok,reason?,action?,revision?,roleChanges?:[{role,before,after}],
   routes?:{added:[],removed:[]},unchanged?:boolean,scope?:string}`.
   Uses roles/notify only, validates like setRule, no mutation. Empty role/routing
   changes are explicit no-op. Scope is exact declaration differences, not complete
   reachable behavior or past notification changes.
2. `runDerivedChecks(workspace)` returns
   `{result:'passed'|'failed'|'unknown',revision,cases:[{id,action,actorId,expected,actual,status,reason?}],scope}`.
   Synchronous, no network. Restore/clone the current workspace into isolated
   runtimes. Derive cases from current action declarations, roles/input schemas and
   known issue/user references. Test actual tool dispatch with expected role/policy
   outcome, input-invalid no-mutation variants and useful positive valid-state
   witnesses. Derive route expectations independently from declared relationship
   paths. Do not silently pass when a fixture cannot establish its preconditions;
   report skipped/unknown reasons. The live runtime/workspace must be unchanged.

UI lab shows declaration diff as fields change, before Apply. Add separate
"Run declaration checks" result view (not proof and not exhaustive property tests).
Invalidate results on model/state changes and keep existing current-state audit
distinct. The builder inlines core, derive, app in that order, stripping only known
import/export syntax. Existing workbench/proof artifacts are unaffected.
