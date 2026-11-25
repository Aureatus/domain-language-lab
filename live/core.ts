/** Browser-local experimental runtime. No authentication or external delivery. */
const ROLES = ['lead', 'member'];
const PATHS = ['opener', 'assignee', 'watchers'];

export interface FieldSchema {
  type: string | string[];
  title?: string;
  label?: string;
  minLength?: number;
  maxLength?: number;
  default?: string;
  enum?: string[];
  reference?: 'issues' | 'users';
}
export interface Rule {
  label: string;
  allowedRoles: string[];
  notify: string[];
  inputs: {type: 'object'; properties: Record<string, FieldSchema>; required: string[]; additionalProperties: false};
}
export interface LiveModel {
  revision: number;
  actions: Record<string, Rule>;
}

const copy = value => JSON.parse(JSON.stringify(value));
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const snapshot = value => freeze(copy(value));
// Capabilities are keyed by actual runtime identity, never supplied raw state.
const runtimeInternals = new WeakMap();

/** Fork only runtime-owned, already validated immutable snapshots. No import bypass. */
export function forkApp(runtime, options: Record<string, unknown> = {}) {
  const capture = runtimeInternals.get(runtime);
  if (!capture) throw Error('Fork requires a trusted runtime');
  if (!object(options) || Object.keys(options).some(key => key !== 'clock')) throw Error('Unknown fork option');
  // Default to the parent's clock contract, without sampling it during the fork.
  const trusted = capture();
  return createRuntime({clock: options['clock'] ?? trusted.clock}, trusted);
}
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const WORKSPACE_FORMAT = 'live-issue-workspace/v1';
const SEED_VERSION = 1;
const MAX_STEPS = 500;
const MAX_DOCUMENT_LENGTH = 2_000_000;
const MAX_STATE_LENGTH = 8_000_000;
const sameJSON = (a, b) => a === b || (a !== null && b !== null && typeof a === 'object' &&
  typeof b === 'object' && Array.isArray(a) === Array.isArray(b) &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every(key => own(b, key) && sameJSON(a[key], b[key])));
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));

/** Reject lossy/non-JSON values before copying; inputs are data, never executable hooks. */
function workspaceDocument(document) {
  let nodes = 0;
  const ancestors = new Set();
  function inspect(value, depth = 0) {
    if (++nodes > 100_000 || depth > 20) throw Error('Workspace data is too complex');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      if (value.length > MAX_DOCUMENT_LENGTH) throw Error('Workspace document is too large');
      return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || value === null) throw Error('Workspace must contain only finite JSON data');
    if (ancestors.has(value)) throw Error('Workspace must not contain cycles');
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('Workspace must contain plain JSON objects');
    if (array && value.length > MAX_STEPS * 20) throw Error('Workspace array is too large');
    const keys = Reflect.ownKeys(value).filter(key => !(array && key === 'length'));
    if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) throw Error('Workspace arrays must be dense JSON arrays');
    ancestors.add(value);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !own(descriptor, 'value')) throw Error('Workspace must contain plain JSON properties');
      inspect(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  inspect(document);
  if (!exactKeys(document, ['format', 'seedVersion', 'journal'])) throw Error('Invalid workspace document schema');
  if (document.format !== WORKSPACE_FORMAT) throw Error('Unsupported workspace format/version');
  if (document.seedVersion !== SEED_VERSION) throw Error('Unsupported workspace seed version');
  if (!Array.isArray(document.journal) || document.journal.length > MAX_STEPS) throw Error('Invalid workspace journal or history limit exceeded');
  const encoded = JSON.stringify(document);
  if (encoded.length > MAX_DOCUMENT_LENGTH) throw Error('Workspace document is too large');
  return JSON.parse(encoded);
}
const text = (maxLength: number, extra: Partial<FieldSchema> = {}): FieldSchema => ({type: 'string', minLength: 1, maxLength, ...extra});
const issueId = text(80, {reference: 'issues'});
const inputs = (properties: Rule['inputs']['properties'], required: string[]): Rule['inputs'] => ({type: 'object', properties, required, additionalProperties: false});
const declaration = (label: string, properties: Rule['inputs']['properties'], required: string[], allowedRoles = ROLES, notify = PATHS): Rule =>
  ({label, allowedRoles: [...allowedRoles], notify: [...notify], inputs: inputs(properties, required)});

