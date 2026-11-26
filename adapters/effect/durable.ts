import { DatabaseSync } from "node:sqlite";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ConstraintDecoder } from "effect/Schema";

import { errorMessage } from "../../errors.ts";
import {
  createInterpreter,
  jsonSnapshot,
  validateState,
} from "../../semantic/core.ts";
import type {
  Interpreter as V1Runtime,
  Model as V1Model,
} from "../../semantic/types.ts";
import {
  createInterpreter as createV2,
  validateState as validateV2State,
} from "../../semantic/v2/core.ts";
import type {
  ApprovalRequest,
  Interpreter as V2Runtime,
  Invocation as V2Invocation,
  InvocationInput,
  Model as V2Model,
  State as V2State,
  Value,
} from "../../semantic/v2/types.ts";
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
} from "./json.ts";

type Runtime = Readonly<V1Runtime> | Readonly<V2Runtime>;

type Model = V1Model | V2Model;

type Outcome = ReturnType<Runtime["execute"]>;

const isV2 = (runtime: Runtime): runtime is Readonly<V2Runtime> =>
  runtime.model.format === "semantic-core/v2";

function validateModelState(model: Model, source: unknown): V2State {
  switch (model.format) {
    case "semantic-core/v1":
      return validateState(model, source);
    case "semantic-core/v2":
      return validateV2State(model, source);
    default:
      throw new TypeError("Unsupported semantic model format.");
  }
}

const FORMAT = "durable-effect/v1";

const decodeWith = <S extends ConstraintDecoder<unknown>>(
  schema: S,
  text: unknown
): S["Type"] => jsonSnapshot(decodeJson(schema, text));

const decodeOutcome = (text: unknown, model: Model) => {
  const value = decodeWith(DurableOutcomeSchema, text);
  validateModelState(model, value.state);

  return value;
};

const conflict = (): {
  status: "rejected";
  code: "invocation-conflict";
  reason: string;
  state: undefined;
} => ({
  status: "rejected",
  code: "invocation-conflict",
  reason: "Invocation ID already has a different command or model.",
  state: undefined,
});

