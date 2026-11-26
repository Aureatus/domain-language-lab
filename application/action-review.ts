import type { Value } from "../semantic/v2/types.ts";
import type { WalkthroughEvent } from "./action-walkthrough.ts";
import { inboxFor } from "./client.ts";
import type { ApplicationReceipt, ApplicationSnapshot } from "./client.ts";
import { buildInvocation, inputDefaults } from "./derive.ts";
import type { ApplicationContract, deriveApplication } from "./derive.ts";
import { loadingPlan, loadingPresentation } from "./loading.ts";
import { acceptsSnapshot } from "./snapshot.ts";
import { submissionStep, submissionControls } from "./submission.ts";
import type { SubmissionBody, SubmissionState } from "./submission.ts";
import { viewRecords } from "./view-records.ts";

// Finite search for a useful *example*, never a claim that approval is unreachable.
export function exampleArgs(
  { runtime, contract, initialState }: ReturnType<typeof deriveApplication>,
  action: string,
  actor: string
) {
  const defaults = inputDefaults(contract, action, initialState, actor);
  const inputs = [defaults];

  const declaration = Object.hasOwn(contract.actions, action)
    ? contract.actions[action]
    : undefined;

  if (!declaration) {
    throw Error("Unknown action.");
  }

  for (const f of declaration.fields.filter((f) => !f.hidden)) {
    const x = defaults[f.name];

    let choices: readonly Value[] =
      f.schema.type === "string" ? (f.schema.enum ?? []) : [];

    if (
      f.widget === "date" &&
      typeof x === "string" &&
      Number.isFinite(Date.parse(x))
    ) {
      choices = Array.from({ length: 10 }, (_, i) =>
        new Date(Date.parse(x) + (i + 1) * 86400000).toISOString().slice(0, 10)
      );
    }

    if (f.schema.type === "integer") {
      choices = [
        ...Array.from(
          { length: 10 },
          (_, i) => (typeof x === "number" ? x : 0) + i + 1
        ),
        f.schema.max,
      ].filter((value): value is number => Number.isSafeInteger(value));
    }

    if (f.schema.type === "boolean") {
      choices = [!x];
    }

    for (const value of choices) {
      inputs.push({ ...defaults, [f.name]: value });
    }
  }

  for (const args of inputs) {
    let invocation;

    try {
      invocation = buildInvocation(contract, {
        action,
        actor,
        args,
        id: "review-preview",
        clock: 0,
      });
    } catch {
      continue;
    }

    if (runtime.prepare(initialState, invocation).status === "pending") {
      return {
        args,
        selection: "bounded preview found approval-required inputs",
      };
    }
  }

  return {
    args: defaults,
    selection:
      "declared defaults; bounded preview did not find an approval example",
  };
}

// Fold only what the viewer has observed. In particular, a snapshot never
// supplies a transport receipt for this submission.
export type ReviewEvent = (
  | WalkthroughEvent
  | { type: "open" | "refresh-start" }
  | { type: "switch"; actor: string }
  | { type: "refresh-end"; snapshot: ApplicationSnapshot }
) & {
  actor?: string;
  policyId?: string;
  body?: SubmissionBody;
  id?: string;
  message?: string;
  snapshot?: ApplicationSnapshot;
  result?: ApplicationReceipt;
};

type Receipt = {
  submissionId: string;
  invocationId: string;
  status: string;
  code: string | null;
};

type ReviewForm = {
  submission: SubmissionState<Receipt>;
  receipt: Receipt | null;
  body?: SubmissionBody;
  id?: string;
  evidence: { phase: string; status: string; invocationId: string } | null;
};

