// Renderer/tool projections only: authorization and transitions stay in the core.
export function deriveTools(model) {
  return Object.entries(model.actions).map(([name, action]) => ({
    name, inputs: structuredClone(action.inputs),
    policyIds: action.policies.map(x => x.id),
    preconditionIds: action.preconditions.map(x => x.id),
  }));
}

export function deriveDependencies(model) {
  return Object.entries(model.actions).map(([actionId, action]) => {
    const bindings = new Map([...action.bindings, ...(action.inserts ?? [])].map(x => [x.id, x.resource]));
    return {actionId, observations: action.observe.map(x => ({
      binding: x.binding, resource: bindings.get(x.binding),
      ...model.relationships.find(r => r.id === x.relationship), relationship: x.relationship,
    })), writes: [
      ...action.updates.map(x => ({semanticId: x.id, resource: bindings.get(x.target), field: x.field, kind: 'change'})),
      ...(action.inserts ?? []).map(x => ({semanticId: x.id, resource: x.resource, kind: 'create'})),
      ...(action.deletes ?? []).map(x => ({semanticId: x.id, resource: bindings.get(x.target), kind: 'delete'})),
    ]};
  });
}

/** View dependencies are not human notification subscriptions. In particular,
 * actor exclusion in the core's recipient snapshot must not suppress its UI. */
export function deriveChange(model, events, {sequence, pending = false, reason = 'commit'} = {}) {
  const invalidations = new Map(), recipients = new Map();
  const add = value => invalidations.set(JSON.stringify(value), value);
  const dependencies = deriveDependencies(model);
  for (const event of events) {
    add({view: 'history'});
    const dependency = dependencies.find(x => x.actionId === event.actionId);
    if (!dependency) throw new TypeError('Unknown event action dependency.');
    // No-op assignments still advance record versions even without change facts.
    if (event.kind === 'action') for (const write of dependency.writes) add({view: 'resource', resource: write.resource});
    if (event.kind !== 'action') {
      // Facts determine the changed entity; declarations determine its consumers.
      const write = dependency.writes.find(x => x.semanticId === event.semanticId);
      if (!write || write.resource !== event.resource) throw new TypeError('Unknown event write dependency.');
      add({view: 'resource', resource: event.resource, key: event.key});
      for (const observation of dependency.observations.filter(x => x.resource === event.resource)) {
        add({view: 'relationship', relationship: observation.relationship, resource: event.resource, key: event.key});
      }
    }
    for (const recipient of event.recipients) recipients.set(recipient.recipient, recipient);
  }
  if (pending) add({view: 'pending'});
  return {sequence, invalidations: [...invalidations.values()], recipients: [...recipients.values()], reason};
}