function initialModel(): LiveModel {
  return {revision: 1, actions: {
    create: declaration('Create issue', {
      title: text(160), description: {type: 'string', maxLength: 5000, default: ''},
      priority: {type: 'string', enum: ['normal', 'high'], default: 'normal'},
    }, ['title']),
    assign: declaration('Assign issue', {
      issueId, assignee: {type: ['string', 'null'], reference: 'users'},
    }, ['issueId', 'assignee'], ['lead']),
    comment: declaration('Add comment', {issueId, body: text(5000)}, ['issueId', 'body']),
    resolve: declaration('Resolve issue', {issueId}, ['issueId'], ['lead']),
    reopen: declaration('Reopen issue', {issueId}, ['issueId']),
    watch: declaration('Toggle watch', {issueId}, ['issueId'], ROLES, []),
  }};
}

function initialState() {
  return {
    users: [
      {id: 'u1', name: 'Maya Chen', role: 'lead'},
      {id: 'u2', name: 'Jonah Patel', role: 'member'},
      {id: 'u3', name: 'Sofia Reyes', role: 'member'},
    ],
    issues: [
      {id: 'i1', title: 'Checkout retries can create duplicate charges',
        description: 'A timed-out payment request is retried without reusing its idempotency key. Reproduce with the slow gateway fixture before shipping the retry patch.',
        status: 'open', priority: 'high', opener: 'u2', assignee: 'u3', watchers: ['u1', 'u2'], comments: [], version: 1},
      {id: 'i2', title: 'CSV export drops timezone offsets',
        description: 'Exported timestamps lose their UTC offset, making support reconciliation ambiguous. Preserve ISO 8601 offsets in the download.',
        status: 'open', priority: 'normal', opener: 'u3', assignee: 'u2', watchers: ['u3'], comments: [], version: 1},
    ], events: [], notifications: [],
  };
}

