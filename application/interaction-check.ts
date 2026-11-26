import { isDeepStrictEqual as equal } from "node:util";

import { errorMessage } from "../errors.ts";
import { actionReview } from "./action-review.ts";
import type { ReviewEvent } from "./action-review.ts";
import { walkthrough } from "./action-walkthrough.ts";
import type { WalkthroughEvent } from "./action-walkthrough.ts";
import type { ApplicationContract } from "./derive.ts";

type Observation = ReturnType<ReturnType<typeof actionReview>>;

// All linear extensions of these small causal graphs. Events contain actual
// fixture data; only their observation order is varied. No generated receipts.
function* orders<T>(chains: T[][], prefix: T[] = []): Generator<T[]> {
  if (chains.every((c) => !c.length)) {
    yield prefix;

    return;
  }

  for (const [i, [first, ...rest]] of chains.entries()) {
    if (first !== undefined) {
      yield* orders(
        chains.map((other, j) => (i === j ? rest : other)),
        [...prefix, first]
      );
    }
  }
}

function* schedules(
  events: WalkthroughEvent[],
  peer: string | undefined
): Generator<{ name: string; events: ReviewEvent[] }> {
  const at = events.findIndex((e) => e.type === "submit");
  const receiptAt = events.findIndex((e) => e.type === "receipt");

  if (at === -1 || receiptAt === -1) {
    yield { name: "recorded only", events };

    return;
  }

  yield { name: "recorded", events };

  const base = events.slice(0, at + 1);
  const tail = events.slice(receiptAt + 1);
  const snap = events.slice(at + 1).find((e) => e.type === "snapshot");

  const lost = events.find((e) => e.type === "lost");
  const check = events.find((e) => e.type === "check");
  const receipt = events.find((e) => e.type === "receipt");

  if (!lost || !check || !receipt || !snap) {
    throw new Error("Incomplete recorded recovery");
  }

  const recovery = [lost, check, receipt];

  for (const seq of orders([recovery, [snap]])) {
    yield { name: "snapshot / recovery", events: [...base, ...seq, ...tail] };
  }

  // Refresh starts after loss; its result cannot precede the refresh request.
  for (const seq of orders<ReviewEvent>([
    recovery.slice(1),
    [
      { type: "refresh-start" },
      { type: "refresh-end", snapshot: snap.snapshot },
    ],
  ])) {
    yield {
      name: "refresh / reconciliation",
      events: [...base, lost, ...seq, ...tail],
    };
  }

  if (peer) {
    const draft = base.find((e) => e.type === "draft");

    if (!draft?.body || !draft.id) {
      throw new Error("Missing recorded draft");
    }

    const { body, id } = draft;
    const peerArgs = snap.snapshot.defaults[peer]?.[body.action];

    const peerDraft: ReviewEvent[] =
      snap.snapshot.availability[peer]?.[body.action] && peerArgs
        ? [
            {
              type: "draft",
              body: { actor: peer, action: body.action, args: peerArgs },
              id: `peer-${id}`,
            },
          ]
        : [];

    yield {
      name: "late owner receipt",
      events: [
        ...base,
        lost,
        check,
        { type: "switch", actor: peer },
        ...peerDraft,
        receipt,
        { type: "switch", actor: body.actor },
        ...tail,
      ],
    };
  }
}

