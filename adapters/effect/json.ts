import * as Schema from 'effect/Schema';
import type { ParseOptions } from 'effect/SchemaAST';

const openObject = <const Fields extends Schema.Struct.Fields>(fields: Fields) => Schema.StructWithRest(
  Schema.Struct(fields),
  [Schema.Record(Schema.String, Schema.Json)],
);

const JsonValueCodec = Schema.fromJsonString(Schema.Json);
const JsonObjectCodec = Schema.fromJsonString(Schema.JsonObject);
const StringJsonCodec = Schema.fromJsonString(Schema.String);
const UnknownJsonCodec = Schema.fromJsonString(Schema.Unknown);
const PrettyUnknownJsonCodec = Schema.fromJsonString(Schema.Unknown, { space: 2 });

const decodeJsonValueSync = Schema.decodeUnknownSync(JsonValueCodec);
const decodeJsonObjectSync = Schema.decodeUnknownSync(JsonObjectCodec);
const encodeJsonValueSync = Schema.encodeUnknownSync(JsonValueCodec);
const encodeStringJsonSync = Schema.encodeSync(StringJsonCodec);
const encodeUnknownJsonSync = Schema.encodeSync(UnknownJsonCodec);
const encodePrettyUnknownJsonSync = Schema.encodeSync(PrettyUnknownJsonCodec);

export const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, text: unknown, options?: ParseOptions): S['Type'] =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema), options)(text);

export const decodeStrictJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, text: unknown): S['Type'] =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema), { onExcessProperty: 'error' })(text);

export const decodeJsonValue = (text: unknown) => decodeJsonValueSync(text);

export const decodeJsonObject = (text: unknown) => decodeJsonObjectSync(text);

export const decodeValue = Schema.decodeUnknownSync;

export const encodeJson = (value: unknown, schema?: Schema.ConstraintEncoder<unknown>) =>
  schema ? Schema.encodeUnknownSync(Schema.fromJsonString(schema))(value) : encodeUnknownJsonSync(value);

export const encodeJsonPretty = (value: unknown, schema?: Schema.ConstraintEncoder<unknown>) =>
  schema
    ? Schema.encodeUnknownSync(Schema.fromJsonString(schema, { space: 2 }))(value)
    : encodePrettyUnknownJsonSync(value);

/** Deterministic lexicographic key-sorted JSON encoding via Effect Schema codecs. */
export const encodeCanonicalJson = (value:unknown):string => {
  if (Array.isArray(value)) return `[${value.map(encodeCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v]) => `${encodeStringJsonSync(k)}:${encodeCanonicalJson(v)}`).join(',')}}`;
  }
  return encodeJsonValueSync(value);
};

// --- Common domain primitives ---

const BoundedIdentity = Schema.String.pipe(
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

const SubmissionId = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
    Schema.makeFilter(v => v.trim().length > 0, {
      message: 'Expected a nonempty submission ID of at most 200 characters.',
    }),
  ),
);

