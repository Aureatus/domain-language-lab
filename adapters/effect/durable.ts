import * as Effect from 'effect/Effect';
import * as Context from 'effect/Context';
import * as Layer from 'effect/Layer';
import { DatabaseSync } from 'node:sqlite';
import { createInterpreter, jsonSnapshot, validateState } from '../../semantic/core.ts';
import { createInterpreter as createV2, validateState as validateV2State } from '../../semantic/v2/core.ts';
import {
  decodeJson,
  decodeJsonValue,
  encodeCanonicalJson as canonical,
  DurableEventSchema,
  DurableInvocationSchema,
  DurableOutcomeSchema,
  DurableOperationOutcomeSchema,
  DurablePendingRequestSchema,
  DurableReceiptSchema,
} from './json.ts';

const profile = model => {
  switch (model?.format) {
    case 'semantic-core/v1': return { create: createInterpreter, validate: validateState };
    case 'semantic-core/v2': return { create: createV2, validate: validateV2State };
    default: throw new TypeError('Unsupported semantic model format.');
  }
};

const FORMAT = 'durable-effect/v1';
const decodeWith = (schema, text) => jsonSnapshot(decodeJson(schema, text));
const decodeOutcome = (text, model) => {
  const value = decodeWith(DurableOutcomeSchema, text);
  profile(model).validate(model, value.state);
  return value;
};
const conflict = result => ({ status: 'rejected', code: 'invocation-conflict', reason: 'Invocation ID already has a different command or model.' , state: result?.state });

