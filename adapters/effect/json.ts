import * as Schema from 'effect/Schema';
import type { ParseOptions } from 'effect/SchemaAST';

const openObject = <const Fields extends Schema.Struct.Fields>(fields: Fields) => Schema.StructWithRest(
  Schema.Struct(fields),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const JsonValueCodec = Schema.fromJsonString(Schema.Json);
export const JsonObjectCodec = Schema.fromJsonString(Schema.JsonObject);
export const StringJsonCodec = Schema.fromJsonString(Schema.String);
export const UnknownJsonCodec = Schema.fromJsonString(Schema.Unknown);
export const PrettyUnknownJsonCodec = Schema.fromJsonString(Schema.Unknown, { space: 2 });

const decodeJsonValueSync = Schema.decodeUnknownSync(JsonValueCodec);
const decodeJsonObjectSync = Schema.decodeUnknownSync(JsonObjectCodec);
const encodeJsonValueSync = Schema.encodeSync(JsonValueCodec);
const encodeStringJsonSync = Schema.encodeSync(StringJsonCodec);
const encodeUnknownJsonSync = Schema.encodeSync(UnknownJsonCodec);
const encodePrettyUnknownJsonSync = Schema.encodeSync(PrettyUnknownJsonCodec);

export const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, text: unknown, options?: ParseOptions): S['Type'] =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema), options)(text);

export const decodeStrictJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, text: unknown): S['Type'] =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema), { onExcessProperty: 'error' })(text);

export const decodeJsonValue = (text: unknown) => decodeJsonValueSync(text);

export const decodeJsonObject = (text: unknown) => decodeJsonObjectSync(text);

export const encodeJson = (value: unknown, schema?: Schema.ConstraintEncoder<unknown>) =>
  schema ? Schema.encodeUnknownSync(Schema.fromJsonString(schema))(value) : encodeUnknownJsonSync(value);

export const encodeJsonPretty = (value: unknown, schema?: Schema.ConstraintEncoder<unknown>) =>
  schema
    ? Schema.encodeUnknownSync(Schema.fromJsonString(schema, { space: 2 }))(value)
    : encodePrettyUnknownJsonSync(value);

/** Deterministic lexicographic key-sorted JSON encoding via Effect Schema codecs. */
export const encodeCanonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(encodeCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${encodeStringJsonSync(k)}:${encodeCanonicalJson(value[k])}`).join(',')}}`;
  }
  return encodeJsonValueSync(value);
};

// --- Common domain primitives ---

export const BoundedIdentity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
);

export const SimulationIdentity = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(1000),
    Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.:-]*$/),
    Schema.makeFilter(v => !['constructor', 'prototype'].includes(v), {
      message: 'Forbidden simulation identity.',
    }),
  ),
);

export const SubmissionId = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
    Schema.makeFilter(v => v.trim().length > 0, {
      message: 'Expected a nonempty submission ID of at most 200 characters.',
    }),
  ),
);

export const SafeClock = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    Schema.makeFilter(v => !Object.is(v, -0), {
      message: 'Expected a nonnegative safe clock.',
    }),
  ),
);

// --- Durable SQLite persistence schemas ---

export const DurableEventSchema = openObject({ id: Schema.String });

export const DurableStateSchema = openObject({
  revision: SafeClock,
  records: Schema.JsonObject,
});

export const DurableInvocationSchema = openObject({
  id: Schema.String,
  action: Schema.String,
  actor: Schema.String,
  args: Schema.JsonObject,
  clock: Schema.Finite,
});

export const DurableCommittedOutcomeSchema = openObject({
  status: Schema.Literal('committed'),
  state: Schema.JsonObject,
  events: Schema.Array(DurableEventSchema),
});

export const DurablePendingOutcomeSchema = openObject({
  status: Schema.Literal('pending'),
  state: Schema.JsonObject,
  policyIds: Schema.Array(Schema.String),
});

export const DurableRejectedOutcomeSchema = openObject({
  status: Schema.Literal('rejected'),
  state: Schema.JsonObject,
  code: Schema.String,
});

export const DurableOutcomeSchema = Schema.Union([
  DurableCommittedOutcomeSchema,
  DurablePendingOutcomeSchema,
  DurableRejectedOutcomeSchema,
]);

