# Premise

Premise is an experimental, Ash-inspired domain language: state the premises, and derive applications, checks, and proofs from them. The research explores Effect/Alchemy execution, relationship-derived behavior, rich renderer-independent applications, and first-class explanation and verification outputs.

**Status:** executable action IRs, inventory/reservation consumers, Effect execution with SQLite persistence and policy-derived approval/resumption, and generated v1 Lean numeric proofs, alongside the earlier live issue workspace. Language syntax and wider contracts remain proposals. No production compiler, runtime correspondence proof, or semantic video generator is implemented; the MP4s are actual browser recordings.

## What Premise infers

Here is the start of `leave.request` from [the time-away domain](leave/time-away.domain):

```domain
action "leave.request" identity request
  inputs
    employeeId reference employee as employee
    leaveId string
    start like leave.start
    end like leave.end
    days like leave.days
  end

  preconditions
    days <= employee.balance id "leave.enough-days"
  end
  policies
    deny when not actor == employeeId id "leave.owner-only"
    allow when days < settings.threshold id "leave.short-break"
    approve by employee.manager when days >= settings.threshold id "leave.manager-approval"
  end
```

In the [time-off prototype](docs/time-off-demo.md), the reusable runtime derives:

- **An input contract and request form.** `days like leave.days` reuses the resource field's integer type and minimum of one without repeating them. The [browser view](leave/browser.domain) supplies labels, date controls via a named adapter, and the saved-leave list layout; the [renderer](docs/model-derived-application.md) builds the form and list.
- **A balance check and an approval inbox.** The precondition checks available days. For an eligible request at or above the threshold, the policy resolves the employee's manager and the [inbox](docs/model-derived-application.md#generic-http-and-durable-workflow) shows that manager the pending request. That leave is saved only after approval and resumption.
- **Action and change events.** The rest of the action groups the balance deduction and leave creation. When they commit, the runtime emits the [action, field-change, and record-creation events](semantic/v2/CONTRACT.md) without separate event declarations.

## Start here