function initialize(db: DatabaseSync) {
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

function readStored<S>(
  db: DatabaseSync,
  modelKey: string,
  validate: (source: unknown) => S
): S | null {
  const meta = Object.fromEntries(
    db
      .prepare("SELECT key,value FROM durable_meta")
      .all()
      .map((row) => {
        const { key, value } = row;

        if (typeof key !== "string" || typeof value !== "string") {
          throw Error("Malformed durable store metadata.");
        }

        return [key, value];
      })
  );

  if (!meta["format"]) {
    return null;
  }

  if (meta["format"] !== FORMAT) {
    throw new Error(`Unsupported durable store format: ${meta["format"]}`);
  }

  if (meta["model_key"] !== modelKey) {
    throw new Error("Durable store is bound to different model content.");
  }

  const state = validate(jsonSnapshot(decodeJsonValue(meta["state_json"])));

  if (canonical(state) !== meta["state_json"]) {
    throw new Error("Stored state is not canonical JSON.");
  }

  return state;
}

function validateStored(
  db: DatabaseSync,
  modelKey: string,
  model: Model
): V2State | null {
  return readStored(db, modelKey, (source) =>
    validateModelState(model, source)
  );
}

/** Open a synchronous SQLite store. Caller owns the database file and filesystem durability policy. */
class DurableStoreError extends Data.TaggedError("DurableStoreError")<{
  message: string;
  cause?: unknown;
}> {}

const durableError = (cause: unknown) =>
  cause instanceof DurableStoreError
    ? cause
    : new DurableStoreError({ message: errorMessage(cause), cause });

export const makeDurableStore = (path: string, { busyTimeout = 5000 } = {}) =>
  Effect.try({
    try: () => {
      const db = new DatabaseSync(path, { timeout: busyTimeout });
      initialize(db);

      return db;
    },
    catch: durableError,
  });

export function makeDurableRuntime(model: V1Model): Readonly<V1Runtime>;
export function makeDurableRuntime(model: V2Model): Readonly<V2Runtime>;
export function makeDurableRuntime(model: unknown): Runtime;
export function makeDurableRuntime(model: unknown): Runtime {
  const format =
    model && typeof model === "object" && "format" in model
      ? model.format
      : undefined;

  if (format === "semantic-core/v1") {
    return createInterpreter(model);
  }

  if (format === "semantic-core/v2") {
    return createV2(model);
  }

  throw new TypeError("Unsupported semantic model format.");
}

function execute(
  runtime: Runtime,
  db: DatabaseSync,
  modelKey: string,
  command: InvocationInput
): Outcome {
  if (isV2(runtime)) {
    const state = readStored(db, modelKey, (source) =>
      validateV2State(runtime.model, source)
    );

    if (state !== null) {
      return runtime.execute(state, command);
    }
  } else {
    const state = readStored(db, modelKey, (source) =>
      validateState(runtime.model, source)
    );

    if (state !== null) {
      return runtime.execute(state, command);
    }
  }

  throw new DurableStoreError({ message: "Durable store is not initialized." });
}

/** Effect wrapper; SQLite operations are synchronous and cannot be interrupted mid-call. */
export const durableExecute = (
  runtime: Runtime,
  db: DatabaseSync,
  invocation: InvocationInput,
  { beforeCommit }: { beforeCommit?: (result: Outcome) => void } = {}
) =>
  Effect.try({
    try: () => {
      const command = jsonSnapshot(invocation);
      const modelKey = canonical(runtime.model);
      db.exec("BEGIN IMMEDIATE");

      try {
        const hasStore = db
          .prepare("SELECT value FROM durable_meta WHERE key=?")
          .get("format");

        if (!hasStore) {
          throw new DurableStoreError({
            message:
              "Durable store has not been initialized; call initializeDurableState first.",
          });
        }

        if (
          db
            .prepare("SELECT id FROM durable_operations WHERE id=?")
            .get(command.id)
        ) {
          db.exec("COMMIT");

          return conflict();
        }

        const previous = db
          .prepare(
            "SELECT model_key,command_key,outcome_json FROM durable_invocations WHERE id=?"
          )
          .get(command.id);

        if (previous) {
          db.exec("COMMIT");

          if (
            previous["model_key"] === modelKey &&
            previous["command_key"] === canonical(command)
          ) {
            const duplicate: {
              status: "duplicate";
              result: ReturnType<typeof decodeOutcome>;
            } = {
              status: "duplicate",
              result: decodeOutcome(previous["outcome_json"], runtime.model),
            };

            return duplicate;
          }

          return conflict();
        }

        const result = execute(runtime, db, modelKey, command);
        const snapshot = jsonSnapshot(result);
        const state = result.state;
        const stateJson = canonical(state);
        db.prepare("UPDATE durable_meta SET value=? WHERE key=?").run(
          stateJson,
          "state_json"
        );
        db.prepare(
          "INSERT INTO durable_invocations(id,model_key,command_key,command_json,outcome_json) VALUES(?,?,?,?,?)"
        ).run(
          command.id,
          modelKey,
          canonical(command),
          canonical(command),
          canonical(snapshot)
        );

        if (result.status === "pending" && "request" in result) {
          db.prepare(
            "INSERT INTO durable_pending(invocation_id,request_json,status) VALUES(?,?,'pending')"
          ).run(command.id, canonical(result.request));
        }

        if (result.status === "committed") {
          const insert = db.prepare(
            "INSERT INTO durable_outbox(event_id,event_json) VALUES(?,?)"
          );

          for (const event of result.events) {
            insert.run(event.id, canonical(event));
          }
        }

        if (beforeCommit) {
          beforeCommit(snapshot);
        }

        db.exec("COMMIT");

        return snapshot;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction may already have ended */
        }

        throw error;
      }
    },
    catch: durableError,
  });

/** Create/replace only the initial binding, never an arbitrary running-state setter. */
export const initializeDurableState = (
  runtime: Runtime,
  db: DatabaseSync,
  initialState: unknown
) =>
  Effect.try({
    try: () => {
      const state = validateModelState(runtime.model, initialState);
      db.exec("BEGIN IMMEDIATE");

      try {
        const existing = db
          .prepare("SELECT value FROM durable_meta WHERE key=?")
          .get("format");

        if (existing) {
          throw new DurableStoreError({
            message: "Durable store is already initialized.",
          });
        }

        const put = db.prepare(
          "INSERT INTO durable_meta(key,value) VALUES(?,?)"
        );

        put.run("format", FORMAT);
        put.run("model_key", canonical(runtime.model));
        put.run("state_json", canonical(state));
        db.exec("COMMIT");

        return state;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}

        throw error;
      }
    },
    catch: durableError,
  });