export const DurableOperationRejectedSchema = openObject({
  status: Schema.Literal('rejected'),
  code: Schema.String,
  reason: Schema.String,
});

export const DurableReceiptSchema = openObject({
  format: Schema.Literal('semantic-approval-receipt/v2'),
  request: Schema.JsonObject,
  policyId: Schema.String,
  approver: Schema.String,
});

export const DurableOperationApprovedSchema = openObject({
  status: Schema.Literal('approved'),
  receipt: DurableReceiptSchema,
});

export const DurableOperationOutcomeSchema = Schema.Union([
  DurableCommittedOutcomeSchema,
  DurableOperationRejectedSchema,
  DurableOperationApprovedSchema,
]);

export const DurablePendingRequestSchema = openObject({
  invocation: DurableInvocationSchema,
  prestate: Schema.JsonObject,
});

export const DurableApproveCommandSchema = Schema.Struct({
  id: BoundedIdentity,
  invocationId: BoundedIdentity,
  policyId: BoundedIdentity,
});

export const DurableResumeCommandSchema = Schema.Struct({
  id: BoundedIdentity,
  invocationId: BoundedIdentity,
  clock: SafeClock,
});

// --- Application HTTP & trace schemas ---

export const ApplicationPreviewRequestSchema = Schema.Struct({
  actor: Schema.String,
  action: Schema.String,
  args: Schema.Json,
});

export const ApplicationExecuteRequestSchema = Schema.Struct({
  actor: Schema.String,
  action: Schema.String,
  args: Schema.Json,
  submissionId: Schema.optionalKey(SubmissionId),
  expectedContractId: Schema.optionalKey(Schema.String),
});

export const ApplicationReconcileRequestSchema = Schema.Struct({
  actor: Schema.String,
  submissionId: SubmissionId,
  expectedContractId: Schema.optionalKey(Schema.String),
});

export const ApplicationGrantRequestSchema = Schema.Struct({
  actor: Schema.String,
  requestId: BoundedIdentity,
  policyId: Schema.String,
});

export const ApplicationResumeRequestSchema = Schema.Struct({
  actor: Schema.String,
  requestId: BoundedIdentity,
});

export const ActionEventsTraceSchema = openObject({
  format: Schema.Literal('action-events/v1'),
  contractId: Schema.String,
  action: Schema.String,
  actor: Schema.String,
  args: Schema.Json,
  events: Schema.Array(Schema.JsonObject),
});

export const SubmissionEventSchema = Schema.Union([
  openObject({ type: Schema.Literal('submit'), id: Schema.String, body: Schema.JsonObject }),
  openObject({ type: Schema.Literal('lost') }),
  openObject({ type: Schema.Literal('invalid') }),
  openObject({ type: Schema.Literal('check') }),
  openObject({ type: Schema.Literal('missing') }),
  openObject({ type: Schema.Literal('retry') }),
  openObject({ type: Schema.Literal('found'), result: Schema.JsonObject }),
]);

export const SubmissionTraceSchema = Schema.Array(SubmissionEventSchema);

// --- Workspace HTTP schemas ---

export const WorkspaceProfileSchema = Schema.Literals(['v1', 'v2']);

export const WorkspaceExecuteRequestSchema = Schema.Struct({
  profile: WorkspaceProfileSchema,
  invocation: Schema.Struct({
    id: SimulationIdentity,
    action: SimulationIdentity,
    args: Schema.Json,
    actor: SimulationIdentity,
    clock: SafeClock,
  }),
});

export const WorkspaceApproveRequestSchema = Schema.Struct({
  profile: Schema.Literal('v2'),
  command: Schema.Struct({
    id: SimulationIdentity,
    invocationId: SimulationIdentity,
    policyId: SimulationIdentity,
  }),
  actor: SimulationIdentity,
});

export const WorkspaceResumeRequestSchema = Schema.Struct({
  profile: Schema.Literal('v2'),
  command: Schema.Struct({
    id: SimulationIdentity,
    invocationId: SimulationIdentity,
    clock: SafeClock,
  }),
});

export { Schema };