/** Validate this runtime's explicit schema subset; unknown constructs fail closed. */
function validate(schema: FieldSchema & Partial<Omit<Rule['inputs'], 'type'>>, value, state, path = 'args') {
  const supported = ['type', 'properties', 'required', 'additionalProperties', 'minLength', 'maxLength', 'enum', 'default', 'reference'];
  if (!object(schema) || Object.keys(schema).some(key => !supported.includes(key))) throw Error(`Unsupported schema at ${path}`);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some(type => !['object', 'string', 'null'].includes(type))) throw Error(`Unsupported schema type at ${path}`);
  const actual = value === null ? 'null' : object(value) ? 'object' : typeof value;
  if (!types.includes(actual)) throw Error(`${path} must be ${types.join(' or ')}`);
  if (actual === 'object') {
    if (!schema.properties || !object(schema.properties) || !Array.isArray(schema.required) || schema.additionalProperties !== false) throw Error(`Unsupported object schema at ${path}`);
    if (Object.keys(value).some(key => !own(schema.properties, key))) throw Error(`Unknown input at ${path}`);
    for (const key of schema.required) if (!own(value, key)) throw Error(`Missing ${path}.${key}`);
    const result = {};
    for (const [key, field] of Object.entries(schema.properties)) {
      if (own(value, key)) result[key] = validate(field, value[key], state, `${path}.${key}`);
      else if (own(field, 'default')) result[key] = validate(field, field.default, state, `${path}.${key}`);
    }
    return result;
  }
  if (actual === 'string') {
    if (schema.minLength && value.trim().length < schema.minLength) throw Error(`${path} must not be blank`);
    if (schema.maxLength && value.length > schema.maxLength) throw Error(`${path} is too long`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw Error(`Invalid ${path}`);
  if (schema.reference && value !== null) {
    if (!['users', 'issues'].includes(schema.reference)) throw Error(`Unsupported reference at ${path}`);
    if (!state[schema.reference].some(item => item.id === value)) throw Error(`Unknown ${schema.reference} ID: ${value}`);
  }
  return value;
}

/** Resolve event-time relationships, excluding the actor and retaining all support paths. */
function route(issue, rule, actorId) {
  const recipients = new Map();
  for (const path of rule.notify) {
    const ids = path === 'watchers' ? issue.watchers : [issue[path]];
    for (const id of ids) {
      if (!id || id === actorId) continue;
      if (!recipients.has(id)) recipients.set(id, {recipient: id, reasons: [], paths: []});
      const recipient = recipients.get(id);
      recipient.reasons.push(path);
      recipient.paths.push({from: issue.id, relationship: path, to: id});
    }
  }
  return [...recipients.values()];
}

/**
 * Create an isolated synchronous application with seeded examples.
 * @param {{clock?: () => number, workspace?: object}} [options]
 * @returns {object} Read-only state/model getters and dispatch, invokeTool, setRule,
 * tools, explain, explainAction and check methods. Commands return {ok:false,reason} on domain errors.
 */
export function createApp(options: Record<string, unknown> = {}) {
  return createRuntime(options);
}

function createRuntime(options: Record<string, unknown> = {}, trusted?) {
  if (!object(options) || Object.keys(options).some(key => !['clock', 'workspace'].includes(key))) throw Error('Unknown application option');
  const clockOption = options['clock'] ?? Date.now;
  if (typeof clockOption !== 'function') throw Error('clock must be a function');
  const clock = clockOption;
  let state = trusted?.state ?? snapshot(initialState());
  let model: LiveModel = trusted?.model ?? snapshot(initialModel());
  let journal = trusted?.journal ?? Object.freeze([]);
  let journalLength = trusted?.journalLength ?? JSON.stringify({format: WORKSPACE_FORMAT, seedVersion: SEED_VERSION, journal: []}).length;
  const initialVersions = trusted?.initialVersions ?? new Map(state.issues.map(issue => [issue.id, issue.version]));

  function appendCandidate(entry) {
    if (journal.length >= MAX_STEPS) throw Error('Workspace history limit exceeded');
    const frozen = snapshot(entry);
    const length = journalLength + JSON.stringify(frozen).length + (journal.length ? 1 : 0);
    if (length > MAX_DOCUMENT_LENGTH) throw Error('Workspace document is too large');
    return {journal: Object.freeze([...journal, frozen]), length};
  }

  function exportWorkspace() {
    return snapshot({format: WORKSPACE_FORMAT, seedVersion: SEED_VERSION, journal});
  }

  function reconstruct(document, count?: number) {
    const validated = workspaceDocument(document);
    const limit = count ?? validated.journal.length;
    let recordedTime;
    const candidate = createApp({clock: () => recordedTime});
    for (let index = 0; index < limit; index++) {
      const entry = validated.journal[index];
      const keys = entry?.kind === 'dispatch'
        ? ['step', 'kind', 'action', 'args', 'actorId', 'createdAt', 'eventId', 'issueId', 'revision']
        : ['step', 'kind', 'action', 'patch', 'revision'];
      if (!exactKeys(entry, keys) || entry.step !== index + 1 || !['dispatch', 'setRule'].includes(entry.kind)) throw Error(`Invalid journal step ${index + 1}`);
      if (typeof entry.action !== 'string') throw Error(`Invalid action at journal step ${index + 1}`);
      recordedTime = entry.createdAt;
      const result = entry.kind === 'dispatch'
        ? candidate.dispatch(entry.action, entry.args, entry.actorId)
        : candidate.setRule(entry.action, entry.patch);
      if (!result.ok) throw Error(`Journal step ${index + 1}: ${result.reason}`);
      if (!sameJSON(entry, runtimeInternals.get(candidate)().journal[index])) throw Error(`Inconsistent journal step ${index + 1}`);
    }
    return candidate;
  }

  function restoreWorkspace(document) {
    try {
      const candidate = reconstruct(document);
      const restored = runtimeInternals.get(candidate)();
      // All validation/replay/copying finishes before publishing any live replacement.
      state = candidate.state;
      model = candidate.model;
      journal = restored.journal;
      journalLength = restored.journalLength;
      return {ok: true as const};
    } catch (error) {
      return {ok: false as const, reason: error instanceof Error ? error.message : String(error)};
    }
  }

  function previewWorkspace(stepCount) {
    try {
      if (!Number.isInteger(stepCount) || stepCount < 0 || stepCount > journal.length) throw Error('Invalid workspace step count');
      const candidate = reconstruct(exportWorkspace(), stepCount);
      return {ok: true as const, state: candidate.state, model: candidate.model};
    } catch (error) {
      return {ok: false as const, reason: error instanceof Error ? error.message : String(error)};
    }
  }

  /** Shared, effect-free preparation. Policy precedes input/reference inspection. */
  function prepareAction(action, args, actorId) {
    let category = 'action';
    let missingRequirements: string[] = [];
    try {
      if (typeof action !== 'string' || !own(model.actions, action)) throw Error(`Unknown action: ${action}`);
      const rule = model.actions[action];
      category = 'actor';
      const actor = state.users.find(user => user.id === actorId);
      if (!actor) throw Error(`Unknown actor: ${actorId}`);
      category = 'policy';
      if (!rule.allowedRoles.includes(actor.role)) throw Error(`${rule.label} is not allowed for ${actor.role}`);
      category = 'schema';
      if (object(args)) missingRequirements = rule.inputs.required.filter(key => !own(args, key)).map(key => `args.${key}`);
      const values = validate(rule.inputs, args, state);
      const before = action === 'create' ? null : state.issues.find(issue => issue.id === values.issueId);
      category = 'precondition';
      if (action === 'resolve' && before.status !== 'open') throw Error('Issue is already resolved');
      if (action === 'reopen' && before.status !== 'resolved') throw Error('Issue is already open');
      if (action === 'assign' && before.assignee === values.assignee) throw Error('Assignee is unchanged');
      return {ok: true as const, rule, actor, values, before};
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {ok: false as const, reason, category: reason.startsWith('Missing args.') ? 'missing-input' : category, missingRequirements};
    }
  }

  function explainAction(action, args, actorId) {
    const prepared = prepareAction(action, args, actorId);
    // Never expose issue/actor records or supplied values in query output.
    return snapshot({available: prepared.ok, category: prepared.ok ? 'available' : prepared.category,
      reason: prepared.ok ? 'Current policy, inputs and preconditions pass; execution clock or resource limits may still fail.' : prepared.reason,
      revision: model.revision, source: typeof action === 'string' && own(model.actions, action) ? `actions.${action}` : null,
      missingRequirements: prepared.missingRequirements ?? [], scope: 'current-pre-execution'});
  }

  /** One candidate issue + event + inbox intents are published in one state replacement. */
  function dispatch(action, args, actorId) {
    try {
      const prepared = prepareAction(action, args, actorId);
      if (!prepared.ok) throw Error(prepared.reason);
      const {rule, actor, values, before} = prepared;
      let issue = before ? copy(before) : null;
      const createdAt = clock();
      if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || !Number.isFinite(new Date(createdAt).getTime())) throw Error('clock must return a finite number within the Date range');
      const eventId = `e${state.events.length + 1}`;
      // Only these small domain mutations are built in. Policy, validation,
      // tooling, routing and explanations all consume the current declaration.
      switch (action) {
        case 'create':
          issue = {id: `i${state.issues.length + 1}`, title: values.title, description: values.description,
            priority: values.priority, status: 'open', opener: actorId, assignee: null,
            watchers: [], comments: [], version: 1};
          break;
        case 'assign': issue.assignee = values.assignee; break;
        case 'comment': issue.comments.push({id: `c${state.events.length + 1}`, author: actorId, body: values.body, createdAt}); break;
        case 'resolve': issue.status = 'resolved'; break;
        case 'reopen': issue.status = 'open'; break;
        case 'watch': issue.watchers = issue.watchers.includes(actorId)
          ? issue.watchers.filter(id => id !== actorId) : [...issue.watchers, actorId]; break;
        default: throw Error(`Unsupported action implementation: ${action}`);
      }
      if (before) issue.version = before.version + 1;
      const changes = Object.keys(issue).filter(field => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(issue[field]))
        .map(field => ({field, before: before ? before[field] : null, after: issue[field]}));
      const recipients = route(issue, rule, actorId);
      const event = {id: eventId, action, actorId, issueId: issue.id, revision: model.revision,
        createdAt, args: values, actor, source: `actions.${action}`, rule,
        changes, recipients, relationshipSnapshot: {issueId: issue.id, version: issue.version,
          opener: issue.opener, assignee: issue.assignee, watchers: issue.watchers}};
      const notifications = recipients.map((recipient, index) => ({id: `${eventId}:n${index + 1}`,
        eventId, issueId: issue.id, recipient: recipient.recipient, action, reasons: recipient.reasons}));
      // Comment change evidence includes full before/after lists, so bound the
      // materialized state as well as the much smaller command journal.
      const encoded = JSON.stringify({...state,
         issues: before ? state.issues.map(item => item.id === issue.id ? issue : item) : [...state.issues, issue],
         events: [...state.events, event], notifications: [...state.notifications, ...notifications]});
      if (encoded.length > MAX_STATE_LENGTH) throw Error('Workspace materialized state is too large');
      const next = freeze(JSON.parse(encoded));
      const appended = appendCandidate({step: journal.length + 1, kind: 'dispatch', action, args: values,
        actorId, createdAt, eventId, issueId: issue.id, revision: model.revision});
      state = next;
      journal = appended.journal;
      journalLength = appended.length;
      return {ok: true as const, event: state.events.at(-1), value: state.issues.find(item => item.id === issue.id)};
    } catch (error) {
      return {ok: false as const, reason: error instanceof Error ? error.message : String(error)};
    }
  }

  if (own(options, 'workspace')) {
    const result = restoreWorkspace(options['workspace']);
    if (!result.ok) throw Error(result.reason);
  }

  const runtime = {
    get state() { return state; },
    get model() { return model; },
    dispatch,
    explainAction,
    invokeTool: dispatch,
    exportWorkspace,
    restoreWorkspace,
    previewWorkspace,
    setRule(action, patch) {
      if (typeof action !== 'string' || !own(model.actions, action)) return {ok: false as const, reason: `Unknown action: ${action}`};
      if (!object(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['allowedRoles', 'notify'].includes(key))) {
        return {ok: false as const, reason: 'Patch must contain only allowedRoles and/or notify'};
      }
      for (const [key, values] of Object.entries(patch)) {
        const allowed = key === 'allowedRoles' ? ROLES : PATHS;
        if (!Array.isArray(values) || Array.from(values).some(value => !allowed.includes(value)) || new Set(values).size !== values.length) {
          return {ok: false as const, reason: `Invalid ${key}`};
        }
      }
      try {
        const next = snapshot({...model, revision: model.revision + 1,
          actions: {...model.actions, [action]: {...model.actions[action], ...patch}}});
        const appended = appendCandidate({step: journal.length + 1, kind: 'setRule', action, patch, revision: next.revision});
        model = next;
        journal = appended.journal;
        journalLength = appended.length;
        return {ok: true as const};
      } catch (error) {
        return {ok: false as const, reason: error instanceof Error ? error.message : String(error)};
      }
    },
    tools() {
      return snapshot(Object.entries(model.actions).map(([name, rule]) => ({name, label: rule.label,
        description: rule.label, parameters: rule.inputs, inputs: rule.inputs,
        allowedRoles: rule.allowedRoles, notify: rule.notify, revision: model.revision})));
    },
    explain(eventId) { return state.events.find(event => event.id === eventId) ?? null; },
    check() { return checkState(state, initialVersions); },
  };
  runtimeInternals.set(runtime, () => ({state, model, journal, journalLength, clock, initialVersions}));
  return runtime;
}

