export type Scalar = string | number | boolean;
export type Value = Scalar | readonly string[];
export type FieldSchema = {readonly type: 'integer'; readonly min?: number; readonly max?: number} | {readonly type: 'string'; readonly enum?: readonly string[]} | {readonly type: 'boolean'} | {readonly type: 'ids'};
export type Expr = {readonly op: 'literal'; readonly value: Scalar} | {readonly op: 'input'; readonly name: string} | {readonly op: 'actor' | 'clock'} | {readonly op: 'field'; readonly binding: string; readonly field: string} | {readonly op: 'not'; readonly value: Expr} | {readonly op: 'add' | 'sub' | 'lt' | 'le' | 'eq' | 'and' | 'or'; readonly left: Expr; readonly right: Expr};
export type Policy = {readonly id: string; readonly when: Expr} & ({readonly effect: 'allow' | 'deny'} | {readonly effect: 'approval-required'; readonly approvers: Expr; readonly allowSelfApproval?: boolean});
export interface Action {
  readonly inputs: Readonly<Record<string, FieldSchema>>;
  readonly bindings: readonly {readonly id: string; readonly resource: string; readonly key: Expr}[];
  readonly preconditions: readonly {readonly id: string; readonly when: Expr}[];
  readonly policies: readonly Policy[];
  readonly updates: readonly {readonly id: string; readonly target: string; readonly field: string; readonly value: Expr}[];
  readonly inserts: readonly {readonly id: string; readonly resource: string; readonly key: Expr; readonly values: Readonly<Record<string, Expr>>}[];
  readonly deletes: readonly {readonly id: string; readonly target: string}[];
  readonly observe: readonly {readonly binding: string; readonly relationship: string}[];
}
export interface Model {
  readonly format: 'semantic-core/v2'; readonly id: string;
  readonly resources: Readonly<Record<string, {readonly fields: Readonly<Record<string, FieldSchema>>}>>;
  readonly relationships: readonly {readonly id: string; readonly resource: string; readonly field: string}[];
  readonly actions: Readonly<Record<string, Action>>;
}
export interface RecordSnapshot {readonly version: number; readonly values: Readonly<Record<string, Value>>}
export interface State {readonly revision: number; readonly records: Readonly<Record<string, Readonly<Record<string, RecordSnapshot>>>>}
export interface Invocation {readonly id: string; readonly action: string; readonly args: Readonly<Record<string, Value>>; readonly actor: string; readonly clock: number}
export type InvocationInput = Omit<Invocation,'args'>&{readonly args:unknown};
interface Requirement {readonly policyId: string; readonly approvers: readonly string[]; readonly allowSelfApproval: boolean}
export interface ApprovalRequest {readonly format: 'semantic-approval-request/v2'; readonly model: Model; readonly invocation: Invocation; readonly prestate: State; readonly requirements: readonly Requirement[]}
export interface Grant {readonly policyId: string; readonly approver: string}
export interface ApprovalReceipt extends Grant {readonly format: 'semantic-approval-receipt/v2'; readonly request: ApprovalRequest}
export interface Recipient {readonly recipient: string; readonly paths: readonly {readonly relationship: string; readonly resource: string; readonly key: string}[]}
interface EventBase {readonly id: string; readonly modelId: string; readonly actionId: string; readonly invocationId: string; readonly actor: string; readonly clock: number; readonly revision: number; readonly recipients: readonly Recipient[]; readonly semanticId: string}
export type Event = EventBase & ({readonly kind: 'action'} | {readonly kind: 'change'; readonly resource: string; readonly key: string; readonly field: string; readonly before: Value; readonly after: Value} | {readonly kind: 'create'; readonly resource: string; readonly key: string; readonly after: RecordSnapshot} | {readonly kind: 'delete'; readonly resource: string; readonly key: string; readonly before: RecordSnapshot});
declare const opaque: unique symbol;
export type Prepared = {readonly kind: 'semantic-prepared/v2'; readonly [opaque]: true};
type Failure = Readonly<{status: 'rejected'; code: string; reason: string}>;
export type Rejected = Failure & {readonly state: State};
export type Pending = Readonly<{status: 'pending'; policyIds: readonly string[]; request: ApprovalRequest; state: State}>;
export type Committed = Readonly<{status: 'committed'; state: State; events: readonly Event[]}>;
export type PreparedResult = Readonly<{status: 'prepared'; prepared: Prepared}>;
export type Preparation = PreparedResult | Pending | Rejected;
export type ApprovalResult = Readonly<{status: 'approved'; receipt: ApprovalReceipt}> | Failure;
export interface Interpreter {
  readonly model: Model;
  prepare(state: State, invocation: InvocationInput): Preparation;
  commit(state: State, token: Prepared): Committed | Rejected;
  execute(state: State, invocation: InvocationInput): Committed | Pending | Rejected;
  approve(request: ApprovalRequest, grant: Grant): ApprovalResult;
  prepareResume(state: State, invocation: InvocationInput, request: ApprovalRequest, receipts: readonly ApprovalReceipt[], options: {readonly clock: number}): PreparedResult | Rejected;
  resume(state: State, invocation: InvocationInput, request: ApprovalRequest, receipts: readonly ApprovalReceipt[], options: {readonly clock: number}): Committed | Rejected;
}