function initialize(db) {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS durable_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS durable_invocations (
      id TEXT PRIMARY KEY, model_key TEXT NOT NULL, command_key TEXT NOT NULL,
      command_json TEXT NOT NULL, outcome_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS durable_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      event_json TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS durable_operations (
      id TEXT PRIMARY KEY, model_key TEXT NOT NULL, command_key TEXT NOT NULL,
      outcome_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS durable_pending (
      invocation_id TEXT PRIMARY KEY REFERENCES durable_invocations(id),
      request_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','consumed')),
      resume_id TEXT
    );
    CREATE TABLE IF NOT EXISTS durable_grants (
      invocation_id TEXT NOT NULL REFERENCES durable_pending(invocation_id),
      policy_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE REFERENCES durable_operations(id),
      receipt_json TEXT NOT NULL, PRIMARY KEY(invocation_id,policy_id)
    );`);
}

function validateStored(db, modelKey, model) {
  const meta = Object.fromEntries(db.prepare('SELECT key,value FROM durable_meta').all().map(x => [x.key, x.value]));
  if (!meta.format) return null;
  if (meta.format !== FORMAT) throw new Error(`Unsupported durable store format: ${meta.format}`);
  if (meta.model_key !== modelKey) throw new Error('Durable store is bound to different model content.');
  const state = profile(model).validate(model, jsonSnapshot(decodeJsonValue(meta.state_json)));
  if (canonical(state) !== meta.state_json) throw new Error('Stored state is not canonical JSON.');
  return state;
}

/** Open a synchronous SQLite store. Caller owns the database file and filesystem durability policy. */
export const makeDurableStore = (path, { busyTimeout = 5000 } = {}) => Effect.try({
  try: () => {
    const db = new DatabaseSync(path, { timeout: busyTimeout });
    initialize(db);
    return db;
  }, catch: error => error,
});

export const makeDurableRuntime = model => profile(model).create(model);

/** Effect wrapper; SQLite operations are synchronous and cannot be interrupted mid-call. */
export const durableExecute = (runtime, db, invocation, { beforeCommit } = {}) => Effect.try({
  try: () => {
    const command = jsonSnapshot(invocation);
    const modelKey = canonical(runtime.model);
    db.exec('BEGIN IMMEDIATE');
    try {
      const hasStore = db.prepare('SELECT value FROM durable_meta WHERE key=?').get('format');
      if (!hasStore) {
        throw new Error('Durable store has not been initialized; call initializeDurableState first.');
      }
      if (db.prepare('SELECT id FROM durable_operations WHERE id=?').get(command.id)) {
        db.exec('COMMIT'); return conflict();
      }
      const previous = db.prepare('SELECT model_key,command_key,outcome_json FROM durable_invocations WHERE id=?').get(command.id);
      if (previous) {
        db.exec('COMMIT');
        if (previous.model_key === modelKey && previous.command_key === canonical(command))
          return { status: 'duplicate', result: decodeOutcome(previous.outcome_json, runtime.model) };
        return conflict();
      }
      const current = validateStored(db, modelKey, runtime.model);
      const result = runtime.execute(current, command);
      const snapshot = jsonSnapshot(result);
      const state = result.state;
      const stateJson = canonical(state);
      db.prepare('UPDATE durable_meta SET value=? WHERE key=?').run(stateJson, 'state_json');
      db.prepare('INSERT INTO durable_invocations(id,model_key,command_key,command_json,outcome_json) VALUES(?,?,?,?,?)')
        .run(command.id, modelKey, canonical(command), canonical(command), canonical(snapshot));
      if (runtime.model.format === 'semantic-core/v2' && result.status === 'pending') {
        db.prepare("INSERT INTO durable_pending(invocation_id,request_json,status) VALUES(?,?,'pending')")
          .run(command.id, canonical(result.request));
      }
      if (result.status === 'committed') {
        const insert = db.prepare('INSERT INTO durable_outbox(event_id,event_json) VALUES(?,?)');
        for (const event of result.events) insert.run(event.id, canonical(event));
      }
      if (beforeCommit) beforeCommit(snapshot);
      db.exec('COMMIT');
      return snapshot;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may already have ended */ }
      throw error;
    }
  }, catch: error => error,
});

/** Create/replace only the initial binding, never an arbitrary running-state setter. */
export const initializeDurableState = (runtime, db, initialState) => Effect.try({
  try: () => {
    const state = profile(runtime.model).validate(runtime.model, initialState);
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT value FROM durable_meta WHERE key=?').get('format');
      if (existing) throw new Error('Durable store is already initialized.');
      const put = db.prepare('INSERT INTO durable_meta(key,value) VALUES(?,?)');
      put.run('format', FORMAT); put.run('model_key', canonical(runtime.model)); put.run('state_json', canonical(state));
      db.exec('COMMIT');
      return state;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }, catch: error => error,
});

export const durableState = (runtime, db) => Effect.try({
  try: () => { db.exec('BEGIN'); try { const state = validateStored(db, canonical(runtime.model), runtime.model); db.exec('COMMIT'); if (state === null) throw new Error('Durable store is not initialized.'); return state; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } }, catch: error => error,
});

const exactKeys = (value, required, optional = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)))
    throw new TypeError('Unexpected or missing operation members.');
};
const identity = value => {
  if (typeof value !== 'string' || !value.length || value.length > 1000)
    throw new TypeError('Expected a nonempty bounded identity.');
};
const requireV2 = runtime => {
  if (runtime.model.format !== 'semantic-core/v2') throw new TypeError('Approval operations require semantic-core/v2.');
};
const rejected = (code, reason) => ({status: 'rejected', code, reason});
const decodeOperation = (text, runtime) => {
  const value = decodeWith(DurableOperationOutcomeSchema, text);
  if (value.status === 'committed') return decodeOutcome(text, runtime.model);
  if (value.status === 'rejected') {
    if (Object.hasOwn(value, 'state')) profile(runtime.model).validate(runtime.model, value.state);
    return value;
  }
  const {request, policyId, approver} = value.receipt;
  const checked = runtime.approve(request, {policyId, approver});
  if (checked.status === 'approved' && canonical(checked) === canonical(value)) return value;
  throw new Error('Malformed stored operation outcome.');
};

function operation(runtime, db, command, beforeCommit, derive) {
  const modelKey = canonical(runtime.model), commandKey = canonical(command);
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT * FROM durable_operations WHERE id=?').get(command.id);
    if (previous) {
      const result = previous.model_key === modelKey && previous.command_key === commandKey
        ? {status: 'duplicate', result: decodeOperation(previous.outcome_json, runtime)} : conflict();
      db.exec('COMMIT'); return result;
    }
    if (db.prepare('SELECT id FROM durable_invocations WHERE id=?').get(command.id)) {
      db.exec('COMMIT'); return conflict();
    }
    const state = validateStored(db, modelKey, runtime.model);
    if (state === null) throw new Error('Durable store is not initialized.');
    const pending = db.prepare('SELECT * FROM durable_pending WHERE invocation_id=?').get(command.invocationId);
    const result = jsonSnapshot(!pending ? rejected('missing-request', 'No persisted approval request.')
      : pending.status === 'consumed' ? rejected('consumed', 'Approval request already resumed.')
      : derive(state, pending));
    db.prepare('INSERT INTO durable_operations(id,model_key,command_key,outcome_json) VALUES(?,?,?,?)')
      .run(command.id, modelKey, commandKey, canonical(result));
    // The operation row precedes the grant row because of its foreign key.
    if (command.kind === 'approve' && result.status === 'approved') {
      db.prepare('INSERT INTO durable_grants(invocation_id,policy_id,operation_id,receipt_json) VALUES(?,?,?,?)')
        .run(command.invocationId, command.policyId, command.id, canonical(result.receipt));
    }
    if (command.kind === 'resume' && result.status === 'committed') {
      db.prepare('UPDATE durable_meta SET value=? WHERE key=?').run(canonical(result.state), 'state_json');
      db.prepare("UPDATE durable_pending SET status='consumed',resume_id=? WHERE invocation_id=?")
        .run(command.id, command.invocationId);
      const insert = db.prepare('INSERT INTO durable_outbox(event_id,event_json) VALUES(?,?)');
      for (const event of result.events) insert.run(event.id, canonical(event));
    }
    if (beforeCommit) beforeCommit(result);
    db.exec('COMMIT'); return result;
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

/** authenticatedApprover must come from the trusted host, never a client receipt. */
export const durableApprove = (runtime, db, source, host) => Effect.try({
  try: () => {
    requireV2(runtime);
    const command = jsonSnapshot(source);
    exactKeys(command, ['id', 'invocationId', 'policyId']);
    exactKeys(host, ['authenticatedApprover'], ['beforeCommit']);
    for (const key of ['id', 'invocationId', 'policyId']) identity(command[key]);
    identity(host.authenticatedApprover);
    return operation(runtime, db, {...command, kind: 'approve', authenticatedApprover: host.authenticatedApprover}, host.beforeCommit, (_state, pending) => {
      if (db.prepare('SELECT policy_id FROM durable_grants WHERE invocation_id=? AND policy_id=?').get(command.invocationId, command.policyId))
        return rejected('already-granted', 'Policy already has a persisted grant.');
      return runtime.approve(decodeWith(DurablePendingRequestSchema, pending.request_json), {policyId: command.policyId, approver: host.authenticatedApprover});
    });
  }, catch: error => error,
});

/** No receipt parameter: only receipts from the transactional grant ledger are used. */
export const durableResume = (runtime, db, source, options = {}) => Effect.try({
  try: () => {
    requireV2(runtime);
    const command = jsonSnapshot(source);
    exactKeys(command, ['id', 'invocationId', 'clock']); exactKeys(options, [], ['beforeCommit']);
    identity(command.id); identity(command.invocationId);
    if (!Number.isSafeInteger(command.clock) || command.clock < 0) throw new TypeError('Expected a nonnegative safe clock.');
    return operation(runtime, db, {...command, kind: 'resume'}, options.beforeCommit, (state, pending) => {
      const original = db.prepare('SELECT command_json FROM durable_invocations WHERE id=?').get(command.invocationId);
      const receipts = db.prepare('SELECT receipt_json FROM durable_grants WHERE invocation_id=? ORDER BY policy_id').all(command.invocationId)
        .map(row => decodeWith(DurableReceiptSchema, row.receipt_json));
      return runtime.resume(state, decodeWith(DurableInvocationSchema, original.command_json), decodeWith(DurablePendingRequestSchema, pending.request_json), receipts, {clock: command.clock});
    });
  }, catch: error => error,
});

/** Read-only CLI/UI projection; grants in this projection confer no authority. */
export const durablePending = (runtime, db, invocationId) => Effect.try({
  try: () => {
    requireV2(runtime); identity(invocationId);
    db.exec('BEGIN');
    try {
      if (validateStored(db, canonical(runtime.model), runtime.model) === null) throw new Error('Durable store is not initialized.');
      const pending = db.prepare('SELECT * FROM durable_pending WHERE invocation_id=?').get(invocationId);
      const grants = db.prepare('SELECT receipt_json FROM durable_grants WHERE invocation_id=? ORDER BY policy_id').all(invocationId)
        .map(row => { const receipt = decodeWith(DurableReceiptSchema, row.receipt_json); return {policyId: receipt.policyId, approver: receipt.approver}; });
      const result = pending ? jsonSnapshot({invocationId, status: pending.status, request: decodeWith(DurablePendingRequestSchema, pending.request_json), grants, resumeId: pending.resume_id}) : null;
      db.exec('COMMIT'); return result;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }, catch: error => error,
});

/** Pull ordered unacknowledged facts. A crash after delivery and before ack can redeliver. */
export const pullOutbox = (db, { limit = 100 } = {}) => Effect.try({
  try: () => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
    return db.prepare('SELECT sequence,event_id,event_json FROM durable_outbox WHERE acknowledged=0 ORDER BY sequence LIMIT ?')
      .all(limit).map(row => ({ sequence: row.sequence, eventId: row.event_id, event: decodeWith(DurableEventSchema, row.event_json) }));
  }, catch: error => error,
});
export const acknowledgeOutbox = (db, sequence) => Effect.try({
  try: () => { if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('sequence must be a positive safe integer'); return db.prepare('UPDATE durable_outbox SET acknowledged=1 WHERE sequence=? AND acknowledged=0').run(sequence).changes === 1; }, catch: error => error,
});

export const closeDurableStore = db => Effect.try({ try: () => db.close(), catch: error => error });

export const DurableStore = Context.Service('DurableStore');
export const durableStoreLayer = path => Layer.scoped(DurableStore, Effect.acquireRelease(
  makeDurableStore(path), db => closeDurableStore(db),
));
