// Renderer/tool projections only: authorization and transitions stay in the core.
import type { Model as V1Model } from "../semantic/types.ts";
import type {
  Event,
  FieldSchema,
  Model as V2Model,
  Recipient,
} from "../semantic/v2/types.ts";

type Model = V1Model | V2Model;

function actionEntries(
  model: Model
): [string, V1Model["actions"][string] | V2Model["actions"][string]][] {
  return Object.entries<
    V1Model["actions"][string] | V2Model["actions"][string]
  >(model.actions);
}

type Invalidation = {
  view: "history" | "pending" | "snapshot" | "resource" | "relationship";
  resource?: string;
  relationship?: string;
  key?: string;
};

export type WorkspaceChange = {
  sequence?: number;
  invalidations: Invalidation[];
  recipients: Recipient[];
  reason: string;
};

export function deriveTools(model: Model): {
  name: string;
  inputs: Readonly<Record<string, FieldSchema>>;
  policyIds: string[];
  preconditionIds: string[];
}[] {
  return actionEntries(model).map(([name, action]) => ({
    name,
    inputs: structuredClone(action.inputs),
    policyIds: action.policies.map((x) => x.id),
    preconditionIds: action.preconditions.map((x) => x.id),
  }));
}

export function deriveDependencies(model: Model) {
  return actionEntries(model).map(([actionId, action]) => {
    const inserts = "inserts" in action ? action.inserts : [];
    const deletes = "deletes" in action ? action.deletes : [];

    const bindings = new Map(
      [...action.bindings, ...inserts].map((x) => [x.id, x.resource])
    );

    return {
      actionId,
      observations: action.observe.map((x) => ({
        binding: x.binding,
        resource: bindings.get(x.binding),
        ...model.relationships.find((r) => r.id === x.relationship),
        relationship: x.relationship,
      })),
      writes: [
        ...action.updates.map((x) => ({
          semanticId: x.id,
          resource: bindings.get(x.target),
          field: x.field,
          kind: "change",
        })),
        ...inserts.map((x) => ({
          semanticId: x.id,
          resource: x.resource,
          kind: "create",
        })),
        ...deletes.map((x) => ({
          semanticId: x.id,
          resource: bindings.get(x.target),
          kind: "delete",
        })),
      ],
    };
  });
}

/** View dependencies are not human notification subscriptions. In particular,
 * actor exclusion in the core's recipient snapshot must not suppress its UI. */
export function deriveChange(
  model: Model,
  events: readonly Event[],
  {
    sequence,
    pending = false,
    reason = "commit",
  }: { sequence?: number; pending?: boolean; reason?: string } = {}
): WorkspaceChange {
  const invalidations = new Map<string, Invalidation>();
  const recipients = new Map<string, Recipient>();

  const add = (value: Invalidation) =>
    invalidations.set(JSON.stringify(value), value);

  const dependencies = deriveDependencies(model);

  for (const event of events) {
    add({ view: "history" });
    const dependency = dependencies.find((x) => x.actionId === event.actionId);

    if (!dependency) {
      throw new TypeError("Unknown event action dependency.");
    }

    // No-op assignments still advance record versions even without change facts.
    if (event.kind === "action") {
      for (const write of dependency.writes) {
        if (write.resource === undefined) {
          throw new TypeError("Unknown event write dependency.");
        }

        add({ view: "resource", resource: write.resource });
      }
    }

    if (event.kind !== "action") {
      // Facts determine the changed entity; declarations determine its consumers.
      const write = dependency.writes.find(
        (x) => x.semanticId === event.semanticId
      );

      if (!write || write.resource !== event.resource) {
        throw new TypeError("Unknown event write dependency.");
      }

      add({ view: "resource", resource: event.resource, key: event.key });

      for (const observation of dependency.observations.filter(
        (x) => x.resource === event.resource
      )) {
        add({
          view: "relationship",
          relationship: observation.relationship,
          resource: event.resource,
          key: event.key,
        });
      }
    }

    for (const recipient of event.recipients) {
      recipients.set(recipient.recipient, recipient);
    }
  }

  if (pending) {
    add({ view: "pending" });
  }

  return {
    ...(sequence === undefined ? {} : { sequence }),
    invalidations: [...invalidations.values()],
    recipients: [...recipients.values()],
    reason,
  };
}