export const durableState = (runtime: Runtime, db: DatabaseSync) =>
  Effect.try({
    try: () => {
      db.exec("BEGIN");

      try {
        const state = validateStored(
          db,
          canonical(runtime.model),
          runtime.model
        );

        db.exec("COMMIT");

        if (state === null) {
          throw new DurableStoreError({
            message: "Durable store is not initialized.",
          });
        }

        return state;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}

        throw e;
      }
    },
    catch: durableError,
  });

const exactKeys = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): void => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key)
    )
  ) {
    throw new TypeError("Unexpected or missing operation members.");
  }
};

function identity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 1000) {
    throw new TypeError("Expected a nonempty bounded identity.");
  }
}

function requireV2(runtime: Runtime): asserts runtime is Readonly<V2Runtime> {
  if (!isV2(runtime)) {
    throw new TypeError("Approval operations require semantic-core/v2.");
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invocationArgs(args: unknown): V2Invocation["args"] {
  if (!object(args)) {
    throw new TypeError("Expected invocation arguments.");
  }

  const values = Object.entries(args).map(([name, value]): [string, Value] => {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return [name, value];
    }

    if (
      Array.isArray(value) &&
      value.every((item: unknown): item is string => typeof item === "string")
    ) {
      return [name, value];
    }

    throw new TypeError(`Invalid invocation input: ${name}`);
  });

  return Object.fromEntries(values);
}

function storedRequest(
  runtime: Readonly<V2Runtime>,
  source: unknown
): ApprovalRequest {
  if (!object(source)) {
    throw new TypeError("Malformed stored approval request.");
  }

  const raw = source["invocation"];

  if (
    !object(raw) ||
    !object(raw["args"]) ||
    typeof raw["id"] !== "string" ||
    typeof raw["actor"] !== "string" ||
    typeof raw["action"] !== "string" ||
    typeof raw["clock"] !== "number"
  ) {
    throw new TypeError("Malformed stored approval invocation.");
  }

  const invocation = {
    id: raw["id"],
    actor: raw["actor"],
    action: raw["action"],
    clock: raw["clock"],
    args: invocationArgs(raw["args"]),
  };

  const state = validateV2State(runtime.model, source["prestate"]);
  const checked = runtime.prepare(state, invocation);

  if (
    checked.status !== "pending" ||
    canonical(checked.request) !== canonical(source)
  ) {
    throw new TypeError("Malformed stored approval request.");
  }

  return checked.request;
}

const rejected = (
  code: string,
  reason: string
): { status: "rejected"; code: string; reason: string } => ({
  status: "rejected",
  code,
  reason,
});

const decodeOperation = (text: unknown, runtime: Readonly<V2Runtime>) => {
  const value = decodeWith(DurableOperationOutcomeSchema, text);

  if (value.status === "committed") {
    validateModelState(runtime.model, value.state);

    return value;
  }

  if (value.status === "rejected") {
    if (Object.hasOwn(value, "state")) {
      validateModelState(runtime.model, value["state"]);
    }

    return value;
  }

  const { request, policyId, approver } = value.receipt;

  const checked = runtime.approve(storedRequest(runtime, request), {
    policyId,
    approver,
  });

  if (
    checked.status === "approved" &&
    canonical(checked) === canonical(value)
  ) {
    return checked;
  }

  throw new Error("Malformed stored operation outcome.");
};

type OperationCommand = { id: string; invocationId: string } & (
  | { kind: "approve"; policyId: string; authenticatedApprover: string }
  | { kind: "resume"; clock: number }
);

type OperationOutcome =
  | ReturnType<V2Runtime["approve"]>
  | ReturnType<V2Runtime["resume"]>;

type OperationOptions = { beforeCommit?: (result: OperationOutcome) => void };

function operation(
  runtime: Readonly<V2Runtime>,
  db: DatabaseSync,
  command: OperationCommand,
  beforeCommit: OperationOptions["beforeCommit"],
  derive: (state: V2State, request: ApprovalRequest) => OperationOutcome
) {
  const modelKey = canonical(runtime.model);
  const commandKey = canonical(command);

  db.exec("BEGIN IMMEDIATE");

  try {
    const previous = db
      .prepare("SELECT * FROM durable_operations WHERE id=?")
      .get(command.id);

    if (previous) {
      const result:
        | { status: "duplicate"; result: ReturnType<typeof decodeOperation> }
        | ReturnType<typeof conflict> =
        previous["model_key"] === modelKey &&
        previous["command_key"] === commandKey
          ? {
              status: "duplicate",
              result: decodeOperation(previous["outcome_json"], runtime),
            }
          : conflict();

      db.exec("COMMIT");

      return result;
    }

    if (
      db
        .prepare("SELECT id FROM durable_invocations WHERE id=?")
        .get(command.id)
    ) {
      db.exec("COMMIT");

      return conflict();
    }

    const state = validateStored(db, modelKey, runtime.model);

    if (state === null) {
      throw new Error("Durable store is not initialized.");
    }

    const pending = db
      .prepare("SELECT * FROM durable_pending WHERE invocation_id=?")
      .get(command.invocationId);

    const result = jsonSnapshot(
      !pending
        ? rejected("missing-request", "No persisted approval request.")
        : pending["status"] === "consumed"
          ? rejected("consumed", "Approval request already resumed.")
          : derive(
              state,
              storedRequest(
                runtime,
                decodeWith(DurablePendingRequestSchema, pending["request_json"])
              )
            )
    );

    db.prepare(
      "INSERT INTO durable_operations(id,model_key,command_key,outcome_json) VALUES(?,?,?,?)"
    ).run(command.id, modelKey, commandKey, canonical(result));

    // The operation row precedes the grant row because of its foreign key.
    if (command.kind === "approve" && result.status === "approved") {
      db.prepare(
        "INSERT INTO durable_grants(invocation_id,policy_id,operation_id,receipt_json) VALUES(?,?,?,?)"
      ).run(
        command.invocationId,
        command.policyId,
        command.id,
        canonical(result.receipt)
      );
    }

    if (command.kind === "resume" && result.status === "committed") {
      db.prepare("UPDATE durable_meta SET value=? WHERE key=?").run(
        canonical(result.state),
        "state_json"
      );
      db.prepare(
        "UPDATE durable_pending SET status='consumed',resume_id=? WHERE invocation_id=?"
      ).run(command.id, command.invocationId);

      const insert = db.prepare(
        "INSERT INTO durable_outbox(event_id,event_json) VALUES(?,?)"
      );

      for (const event of result.events) {
        insert.run(event.id, canonical(event));
      }
    }

    if (beforeCommit) {
      beforeCommit(result);
    }

    db.exec("COMMIT");

    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}

    throw error;
  }
}