**Fresh clone:** use Node 22.18+ with npm (CI pins Node 24.22.3). Run `npm run adapters:install` to install the locked Effect dependencies, then `npm run check:interactions -- leave/browser.domain leave.request --actor maya`. The checker and offline replay need no browser or native builds. See [Chromium/Exact setup](docs/exact-adapter.md#chromiumexact-conformance) for separate renderer conformance. `artifacts/` is local generated output; the historical media and report links below are not part of the public source checkout.

- **[Check interactions](docs/check-interactions.md):** explore alternative orders of snapshot delivery, reconciliation, refresh and viewer switching; replay the shortest failing prefix in the action inspector.

- **[Review an action](docs/action-review.md):** `npm run inspect:action -- leave/browser.domain leave.request --actor maya` walks the interaction and durable evidence together, in an isolated database.

- **[Submission recovery](docs/submission-recovery.md):** inspect submission states and controls, recover an ambiguous execute by its durable identity, and replay the browser → CLI approval scenario.

- **[Loading policy](docs/loading-policy.md):** configure how data views first appear, inherit defaults or override individual regions, and inspect expected states without slowing down a network request.

- **[Expo Exact adapter](docs/exact-adapter.md):** generates Exact Contract and a typed HTTP data layer from the shared application contract. The pinned compiler, generated web UI and native Android request/grant/resume workflow have been exercised. CLI reads confirmed the same native-created records. iOS and native offline/stale-failure scenarios remain unexecuted. Mapping tests: `node --test adapters/exact/test.mjs`.

- **[Effect UI spike](docs/effect-ui.md):** renders one derived leave-request form from the same application contract. Chromium tests cover recovery of a lost execute response against the real backend.

- **[Shared domain, modules and views](docs/modules-and-views.md):** `leave/time-away.domain` holds the domain, `leave/demo.domain` holds fixtures, and `leave/browser.domain`, `leave/cli.domain`, and `leave/mobile.domain` import them. Typed references and exact singleton selectors derive record bindings. Browser and CLI execute against one backend (`npm run leave`, then `npm run leave:cli -- list`). The mobile entry is a declaration; native adapter execution is tracked separately.

- **[Standalone syntax](docs/standalone-syntax.md):** a real experimental parser and module resolver elaborate the source into the existing semantic model. Run `npm run syntax:check -- leave/browser.domain`, `npm run syntax:lint -- leave/browser.domain --strict`, or `npm run leave`. The [highlighted source reader](artifacts/time-away-highlighted.html) provides whole-source navigation and exact-source copy/download. [Syntax ergonomics](docs/syntax-ergonomics.md) covers grouped declarations, expanded constraints and schema reuse.
- **[Model-derived application](docs/model-derived-application.md):** `leave/model.mjs` is now a thin text-source loading bridge. Reusable `application/` derives the server contract, forms, lists, browser interactions and policy-ledger approval inbox. The optional `leave/server.mjs` is only a launcher; there are no time-off-specific browser or HTML files. Earlier videos show the historical UI.

- **[Time-off story demo](docs/time-off-demo.md):** start here for the clearest introduction. Maya requests Friday off, Sam approves her trip, and Leo's request shows a changed approval rule. Run `npm run leave`, open `http://127.0.0.1:4174`, or watch `artifacts/time-off-demo-narrated.mp4` (102 seconds, Freya narration and music).
- **[Code companion walkthrough](docs/time-off-explained.md):** open `/?explain=1` in the time-off app or watch `artifacts/time-off-code-companion.mp4` (140 seconds, captions only). The app occupies 70% of the screen beside a dark source editor showing the relevant declaration and one short explanation; not a parser trace.

- **[Unified v1/v2 workspace](docs/workspace-ui.md):** run `npm run workspace`, then open `http://127.0.0.1:4173`. Both profiles execute through Effect/SQLite, with live two-session updates, derived forms/tools, approval controls and durable history. Demo: `artifacts/workspace-v1-v2-demo.mp4`.
- [Completion checkpoint](docs/completion-contract.md): end-to-end acceptance scope, executed evidence and remaining profile boundaries.
- [Workspace server and derivations](docs/workspace-server.md): version-isolated databases, snapshot/resync protocol and relationship-derived invalidation explanations.
- [Generated durable histories](docs/durable-generated-tests.md): independent outcome/state oracle, exact replayable commands, seeded scenarios and tested mutation sensitivity.

- **[Durable inventory lifecycle](docs/inventory-v2.md):** actual record creation, approval, database reopen, one-shot resume, cancellation and deletion. Run `npm run inventory:durable`; inspect `artifacts/inventory-v2-report.json`. The unified workspace above exposes the same v2 APIs in the browser.
- [v2 semantic contract](semantic/v2/CONTRACT.md): opt-in lifecycle and approval semantics, fresh-clock revalidation and exact model/state/request bindings. v1 remains unchanged.
- [Durable Effect adapter](docs/durable-execution.md): SQLite transactions, persisted pending requests/grants/outcomes, internal receipt authority and pull/ack outbox. Local host identities are simulated, not authenticated.

- **[Inventory application](docs/inventory.md):** declared reserve/cancel/expire, competing reservations, an actual overselling mutant and verified replay. Open `artifacts/inventory.html`; watch `artifacts/inventory-demo.mp4`.
- [Shared executable semantics](docs/semantic-core.md): typed data-only actions, separate policies/preconditions, grouped prestate updates, implicit events and stale-commit rejection. Inventory and the small `semantic/issues.mjs` fixture use this interpreter; the original live issue workspace retains its existing runtime.
- [Effect adapter](docs/effect-adapter.md): pinned Effect 4.1.4, synchronized in-memory publication and committed-command deduplication.
- [Inventory adapter evidence](docs/inventory-adapters.md): actual Effect conformance and an AST-derived Lean capacity/conservation kernel. The theorem excludes concurrency, authorization and reservation-slot updates.
- [Generated Lean adapter](docs/generated-lean.md): restricted translation, independent laws, witnesses, differential tests and fail-closed unsupported cases.

- **[Live issue workspace](docs/live-workspace.md):** browser-local create/assign/comment/resolve, related inbox and contextual Why. Build with `npm run live:build`; open `artifacts/live-issues.html`.
- [Live domain runtime](docs/live-runtime.md): shared declarations drive input validation, role policies, tool schemas, event explanations and notification routing. This is a finite experimental action set, not a general compiler.
- [Live declaration derivations](docs/live-derivations.md): exact role/routing impact previews and isolated generated contract checks.
- [Live generated histories](docs/live-generated-tests.md): seeded action histories, independent expected outcomes and replay parity.
- [Autonomous work log](docs/autonomous-work.md): completed iterations, assumptions and remaining decisions.
- [Latest verification checkpoint](docs/verification-checkpoint.md): executed checks, coverage and evidence limits.

- [Workbench guide](docs/workbench.md): interactive policy editing, causal replay and minimized failure inspection.
- [Property-testing adapter](docs/property-testing.md): seeded histories, shrinking and independent state-machine oracle.
- [Lean pilot](docs/lean-pilot.md): checked theorem scope, assumptions and reproducible commands.

- [Project checkpoint](docs/status.md): conversation decisions, research performed and current scope.
- [Derived capability backlog](docs/design/derived-capabilities.md): all eight endorsed additional directions.
- [Executable prototype](prototype/README.md): the first issue-tracker semantic slice and its commands.

- [Design brief](docs/design/brief.md): goals, constraints, architecture and open decisions.
- [Explanation and output contract](docs/design/outputs.md): domain maps, possible flows, concurrency, traces, storyboards and reproducibility.
- [Semantic laws and scenarios](docs/design/laws-and-scenarios.md): the initial behavioral contract and verification boundaries.
- [Verification research](docs/research/verification.md): Lean, Bend 2, Lynx, property testing, model checking and translation validation; includes a proposed adapter contract.
- [Language, UI and reactivity research](docs/research/language-ui-and-reactivity.md): distilled selected readings, design implications and source-specific limitations.
- [Ecosystem evidence](docs/research/ecosystem.md): earlier Ash, Alchemy, Distilled and Foldkit investigation.
- [Tardigrade reference](docs/research/tardigrade.md): reactive atoms, external-effect lifecycles, typed capabilities and generated service trajectories.
- [Roadmap](docs/roadmap.md): next experiments and acceptance criteria.
- [Illustrative explanation package](examples/explanation-package.json): hand-authored fixture demonstrating the proposed machine-readable output. It is not a generated or verified execution.

## Specialist agents

OpenCode V2 project agents live in `.opencode/agents/` and inherit the selected session model:

- `semantics`: domain language, laws, effects and interop contracts.
- `verification`: property tests, formal models, proof obligations and correspondence.
- `interaction`: rich workspace UI and renderer conformance.
- `reactivity`: relationship dependencies, event routing and durable execution.
- `explanations`: causal graphs, agent-readable explanations and video storyboards.
- `evidence-review`: independent source and guarantee review.

Ask the primary agent to use a specialist for a scoped task. Each specialist starts from the relevant local memos and follows original sources where the decision needs more detail. They must report what was read, inferred, proposed, tested or proved separately.

## Working method

The research is for agents to digest and apply, not a reading assignment for the user. Keep short decision summaries in the design documents and detailed source evidence in research memos. Do not confuse a large bibliography with research depth.

No dependencies are required to read this repository. Execution uses Node's built-in TypeScript support and test runner, a locally installed pinned Effect package, and Lean 4.19.0 for generated proof checks. Tests concern the experimental profiles, not the proposed full language. Correspondence between generated Lean and runtime remains unproved.

## Reproduce the demonstration

Complete local workspace:

```sh
npm run adapters:install
npm run workspace         # http://127.0.0.1:4173, persistent profile databases
npm run workspace:test    # isolated data, two browser sessions, restart/reconnect
npm run durable:generated # six seeded histories + exact replay and mutation checks
npm run workspace:video   # continuous v1/v2 browser recording
```

`WORKSPACE_DIR` selects a data directory and `PORT` selects the port. Startup
preserves existing databases. Actor selection and clocks are explicit local
simulation inputs. See the completion checkpoint for the supported profile limits.

Shared-core inventory and adapters:

```sh
npm run adapters:install
npm test                  # includes generated Lean checks; requires Lean 4.19.0
npm run inventory:durable # actual SQLite approval/reopen/resume acceptance
npm run proof:inventory    # writes artifacts/inventory-proof/report.json
npm run inventory:build
npm run inventory:test    # existing Playwright tooling
npm run inventory:video   # also requires ffmpeg
```

The Lean runner defaults to the local toolchain described in
[generated Lean](docs/generated-lean.md); set `LEAN` to another 4.19.0 executable.
The inventory browser is dependency-free and offline; Effect and Lean execute in
the Node/toolchain adapters, not in that browser page.

The durable adapter uses Node's built-in `node:sqlite` (executed on Node 25.2.0).
Its restart/transaction evidence is conditional on SQLite and local-filesystem
locking/durability. External delivery, model upgrades, authentication and v2 Lean
proofs are not implemented; existing numeric proofs apply only to v1.

Current live application:

```sh
npm test
npm run live:generated
npm run live:build
npm run live:test    # Playwright/axe tooling; see docs/live-workspace.md
npm run live:video  # continuous cursor-visible MP4; also requires ffmpeg
```

Open `artifacts/live-issues.html`. Browser storage is local to that browser/file
origin; use Export for a portable workspace. Unsent drafts survive UI navigation
within the session, but are not saved across a reload. History is read-only.

Earlier isolated approval/Lean workbench:

```sh
npm test
npm run demo
npm run properties
npm run proof       # requires pinned Lean; see docs/lean-pilot.md
npm run workbench
npm run test:browser # requires Playwright and axe tooling; see docs/workbench.md
```

`npm run showcase` runs the first five steps, stopping on any failed check. Open `artifacts/workbench.html` for the full offline application. The browser uses actual executions precomputed at build time; it does not invoke a server or prover. Regenerate after changing source or evidence. All implementation/research delegates for this expansion used Sol 6.1 or Luna 6; Astra coordinated integration.
