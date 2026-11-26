export type Scalar = string | number | boolean;
export type FieldSchema = {type: 'integer'; min?: number; max?: number} | {type: 'string'; enum?: string[]} | {type: 'boolean'} | {type: 'ids'};
export type Expr = {op: 'literal'; value: Scalar} | {op: 'input'; name: string} | {op: 'actor' | 'clock'} | {op: 'field'; binding: string; field: string} | {op: 'not'; value: Expr} | {op: 'add' | 'sub' | 'lt' | 'le' | 'eq' | 'and' | 'or'; left: Expr; right: Expr};
export interface Action {
  inputs: Record<string, FieldSchema>;
  bindings: {id: string; resource: string; key: Expr}[];
  preconditions: {id: string; when: Expr}[];
  policies: {id: string; when: Expr; effect: 'allow' | 'deny' | 'approval-required'}[];
  updates: {id: string; target: string; field: string; value: Expr}[];
  observe: {binding: string; relationship: string}[];
}
export interface Model {
  format: 'semantic-core/v1'; id: string;
  resources: Record<string, {fields: Record<string, FieldSchema>}>;
  relationships: {id: string; resource: string; field: string}[];
  actions: Record<string, Action>;
}
export interface State {revision: number; records: Record<string, Record<string, {version: number; values: Record<string, Scalar | string[]>}>>}
export interface Invocation {id: string; action: string; args: Record<string, Scalar | string[]>; actor: string; clock: number}
export type InvocationInput = Omit<Invocation,'args'>&{args:unknown};
export interface Recipient {recipient: string; paths: {relationship: string; resource: string; key: string}[]}
export interface EventBase {id: string; kind: 'action' | 'change'; modelId: string; actionId: string; invocationId: string; actor: string; clock: number; revision: number; recipients: Recipient[]}
export type Event = (EventBase & {kind: 'action'; semanticId: string}) | (EventBase & {kind: 'change'; semanticId: string; resource: string; key: string; field: string; before: Scalar | string[]; after: Scalar | string[]});
declare const opaque: unique symbol;
export type Prepared = {readonly kind: 'semantic-prepared/v1'; readonly [opaque]: true};
export type Rejected = Readonly<{status: 'rejected'; code: string; reason: string; state: State}>;
export type Pending = Readonly<{status: 'pending'; policyIds: readonly string[]; state: State}>;
export type Committed = Readonly<{status: 'committed'; state: State; events: Event[]}>;
export type Preparation = Readonly<{status: 'prepared'; prepared: Prepared}> | Pending | Rejected;
export interface Interpreter {
  readonly model: Model;
  prepare(state: State, invocation: InvocationInput): Preparation;
  commit(state: State, token: Prepared): Committed | Rejected;
  execute(state: State, invocation: InvocationInput): Committed | Pending | Rejected;
}