/** authenticatedApprover must come from the trusted host, never a client receipt. */
export const durableApprove = (
  runtime: Runtime,
  db: DatabaseSync,
  source: unknown,
  host: OperationOptions & { authenticatedApprover: string }
) =>
  Effect.try({
    try: () => {
      requireV2(runtime);
      const command = jsonSnapshot(source);
      exactKeys(command, ["id", "invocationId", "policyId"]);
      exactKeys(host, ["authenticatedApprover"], ["beforeCommit"]);

      if (!object(command)) {
        throw new TypeError("Expected an approval command.");
      }

      const { id, invocationId, policyId } = command;
      identity(id);
      identity(invocationId);
      identity(policyId);
      identity(host.authenticatedApprover);

      return operation(
        runtime,
        db,
        {
          id,
          invocationId,
          policyId,
          kind: "approve",
          authenticatedApprover: host.authenticatedApprover,
        },
        host.beforeCommit,
        (_state, request) => {
          if (
            db
              .prepare(
                "SELECT policy_id FROM durable_grants WHERE invocation_id=? AND policy_id=?"
              )
              .get(invocationId, policyId)
          ) {
            return rejected(
              "already-granted",
              "Policy already has a persisted grant."
            );
          }

          return runtime.approve(request, {
            policyId,
            approver: host.authenticatedApprover,
          });
        }
      );
    },
    catch: durableError,
  });