/** Concrete current-state audits, not formal or exhaustive verification. */
function checkState(state, initialVersions) {
  const users = new Set(state.users.map(user => user.id));
  const issues = new Set(state.issues.map(issue => issue.id));
  const unique = rows => new Set(rows.map(row => row.id)).size === rows.length;
  const outcome = (name, ok) => ({name, ok});
  return [
    outcome('unique-record-ids', [state.users, state.issues, state.events, state.notifications].every(unique)),
    outcome('valid-issue-records', state.issues.every(issue =>
      ['open', 'resolved'].includes(issue.status) && ['normal', 'high'].includes(issue.priority) &&
      Number.isInteger(issue.version) && issue.version > 0 && users.has(issue.opener) &&
      (issue.assignee === null || users.has(issue.assignee)) &&
      new Set(issue.watchers).size === issue.watchers.length && issue.watchers.every(id => users.has(id)) &&
      unique(issue.comments) && issue.comments.every(comment => users.has(comment.author) && comment.body.trim().length > 0))),
    outcome('event-policy-snapshots-authorize', state.events.every(event =>
      users.has(event.actorId) && issues.has(event.issueId) && event.actor.id === event.actorId &&
      event.rule.allowedRoles.includes(event.actor.role) && event.revision >= 1)),
    outcome('event-routing-matches-snapshot', state.events.every(event =>
      JSON.stringify(event.recipients) === JSON.stringify(route({...event.relationshipSnapshot,
        id: event.issueId}, event.rule, event.actorId)))),
    outcome('one-notification-per-event-recipient', new Set(state.notifications.map(item => `${item.eventId}:${item.recipient}`)).size === state.notifications.length),
    outcome('notifications-match-event-intents', state.events.every(event => {
      const actual = state.notifications.filter(item => item.eventId === event.id);
      return actual.length === event.recipients.length && event.recipients.every(recipient => actual.some(item =>
        item.recipient === recipient.recipient && item.issueId === event.issueId && item.action === event.action &&
        users.has(item.recipient) && item.recipient !== event.actorId &&
        JSON.stringify(item.reasons) === JSON.stringify(recipient.reasons)));
    }) && state.notifications.every(item => state.events.some(event => event.id === item.eventId))),
    outcome('issue-version-matches-commits', state.issues.every(issue => issue.version ===
      state.events.filter(event => event.issueId === issue.id).length + (initialVersions.get(issue.id) ?? 0))),
  ];
}