// The oracle follows input facts and required observable behavior. It does
// not consult the implementation's transition table or mutate its state.
export function interactionOracle(actor: string) {
  let unresolved = false;
  let canCheck = false;
  let refresh = false;
  let viewer = actor;

  let draft: Observation["draft"] | undefined;
  let id: string | undefined;
  let visibleReceipt: string | undefined;

  let grantState: unknown;
  let peerBeforeReceipt: unknown;
  let content: unknown;
  let last: Observation | undefined;

  return (event: ReviewEvent, step: Observation) => {
    const previous = last;
    last = step;

    if (
      (event.type === "submit" || event.type === "check") &&
      !previous?.controls[event.type]
    ) {
      return "interaction.disabled-command";
    }

    if (event.type === "switch") {
      viewer = event.actor;
    }

    if (event.type === "draft" && viewer === actor) {
      draft = event.body.args;
      ({ id } = event);
    }

    if (event.type === "submit") {
      unresolved = true;
    }

    if (event.type === "lost") {
      canCheck = true;
    }

    if (event.type === "check") {
      canCheck = false;
    }

    if (event.type === "invalid") {
      unresolved = false;
    }

    if (event.type === "receipt") {
      unresolved = false;
      visibleReceipt = event.result.status;
    }

    if (event.type === "refresh-start") {
      refresh = true;
    }

    if (event.type === "refresh-end") {
      refresh = false;
    }

    const owner = viewer === actor;

    if (step.viewer !== viewer) {
      return "viewer.selection";
    }

    if (owner && unresolved && (step.controls.submit || step.receipt)) {
      return "submission.no-fresh-submit-before-receipt";
    }

    if (
      owner &&
      unresolved &&
      (step.controls.check !== canCheck || step.controls.retry)
    ) {
      return "submission.recovery-controls";
    }

    if (owner && draft && !equal(draft, step.draft)) {
      return "draft.retained";
    }

    if (
      owner &&
      visibleReceipt &&
      (step.receipt?.submissionId !== id ||
        step.receipt?.status !== visibleReceipt)
    ) {
      return "submission.original-receipt";
    }

    if (!owner) {
      if (
        step.receipt ||
        step.evidence ||
        step.controls.check ||
        step.controls.retry ||
        step.submission !== "editing"
      ) {
        return "submission.owner-isolation";
      }

      const form = {
        draft: step.draft,
        controls: step.controls,
        views: step.views,
        inbox: step.inbox,
      };

      if (event.type === "receipt" && !equal(form, peerBeforeReceipt)) {
        return "submission.late-response-changed-viewer";
      }

      if (
        (event.type === "switch" && step.draft !== null) ||
        (event.type === "draft" && !equal(step.draft, event.body.args))
      ) {
        return "draft.viewer-isolation";
      }

      peerBeforeReceipt = form;
    }

    if (
      refresh &&
      step.views.some(
        (v) =>
          v.phase !== "refreshing" || !v.showContent || v.placeholder !== null
      )
    ) {
      return "refresh.retains-content";
    }

    if (
      refresh &&
      previous?.viewer === viewer &&
      previous.snapshotVersion === step.snapshotVersion &&
      !equal(
        previous.views.map((v) => v.records),
        step.views.map((v) => v.records)
      )
    ) {
      return "refresh.records-lost";
    }

    if (owner) {
      const records = step.views.map((v) => v.records);

      if (
        (event.type === "refresh-start" || event.type === "grant") &&
        !equal(content, records)
      ) {
        return "view.records-changed-without-update";
      }

      content = records;
    }

    if (event.type === "grant" && event.result.status === "approved") {
      if (!event.result.snapshot) {
        throw new Error("Missing grant snapshot.");
      }

      if (
        visibleReceipt !== "pending" ||
        !equal(event.result.snapshot.state, grantState)
      ) {
        return "approval.grant-is-not-completion";
      }

      if (
        step.evidence?.status !== "approved" ||
        step.receipt?.status !== "pending"
      ) {
        return "approval.grant-presentation";
      }
    }

    if (event.type === "receipt") {
      if (!event.result.snapshot) {
        throw new Error("Missing receipt snapshot.");
      }

      grantState = event.result.snapshot.state;
    }

    return null;
  };
}

export async function checkInteractions(
  declaration: unknown,
  contract: ApplicationContract,
  command: Parameters<typeof walkthrough>[1],
  options: Parameters<typeof actionReview>[3] = {}
) {
  const events: WalkthroughEvent[] = [];

  for await (const event of walkthrough(declaration, command)) {
    events.push(event);
  }

  const peer = contract.actors.find((x) => x.id !== command.actor)?.id;

  let shortest: {
    rule: string;
    family: string;
    events: ReviewEvent[];
    observed: Observation | undefined;
  } | null = null;

  let count = 0;
  let observations = 0;

  const families = new Set();

  for (const schedule of schedules(events, peer)) {
    count += 1;
    families.add(schedule.name);

    const fold = actionReview(contract, command.actor, command.action, options);
    const check = interactionOracle(command.actor);

    fold({ type: "open" });

    for (const [i, event] of schedule.events.entries()) {
      observations += 1;
      let rule;
      let step: Observation | undefined;

      try {
        step = fold(event);
        rule = check(event, step);
      } catch (error) {
        rule = `projection.error: ${errorMessage(error)}`;
      }

      if (rule) {
        if (!shortest || i + 1 < shortest.events.length) {
          shortest = {
            rule,
            family: schedule.name,
            events: schedule.events.slice(0, i + 1),
            observed: step,
          };
        }

        break;
      }
    }
  }

  const exercised =
    events.some((e) => e.type === "receipt") &&
    !events.some((e) => e.type === "blocked");

  return {
    status: shortest ? "failed" : exercised ? "bounded-pass" : "not-exercised",
    schedules: count,
    observations,
    families: [...families],
    approval: events.some(
      (e) => e.type === "grant" && e.result.status === "approved"
    ),
    grantAttempted: events.some((e) => e.type === "grant"),
    completed: events.some(
      (e) => e.type === "complete" && e.result.status === "committed"
    ),
    counterexample: shortest,
  };
}