/** No receipt parameter: only receipts from the transactional grant ledger are used. */
export const durableResume = (
  runtime: Runtime,
  db: DatabaseSync,
  source: unknown,
  options: OperationOptions = {}
) =>
  Effect.try({
    try: () => {
      requireV2(runtime);
      const command = jsonSnapshot(source);
      exactKeys(command, ["id", "invocationId", "clock"]);
      exactKeys(options, [], ["beforeCommit"]);

      if (!object(command)) {
        throw new TypeError("Expected a resume command.");
      }

      const { id, invocationId, clock } = command;
      identity(id);
      identity(invocationId);

      if (
        typeof clock !== "number" ||
        !Number.isSafeInteger(clock) ||
        clock < 0
      ) {
        throw new DurableStoreError({
          message: "Expected a nonnegative safe clock.",
        });
      }

      return operation(
        runtime,
        db,
        { id, invocationId, clock, kind: "resume" },
        options.beforeCommit,
        (state, request) => {
          const original = db
            .prepare("SELECT command_json FROM durable_invocations WHERE id=?")
            .get(invocationId);

          const decoded = decodeWith(
            DurableInvocationSchema,
            original?.["command_json"]
          );

          const invocation = { ...decoded, args: invocationArgs(decoded.args) };

          const receipts = db
            .prepare(
              "SELECT receipt_json FROM durable_grants WHERE invocation_id=? ORDER BY policy_id"
            )
            .all(invocationId)
            .map((row) => {
              const receipt = decodeWith(
                DurableReceiptSchema,
                row["receipt_json"]
              );

              return {
                ...receipt,
                request: storedRequest(runtime, receipt.request),
              };
            });

          return runtime.resume(state, invocation, request, receipts, {
            clock,
          });
        }
      );
    },
    catch: durableError,
  });

/** Read-only CLI/UI projection; grants in this projection confer no authority. */
export const durablePending = (
  runtime: Runtime,
  db: DatabaseSync,
  invocationId: string
) =>
  Effect.try({
    try: () => {
      requireV2(runtime);
      identity(invocationId);
      db.exec("BEGIN");

      try {
        if (
          validateStored(db, canonical(runtime.model), runtime.model) === null
        ) {
          throw new DurableStoreError({
            message: "Durable store is not initialized.",
          });
        }

        const pending = db
          .prepare("SELECT * FROM durable_pending WHERE invocation_id=?")
          .get(invocationId);

        const grants = db
          .prepare(
            "SELECT receipt_json FROM durable_grants WHERE invocation_id=? ORDER BY policy_id"
          )
          .all(invocationId)
          .map((row) => {
            const receipt = decodeWith(
              DurableReceiptSchema,
              row["receipt_json"]
            );

            return { policyId: receipt.policyId, approver: receipt.approver };
          });

        let result: {
          invocationId: string;
          status: "pending" | "consumed";
          request: ApprovalRequest;
          grants: { policyId: string; approver: string }[];
          resumeId: string | null;
        } | null = null;

        if (pending) {
          const status = pending["status"];
          const resumeId = pending["resume_id"];

          if (
            (status !== "pending" && status !== "consumed") ||
            (resumeId !== null && typeof resumeId !== "string")
          ) {
            throw new TypeError("Malformed stored approval status.");
          }

          result = jsonSnapshot({
            invocationId,
            status,
            request: storedRequest(
              runtime,
              decodeWith(DurablePendingRequestSchema, pending["request_json"])
            ),
            grants,
            resumeId,
          });
        }

        db.exec("COMMIT");

        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}

        throw error;
      }
    },
    catch: durableError,
  });

/** Pull ordered unacknowledged facts. A crash after delivery and before ack can redeliver. */
export const pullOutbox = (db: DatabaseSync, { limit = 100 } = {}) =>
  Effect.try({
    try: () => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new DurableStoreError({
          message: "limit must be an integer from 1 to 1000",
        });
      }

      return db
        .prepare(
          "SELECT sequence,event_id,event_json FROM durable_outbox WHERE acknowledged=0 ORDER BY sequence LIMIT ?"
        )
        .all(limit)
        .map((row) => {
          const sequence = row["sequence"];
          const eventId = row["event_id"];

          if (typeof sequence !== "number" || typeof eventId !== "string") {
            throw new TypeError("Malformed outbox entry.");
          }

          return {
            sequence,
            eventId,
            event: decodeWith(DurableEventSchema, row["event_json"]),
          };
        });
    },
    catch: durableError,
  });

export const acknowledgeOutbox = (db: DatabaseSync, sequence: number) =>
  Effect.try({
    try: () => {
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new DurableStoreError({
          message: "sequence must be a positive safe integer",
        });
      }

      return (
        db
          .prepare(
            "UPDATE durable_outbox SET acknowledged=1 WHERE sequence=? AND acknowledged=0"
          )
          .run(sequence).changes === 1
      );
    },
    catch: durableError,
  });

export const closeDurableStore = (db: DatabaseSync) =>
  Effect.try({ try: () => db.close(), catch: durableError });

export const DurableStore = Context.Service<DatabaseSync>("DurableStore");

export const durableStoreLayer = (path: string) =>
  Layer.effect(
    DurableStore,
    Effect.acquireRelease(makeDurableStore(path), (db) =>
      Effect.orDie(closeDurableStore(db))
    )
  );