export function actionReview(
  contract: ApplicationContract,
  actor: string,
  action: string,
  { mutant }: { mutant?: string } = {}
) {
  if (mutant !== undefined && mutant !== "snapshot-unlocks") {
    throw Error("Unknown review mutant.");
  }

  const forms = new Map<string, ReviewForm>();

  function formFor(owner: string) {
    const existing = forms.get(owner);

    if (existing) {
      return existing;
    }

    const form: ReviewForm = {
      submission: { phase: "editing" },
      receipt: null,
      evidence: null,
    };

    forms.set(owner, form);

    return form;
  }

  let viewer = actor;
  let snapshot: ApplicationSnapshot | undefined;
  let refreshPending = false;
  let number = 0;

  const regions = loadingPlan(contract);

  return (event: ReviewEvent) => {
    const { type, result } = event;

    if (
      ![
        "open",
        "switch",
        "refresh-start",
        "refresh-end",
        "draft",
        "submit",
        "lost",
        "check",
        "receipt",
        "grant",
        "complete",
        "snapshot",
        "invalid",
        "unavailable",
        "blocked",
      ].includes(type)
    ) {
      throw Error("Unknown review event.");
    }

    if (type === "switch") {
      if (!contract.actors.some((a) => a.id === event.actor)) {
        throw Error("Unknown review viewer.");
      }

      viewer = event.actor;
    }

    const visible = formFor(viewer);

    const outcome =
      type === "receipt" || type === "grant" || type === "complete";

    if (outcome) {
      const inv = result?.evidence?.invocation;
      const form = inv && forms.get(inv.actor);

      const phase = { receipt: "execute", grant: "grant", complete: "resume" }[
        type
      ];

      if (
        !form ||
        !result?.evidence ||
        result.evidence.phase !== phase ||
        result.status !== result.evidence.outcome?.status ||
        inv?.action !== action ||
        (type !== "receipt" &&
          (!form.receipt || inv.id !== form.receipt.invocationId))
      ) {
        throw Error("Outcome evidence does not match selected command.");
      }

      if (
        type === "grant" &&
        !result.snapshot?.pending
          .find((p) => p.id === inv.id)
          ?.requirements.some(
            (r) =>
              r.policyId === event.policyId && r.approvers.includes(event.actor)
          )
      ) {
        throw Error("Grant requirement mismatch.");
      }

      if (type === "receipt") {
        const id = form.submission.id;

        if (!id || result.submissionId !== id) {
          throw Error("Unexpected submission receipt.");
        }

        const receipt = {
          submissionId: id,
          invocationId: inv.id,
          status: result.status,
          code: result.code ?? null,
        };

        form.submission = submissionStep(form.submission, {
          type: "found",
          result: receipt,
        });
        form.receipt = receipt;
      }

      form.evidence = {
        phase: result.evidence.phase,
        status: result.status,
        invocationId: inv.id,
      };
    }

    if (type === "draft") {
      if (
        event.body?.actor !== viewer ||
        event.body?.action !== action ||
        !event.id
      ) {
        throw Error("Draft selection mismatch.");
      }

      visible.body = event.body;
      visible.id = event.id;
    }

    if (type === "submit") {
      if (!visible.id || !visible.body) {
        throw Error("Missing submission identity or command.");
      }

      visible.submission = submissionStep(visible.submission, {
        type,
        id: visible.id,
        body: visible.body,
      });
      visible.receipt = null;
      visible.evidence = null;
    }

    if (type === "lost" || type === "check" || type === "invalid") {
      visible.submission = submissionStep(
        visible.submission,
        type === "invalid" ? { type, message: event.message } : { type }
      );
    }

    // Do not apply an inactive form's transport snapshot to the current viewer.
    const next =
      !outcome || result?.evidence?.invocation.actor === viewer
        ? (event.snapshot ?? (type === "grant" ? null : result?.snapshot))
        : null;

    if (
      next &&
      acceptsSnapshot(snapshot, next, snapshot?.contractId ?? next.contractId)
    ) {
      snapshot = next;

      // Negative control for conformance tests ONLY; snapshots are not receipts.
      if (
        mutant === "snapshot-unlocks" &&
        type === "snapshot" &&
        visible.submission.phase === "unknown"
      ) {
        visible.submission = { phase: "editing" };
      }
    }

    if (type === "refresh-start") {
      refreshPending = true;
    }

    if (type === "refresh-end") {
      refreshPending = false;
    }

    const { submission, receipt, body, evidence } = visible;

    const current = snapshot;
    const loaded = !!current;
    const controls = submissionControls(submission);

    controls.submit &&= !!current?.availability[viewer]?.[action] && !!body;

    return {
      step: ++number,
      event: type,
      viewer,
      performedBy: event.actor ?? null,
      policyId: event.policyId ?? null,
      message: event.message ?? null,
      source:
        type === "grant"
          ? "runner observed approver response"
          : next || result || type === "invalid"
            ? "recorded backend"
            : "simulated interaction",
      submission: submission.phase,
      draft: body?.args ?? null,
      controls,
      receipt,
      evidence,
      snapshotVersion: snapshot?.snapshotVersion ?? null,
      views: regions.map(({ index, label, strategy }) => {
        const view = contract.views[index];

        if (!view) {
          throw Error("Missing review view.");
        }

        return {
          label,
          ...loadingPresentation(strategy, {
            owned: loaded,
            pending: !loaded || refreshPending,
            failed: false,
          }),
          records: current
            ? viewRecords(current, view, viewer).map(([id, r]) => ({
                id,
                fields: Object.fromEntries(
                  view.columns.map((c) => [c.field, r.values[c.field]])
                ),
              }))
            : [],
        };
      }),
      inbox: current
        ? inboxFor(current, viewer)
            .filter((p) => p.status === "pending")
            .map((p) => ({
              id: p.id,
              requester: p.invocation.actor,
              requirements: p.requirements,
              grants: p.grants,
            }))
        : [],
    };
  };
}