const SafeClock = Schema.Number.pipe(
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

export const DurableInvocationSchema = openObject({
  id: Schema.String,
  action: Schema.String,
  actor: Schema.String,
  args: Schema.JsonObject,
  clock: Schema.Finite,
});

const DurableCommittedOutcomeSchema = openObject({
  status: Schema.Literal('committed'),
  state: Schema.JsonObject,
  events: Schema.Array(DurableEventSchema),
});

const DurablePendingOutcomeSchema = openObject({
  status: Schema.Literal('pending'),
  state: Schema.JsonObject,
  policyIds: Schema.Array(Schema.String),
});

const DurableRejectedOutcomeSchema = openObject({
  status: Schema.Literal('rejected'),
  state: Schema.JsonObject,
  code: Schema.String,
});

export const DurableOutcomeSchema = Schema.Union([
  DurableCommittedOutcomeSchema,
  DurablePendingOutcomeSchema,
  DurableRejectedOutcomeSchema,
]);

const DurableOperationRejectedSchema = openObject({
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

const DurableOperationApprovedSchema = openObject({
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

const SubmissionEventSchema = Schema.Union([
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

const WorkspaceProfileSchema = Schema.Literals(['v1', 'v2']);

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

// --- Browser storage and event envelopes ---

export const ApplicationSavedSubmissionsSchema = Schema.Array(Schema.Struct({
  phase: Schema.Literals(['submitting', 'unknown', 'checking', 'retryable']),
  id: SubmissionId,
  body: Schema.Struct({actor: Schema.String, action: Schema.String, args: Schema.JsonObject}),
}));

const stringMap = <S extends Schema.Constraint>(value:S) => Schema.Record(Schema.String,value);
const ScalarSchema = Schema.Union([Schema.String,Schema.Finite,Schema.Boolean]);
const ValueSchema = Schema.Union([ScalarSchema,Schema.Array(Schema.String)]);
const ValueMapSchema = stringMap(ValueSchema);
const SemanticStateSchema = openObject({
  revision: SafeClock, records: stringMap(stringMap(openObject({version:SafeClock,values:ValueMapSchema}))),
});
const SemanticInvocationSchema = openObject({
  id:Schema.String,action:Schema.String,actor:Schema.String,args:ValueMapSchema,clock:Schema.Finite,
});
const ApprovalRequirementSchema = openObject({
  policyId:Schema.String,approvers:Schema.Array(Schema.String),allowSelfApproval:Schema.Boolean,
});
const ApprovalGrantSchema = openObject({policyId:Schema.String,approver:Schema.String});
const PendingStatus = Schema.Literals(['pending','consumed']);
const FieldSchemaCodec = Schema.Union([
  openObject({type:Schema.Literal('integer'),min:Schema.optionalKey(Schema.Finite),max:Schema.optionalKey(Schema.Finite)}),
  openObject({type:Schema.Literal('string'),enum:Schema.optionalKey(Schema.Array(Schema.String))}),
  openObject({type:Schema.Literal('boolean')}),
  openObject({type:Schema.Literal('ids')}),
]);
export const ApplicationSnapshotSchema = openObject({
  contractId: Schema.String,
  snapshotVersion: SafeClock,
  state: SemanticStateSchema,
  pending: Schema.Array(openObject({
    id:Schema.String,status:PendingStatus,invocation:SemanticInvocationSchema,
    requirements:Schema.Array(ApprovalRequirementSchema),grants:Schema.Array(ApprovalGrantSchema),stale:Schema.Boolean,
  })),
  defaults: stringMap(stringMap(ValueMapSchema)),
  availability: stringMap(stringMap(Schema.Boolean)),
});

export const ApplicationReceiptSchema = openObject({
  contractId:Schema.String,status:Schema.String,submissionId:Schema.optionalKey(Schema.String),
  message:Schema.optionalKey(Schema.String),code:Schema.optionalKey(Schema.String),args:Schema.optionalKey(Schema.Json),
  requirements:Schema.optionalKey(Schema.Array(ApprovalRequirementSchema)),
  evidence:Schema.optionalKey(openObject({
    phase:Schema.String,invocation:openObject({id:Schema.String,actor:Schema.String,action:Schema.String,args:Schema.Json}),
    outcome:openObject({status:Schema.String}),
  })),
  snapshot:Schema.optionalKey(ApplicationSnapshotSchema),
});

const SubmissionBodySchema = openObject({actor:Schema.String,action:Schema.String,args:Schema.JsonObject});
const reviewFields = Schema.Struct({
  snapshot:Schema.optionalKey(ApplicationSnapshotSchema),result:Schema.optionalKey(ApplicationReceiptSchema),
  actor:Schema.optionalKey(Schema.String),policyId:Schema.optionalKey(Schema.String),
  body:Schema.optionalKey(SubmissionBodySchema),id:Schema.optionalKey(Schema.String),message:Schema.optionalKey(Schema.String),
});
const reviewEvent = <const Fields extends Schema.Struct.Fields>(fields:Fields) =>
  Schema.StructWithRest(reviewFields.pipe(Schema.fieldsAssign(fields)),[Schema.Record(Schema.String,Schema.Json)]);
export const ReviewEventSchema = Schema.Union([
  reviewEvent({type:Schema.Literals(['open','refresh-start','submit','lost','check'])}),
  reviewEvent({type:Schema.Literal('switch'),actor:Schema.String}),
  reviewEvent({type:Schema.Literal('snapshot'),snapshot:ApplicationSnapshotSchema}),
  reviewEvent({type:Schema.Literal('refresh-end'),snapshot:ApplicationSnapshotSchema}),
  reviewEvent({type:Schema.Literal('draft'),id:Schema.String,body:SubmissionBodySchema}),
  reviewEvent({type:Schema.Literals(['invalid','blocked','unavailable']),message:Schema.String}),
  reviewEvent({type:Schema.Literal('receipt'),result:ApplicationReceiptSchema}),
  reviewEvent({type:Schema.Literal('grant'),result:ApplicationReceiptSchema,actor:Schema.String,policyId:Schema.String}),
  reviewEvent({type:Schema.Literal('complete'),result:ApplicationReceiptSchema,actor:Schema.String}),
]);

const FieldReference = Schema.Struct({resource:Schema.String,key:Schema.String,field:Schema.String});
const ContractFieldSchema = Schema.Struct({
  name:Schema.String,schema:FieldSchemaCodec,label:Schema.String,widget:Schema.String,hidden:Schema.Boolean,
  binding:Schema.optionalKey(Schema.Struct({
    source:Schema.Literals(['actor','operation-id','clock','constant']),value:Schema.optionalKey(ValueSchema),
  })),
  reference:Schema.optionalKey(Schema.Struct({resource:Schema.String,labelField:Schema.optionalKey(Schema.String)})),
  default:Schema.optionalKey(Schema.Union([ValueSchema,FieldReference])),
});
const ExprSchema:Schema.Codec<import('../../semantic/v2/types.ts').Expr> = Schema.Union([
  Schema.Struct({op:Schema.Literal('literal'),value:ScalarSchema}),
  Schema.Struct({op:Schema.Literal('input'),name:Schema.String}),
  Schema.Struct({op:Schema.Literals(['actor','clock'])}),
  Schema.Struct({op:Schema.Literal('field'),binding:Schema.String,field:Schema.String}),
  Schema.Struct({op:Schema.Literal('not'),value:Schema.suspend(()=>ExprSchema)}),
  Schema.Struct({
    op:Schema.Literals(['add','sub','lt','le','eq','and','or']),
    left:Schema.suspend(()=>ExprSchema),right:Schema.suspend(()=>ExprSchema),
  }),
]);
const policies = Schema.Array(Schema.Union([
  Schema.Struct({id:Schema.String,when:ExprSchema,effect:Schema.Literals(['allow','deny'])}),
  Schema.Struct({
    id:Schema.String,when:ExprSchema,effect:Schema.Literal('approval-required'),approvers:ExprSchema,
    allowSelfApproval:Schema.optionalKey(Schema.Boolean),
  }),
]));
const ApplicationContractSchema = Schema.Struct({
  format:Schema.String,title:Schema.String,eyebrow:Schema.String,subtitle:Schema.String,scope:Schema.String,loading:Schema.optionalKey(Schema.String),
  actors:Schema.mutable(Schema.Array(Schema.Struct({id:Schema.String,label:Schema.String,name:Schema.optionalKey(Schema.String)}))),
  actions:stringMap(Schema.Struct({
    id:Schema.String,label:Schema.String,description:Schema.String,fields:Schema.mutable(Schema.Array(ContractFieldSchema)),
    adapters:Schema.mutable(Schema.Array(Schema.Struct({
      name:Schema.Literal('utc-weekday-range/v1'),mapping:Schema.Struct({start:Schema.String,end:Schema.String,output:Schema.String}),
    }))),
    policies,preconditions:Schema.Array(Schema.Struct({id:Schema.String,when:ExprSchema})),
  })),
  views:Schema.mutable(Schema.Array(Schema.Struct({
    kind:Schema.Literals(['list','summary']),resource:Schema.String,label:Schema.String,
    loading:Schema.optionalKey(Schema.String),key:Schema.optionalKey(Schema.String),ownerField:Schema.optionalKey(Schema.String),
    columns:Schema.mutable(Schema.Array(Schema.Struct({field:Schema.String,label:Schema.String,format:Schema.optionalKey(Schema.Literals(['date','text']))}))),
  }))),
  resources:stringMap(Schema.Struct({fields:stringMap(FieldSchemaCodec)})),
  relationships:Schema.Array(Schema.Struct({id:Schema.String,resource:Schema.String,field:Schema.String})),
});
export const isApplicationContract = Schema.is(ApplicationContractSchema);

export const WorkspaceSnapshotSchema = Schema.Struct({
  profile:Schema.Literals(['v1','v2']),sequence:SafeClock,state:SemanticStateSchema,scope:Schema.Json,
  tools:Schema.Array(openObject({name:Schema.String,inputs:stringMap(FieldSchemaCodec)})),
  pending:Schema.optionalKey(Schema.Array(Schema.Struct({
    status:PendingStatus,invocationId:Schema.String,grants:Schema.Array(ApprovalGrantSchema),
    resumeId:Schema.NullOr(Schema.String),request:Schema.Struct({
      invocation:SemanticInvocationSchema,requirements:Schema.Array(ApprovalRequirementSchema),prestate:SemanticStateSchema,
    }),
  }))),
  events:Schema.optionalKey(Schema.Array(Schema.Struct({
    sequence:SafeClock,eventId:Schema.String,event:openObject({type:Schema.optionalKey(Schema.String),kind:Schema.optionalKey(Schema.String)}),
  }))),
});

export const WorkspaceChangeSchema = openObject({
  sequence: SafeClock,
  invalidations: Schema.Array(Schema.JsonObject),
  recipients: Schema.Array(Schema.JsonObject),
  reason: Schema.String,
});

export const LiveWorkspaceDocumentSchema = Schema.Struct({
  format: Schema.String,
  seedVersion: SafeClock,
  journal: Schema.Array(Schema.Json),
});

export const InventoryReplaySchema = openObject({
  format: Schema.String,
  host: Schema.String,
  model: Schema.JsonObject,
  initial: Schema.JsonObject,
  steps: Schema.Array(Schema.JsonObject),
  final: Schema.JsonObject,
});

export { Schema };
