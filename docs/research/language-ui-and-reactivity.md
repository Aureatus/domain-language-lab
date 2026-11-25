# Language, UI, reactivity, and explainable execution

Research memo · 2026-11-11 · design proposals, not implementation claims

## Conclusion

The strongest foundation for Premise is a semantic model with several faithful projections: domain declarations, executable Effect programs, Alchemy resource plans, interaction models, maintained queries, and explanations. A rich T3 Code workspace should navigate those projections using shared identities. It should not infer application behavior from component trees or turn every relationship update into a notification side effect.

Three distinctions are essential:

1. A **maintained result** can retract; a **delivered message** cannot generally be undone.
2. An **effect description** says what computation may do; a **capability** grants authority to do something specific.
3. A **possible flow**, an **observed execution**, and a **presentation sequence** are different artifacts.

The laws below are proposed contracts for this language unless explicitly identified as source laws. They are mathematical sketches, not settled syntax or verified properties of Effect, Alchemy, Ash, or T3 Code. Those projects' implementations were not inspected for this memo.

## Sources actually read

This is a selective synthesis, not a claim to have read entire books or specifications. Linked sections were retrieved and read on the date above; sources are mutable unless their dated version is specified.

| Source | Read depth | Contribution |
| --- | --- | --- |
| Martin Fowler, [Domain Specific Languages](https://martinfowler.com/books/dsl.html), 2010; [Semantic Model catalog entry](https://martinfowler.com/dslCatalog/semanticModel.html) | Full book landing-page overview and short pattern intent; **not** book chapters | DSL/library layering, internal versus external syntax, communication with domain experts |
| W3C, [Introduction to Model-Based User Interfaces](https://www.w3.org/TR/2014/NOTE-mbui-intro-20140107/) | Introduction, Cameleon model levels and transformations, benefits, car-rental and digital-home examples, Story Editor, Post-WIMP Widgets | Separate task/domain, abstract interaction, concrete interaction, and final implementation models |
| W3C, [SCXML Recommendation](https://www.w3.org/TR/2015/REC-scxml-20150901/) | Overview; §3.1; core state, parallel, final, history and legal-configuration definitions; §3.13 transition selection/execution; §4.2 raise | Hierarchical behavior, explicit transition priorities, run-to-completion boundaries, cancellation on state exit |
| Foster et al., [Combinators for Bi-Directional Tree Transformations](https://www.cis.upenn.edu/~bcpierce/papers/newlenses-popl.pdf), POPL 2005, found through [Pierce's lenses bibliography](https://www.cis.upenn.edu/~bcpierce/papers/index.shtml#Lenses) | Abstract, §1 introduction, §2 address-book example, §3 lens definitions/laws/totality, opening composition discussion | Lawful view updates; retained information; limits of general inversion |
| [Differential Dataflow book](https://timelydataflow.github.io/differential-dataflow/), [print view](https://timelydataflow.github.io/differential-dataflow/print.html) | Motivation and management-relation example; change inputs; interactivity/probes; map, filter, concat, consolidate, join, reduce/distinct, iterate, arrange overview; input/time/probe sections; graph connectivity and standing queries | Signed changes, multiplicities, convergence, maintained relational dependencies, progress boundaries |
| Daan Leijen, [The Koka Programming Language](https://koka-lang.github.io/koka/doc/book.html), retrieved version dated 2026-09-17 | §2.2 Effect Typing and §2.3 Effect Handlers, including map and yield/handler examples | Distinguish effectful computation from interpretation; effect polymorphism and handler-introduced effects |
| Endo, [SES README](https://github.com/endojs/endo/blob/master/packages/ses/README.md) | Overview/POLA, Lockdown, Harden, Compartment, Compartment + Lockdown, isolation/endowment claims and caveats | Explicit authority, confinement boundaries, mutable closure state, limits of compartments |
| Leslie Lamport, [Time, Clocks, and the Ordering of Events in a Distributed System](https://lamport.azurewebsites.net/pubs/time-clocks.pdf), CACM 1978 | Abstract, introduction, “The Partial Ordering,” opening “Logical Clocks” discussion | Causal partial orders rather than fictitious global sequences |

Access notes: the E rights “Ode to Capabilities” URL failed with a transport error; an Agoric capability-guide URL returned 404. Neither is used as evidence. Endo's accessible primary project documentation supplies the capability material. PDFs were read through text extraction; diagrams and complete proofs were not reviewed. No Petri-net source was read, so no Petri-net-specific result is claimed.

## 1. Fowler: put semantics behind the notation

**Insight.** Fowler describes DSLs as focused languages layered over libraries, with communication—not necessarily direct end-user programming—as a major benefit. The Semantic Model catalog identifies the model populated by a DSL. Together these support making the meaning reusable independently of the syntax.

**Design implication.** Give resources, relationships, actions, policies, queries, interaction tasks, and deployment requirements stable semantic identities. A textual declaration and a visual relationship editor should produce the same validated model. Runtime lowering and explanation generation consume that model; explanations should not reverse-engineer generated TypeScript.

**Concrete law.** If two authoring frontends elaborate to equivalent semantic models, their observable domain behavior must agree under the same inputs and interpreters:

`elaborate(text) ≅ elaborate(editor) ⇒ observe(run(text)) = observe(run(editor))`.

Source spans, formatting, and editor layout can differ. Domain meaning cannot silently depend on which editor authored it.

**Limitation.** The landing page and one-line pattern entry do not establish a compiler architecture or a soundness theorem. A language spanning domains, UI, deployment, and orchestration can lose DSL focus. Use composable semantic regions with explicit boundaries rather than pretending every host-language feature is statically understandable.

## 2. Model-based UI: preserve intent without standardizing every pixel

**Insight.** The W3C note separates tasks/domain objects, modality-independent abstract interaction, modality-dependent concrete interaction, and technology-specific final UI. Its Story Editor derives interaction patterns from workflow shape; its Post-WIMP examples explicitly reject the assumption of a permanently fixed widget set. Runtime models can also explain why a UI behaves as it does.

**Design implication.** Define a workspace interaction model with concepts such as inspect an entity, compare versions, navigate a relationship, review a proposed action, explore a causal trace, and focus an artifact. A renderer adapter chooses tabs, split panes, drawers, diagrams, keyboard interactions, or native controls. Keep layout and visual overrides at the appropriate layer with traceable mappings.

For T3 Code, the desired workspace is a coordinated collection of rich surfaces: relationship explorer, record/detail editor, query result table, action inspector, flow view, trace timeline, explanation/document preview, and media storyboard. A shared selection identifies the same domain entity across surfaces. This is richer than generating CRUD forms from fields.

**Concrete scenario/law.** Selecting `Deployment D` in a graph and in a table yields the same semantic selection and action context. If a renderer advertises support for `inspectDeployment`, the semantic result of the interaction must agree with that task's contract. It need not use identical geometry or identical gestures. Unsupported tasks must be declared, rather than silently dropped.

`decodeRendererAction(encodeRendererAction(intent)) = intent` for supported intents.

**Limitation.** This is a Working Group Note, not a universal UI implementation standard or evidence that generated interfaces are automatically usable. Abstract task preservation does not prove accessibility, focus behavior, visual hierarchy, or responsive quality. Those remain renderer obligations. The note itself warns about consistency when transformed models are subsequently edited by hand.

## 3. SCXML: lifecycle semantics need more than named states

**Insight.** SCXML defines legal active-state configurations, descendant-versus-ancestor transition priority, conflict through overlapping exit sets, and exit/action/entry ordering. A macrostep drains internal work to a stable configuration before another external event is processed. Its parallel regions are simultaneously active but processed in a defined serial order; they are not a model of arbitrary distributed execution.

**Design implication.** Use explicit state-machine semantics for workspace interaction lifecycles and bounded action coordination: editing, validating, submitting, awaiting result, failed, cancelled. Define cancellation ownership and stale-result handling. Do not map a visual `parallel` region directly to unrestricted concurrent Effect fibers without specifying the different semantics.

**Concrete scenario/law.** A record inspector enters `loading(entity=A, generation=7)`, then navigates to B. Exiting A's loading state cancels its owned request. Even if the provider ignores cancellation and returns A late, the UI accepts the result only when the entity and generation still match. SCXML supplies the lifecycle/cancellation precedent; the generation check is our additional contract.

For each local microstep: `exit actions ≺ transition actions ≺ entry actions`. A macrostep can contain multiple microsteps, including entry followed by exit of an intermediate state; no next external event is processed halfway through that macrostep. Eventless transition loops need rejection, a bounded-step diagnostic, or an explicit divergence outcome.

**Limitation.** A local run-to-completion boundary does not establish database atomicity, remote cancellation, exactly-once effects, or distributed ordering. Guard scripts can make reachability analysis intractable. Static tools should distinguish known reachability from conservative possibilities.

## 4. Lenses: writable projections must say how information survives

**Insight.** The lens paper's address-book example preserves hidden URLs when editing visible phone numbers. A projection is often lossy; updating it needs both the new view and the old source. The paper makes GetPut and PutGet fundamental and PutPut an additional, optional law; not every lens in its language satisfies PutPut.

**Design implication.** Use lens-like bindings only for projections with declared update semantics. A relationship view or aggregate chart does not become writable merely because it is queryable. Expose named domain actions where there are multiple plausible interpretations, such as changing the total budget across several projects.

**Source laws**, written for total lenses on their declared domains, with `put(source, view)` notation:

- GetPut: `put(s, get(s)) = s`.
- PutGet: `get(put(s, v)) = v`.
- Optional stronger PutPut: `put(put(s, v1), v2) = put(s, v2)`.

**Concrete scenario.** Editing a deployment's display name through a compact card must preserve its hidden provider identifier. Updating a filtered relationship list must define whether removing a visible member unlinks the relationship, deletes the underlying resource, or merely changes the filter; absent that contract, the UI offers explicit actions instead.

**Limitation.** Lens laws alone do not resolve concurrent edits, authorization, validation failures, or remote transactions. Scope them to a versioned editable draft and accepted values. Submission uses a domain action with a version precondition; a conflict is an explicit outcome, not a false PutGet guarantee. Command histories and notification delivery should not be forced into PutPut because their intermediate actions matter.

## 5. Differential dataflow: relationships can drive maintained answers

**Insight.** The management example shows a single edge change affecting downstream skip-level relations. It even distinguishes an unchanged ultimate manager from a changed intermediate explanation. Updates carry `(data, logical time, signed difference)`. Joins multiply multiplicities; consolidation combines physical updates; distinct restores set semantics. Progress probes determine when earlier logical times can no longer change. Standing queries are themselves inputs that can be installed and removed.

**Design implication.** Treat relevant relationship paths as maintained queries. For example, derive deployment recipients from deployment → project → memberships, intersected with preferences and policy. Track dependency and provenance edges so the workspace can answer both “what changed?” and “why does this recipient qualify?” A simpler incremental engine may implement these semantics initially; this source does not require adopting the Rust runtime.

**Concrete laws/scenarios.** For a pure query Q, a valid input change Δ, and a completed logical epoch:

`Q(D + Δ) = Q(D) + ΔQ(D, Δ)`.

This is incremental/full-recomputation equivalence, not an assertion that Q is linear. For a join whose two inputs change, the delta must include both single-input terms and the cross term `ΔR ⋈ ΔS`.

If recipient U has two supporting membership paths, removing one path changes support count from 2 to 1 but must not remove U from the recipient set. Removing the final path does. If one supporting path is replaced with another in the same completed epoch, the recipient set may remain unchanged while its explanation changes.

Use separate maintained outputs for recipient identity and supporting reasons; do not send again merely because a reason changes. Pure recomputation and dependency traversal have no permission to deliver messages.

**Notification boundary.** A proposed event-scoped rule selects recipients at an explicit committed snapshot/version and persists delivery intents with a stable key such as `(domainEventId, recipientId, channel, ruleVersion)`. Retry reuses the key. Later relationship changes update live projections, but do not retroactively unsend mail or automatically replay every historical event. Event-time versus delivery-time eligibility, late-data handling, and revocation are domain decisions that need named policies. A transactional outbox/idempotent consumer is a proposed delivery design, not a result supplied by the dataflow book.

**Limitation.** Differential maintenance does not confer exactly-once delivery, transactional source capture, or complete causal provenance. A frontier is a progress guarantee only for participating inputs; it says nothing about undisclosed upstream data. Recursive closure needs convergence rules; unrestricted path multiplicities can grow forever on cycles. Adopt explicit set/bag semantics, finite-domain restrictions or convergence contracts, and diagnostic outcomes for unsupported recursion.

## 6. Koka: effects belong in the semantic contract

**Insight.** Koka's overview gives function types argument, effect, and result components. Its map example propagates the callback's effect. Its yield handler discharges `yield` while introducing `console`; interpreting an operation is not equivalent to making all effects disappear. It also distinguishes total functions from computations that may throw or diverge.

**Design implication.** Separate pure domain calculations from commands and foreign operations. Record possible failures, service requirements, cancellation behavior, and effect categories in the semantic model. Lower executable operations to Effect interpreters; describe infrastructure requirements separately for Alchemy planning. Explanation and preview interpreters can collect proposed operations without applying them.

**Concrete law/scenario.** Higher-order composition must not hide callback effects. Interpreting `sendNotification` using a production adapter leaves the adapter's network/failure behavior visible; interpreting it with a preview adapter records a proposed delivery and performs no delivery. An operation advertised as a pure derived field cannot call that adapter through an unchecked escape hatch.

**Limitation.** Koka's compiler-checked effect guarantees do not transfer automatically to TypeScript or Effect. Effect's typed error/environment channels are not, by themselves, a complete static inventory of side effects in arbitrary JavaScript. Imported code needs an explicit contract, and unknown effects remain unknown. No Koka handler implementation or type-system proof was reviewed here.

## 7. Capabilities: scope interop by authority as well as by type

**Insight.** SES compartments begin without host APIs such as fetch. Endowments supply authority explicitly. Hardened object surfaces can still close over mutable state, and lockdown does not remove powerful globals from the initial host environment. Confinement depends on the boundary and the objects passed through it.

**Design implication.** Foreign integrations receive narrow handles such as “read this project's deployment status” or “enqueue this approved notification,” not a universal application context. Include operation signatures, declared effects, resource scope, lifetime, cancellation and tracing obligations in interop contracts. Scoped capability wrappers must mediate invocation, not just label it in generated documentation.

**Concrete law/scenario.** A renderer plugin endowed only with `readDeployment(D)` cannot mutate D or enumerate other projects through that handle. Delegating an attenuated capability must not increase its authority: `authority(child) ⊆ authority(parent)`. A preview interpreter receives no live delivery capability. Scope closure can reject subsequent calls through a revocable wrapper; it does not undo calls already committed remotely.

**Limitation.** Type annotations are not confinement. SES cannot prevent arbitrary CPU consumption or memory exhaustion within its shared JavaScript agent, and host endowments can accidentally grant excessive power. Ordinary in-process imports retain their ambient authority unless actually isolated. Keep “declared/scoped by convention” distinct from “runtime-enforced” in interop explanations.

## 8. Lamport: flow explanations must preserve partial order

**Insight.** Happened-before is generated by local process order, message send-to-receive edges, and transitivity. Events with neither ordering are concurrent. A drawing's vertical placement or a sorted log does not prove causality.

**Design implication.** Maintain separate graphs with explicit edge kinds:

- **Domain graph:** entities and relationships.
- **Dependency graph:** query/action inputs and derived values.
- **Possible-flow graph:** permitted transitions, alternatives, joins, retries and unknown foreign regions.
- **Observed causal graph:** concrete operation instances, parent/spawn/join links, message correlation, commits and delivery attempts.
- **Presentation sequence:** a chosen traversal for documents or video.

Derive flow analysis from declared operations, state transitions, dependencies and known adapter contracts. Mark whether an edge is declared, conservatively inferred, or observed. A relationship is not automatically an execution prerequisite; an effect annotation is not an observed effect.

**Concrete scenario/law.** After a deployment commits, documentation export and notification preparation can start concurrently. A storyboard may show export first for clarity, but cannot caption it “therefore notification started” unless an actual dependency exists. A topological presentation must respect every known happened-before edge: `a → b ⇒ position(a) < position(b)`. Missing instrumentation means “ordering unknown,” not proof of independence.

**Limitation.** A partial order does not choose a scheduler or prove two actions commute. For static reordering claims, require known read/write sets, external effects and resource conflicts. A generated graph is an analysis surface, not a liveness proof. Petri-net-style token/join analysis remains a possible future formalization, not a conclusion of this reading.

## Integrated design scenario: one change, several truthful views

Suppose deployment D belongs to project P; people subscribe through team membership. A user submits a versioned deployment action from the workspace.

1. The interaction model supplies the action identity and validated draft. The renderer submits intent, not direct database mutation.
2. The action's interpreter checks domain policy and commits a new deployment version. Foreign provider calls retain explicit effect and capability contracts.
3. Maintained queries update project summaries and eligible-recipient sets at a recorded logical epoch. Removing one of two membership paths does not remove the recipient.
4. Event-scoped notification policy creates deduplicated delivery intents. Delivery attempts are separate trace events; live query retractions do not masquerade as unsent emails.
5. The workspace links a summary card, relationship path, action declaration, and observed trace by stable IDs. “Why notified?” shows the qualifying path and policy version actually used, not today's relationship graph reconstructed after the fact.
6. A generated flow document shows possible retries and cancellation; an execution explanation shows the retry that occurred. Unknown foreign behavior stays visibly opaque.
7. A storyboard highlights the same IDs in a selected topological order, with concurrent branches marked as concurrent. Captions and narration derive claims from the same evidence records.

## Video-ready output contract

Proposed export is a structured explanation package, not a claim that a rendered video exists:

- Model/version identifiers, source references and stable node IDs.
- Scenario inputs, observed event IDs and provenance snapshots.
- Scene records: focus nodes, highlighted edges, caption, narration, evidence references, transition and suggested duration.
- Explicit labels for observed execution, hypothetical example and editorial pacing.
- Renderer-independent diagram data plus concrete layout metadata for a chosen export renderer.
- Redaction policy applied to every derived surface, including captions and narration.

**Consistency contract:** every factual scene claim resolves to a model element, an observed event, or a clearly labeled assumption. Exporting or replaying the package is observational and must not re-execute domain commands. Fixed model/trace/layout inputs should produce reproducible scene ordering; editorial durations are not runtime timing measurements.

## Decisions this reading supports

Adopt a shared semantic model, renderer-independent interaction tasks, lawful editable projections, explicit command/effect boundaries, relationship-driven maintained queries, and evidence-backed explanation records. Preserve multiplicities, progress/version boundaries, authority scope, and causal order in the model rather than repairing their loss in the UI.

Keep open—but explicit—the exact language syntax, supported query recursion, transaction and delivery guarantees, frontend edit-conflict policy, enforcement level of foreign-code isolation, and completeness of static flow analysis. These sources inform those choices; they do not settle them or validate a particular implementation.
