import {createInterpreter, validateState} from '../../semantic/v2/core.ts';
import type {Action, Expr, FieldSchema, Model, Scalar} from '../../semantic/v2/core.ts';

const lit = (value: Scalar): Expr => ({op: 'literal', value});
const input = (name: string): Expr => ({op: 'input', name});
const field = (binding: string, name: string): Expr => ({op: 'field', binding, field: name});
const bin = (op: Extract<Expr, {left: Expr}>['op'], left: Expr, right: Expr): Expr => ({op, left, right});
const integer = (min: number): FieldSchema => ({type: 'integer', min});
const string: FieldSchema = {type: 'string'};
const condition = (id: string, when: Expr) => ({id, when});
const update = (id: string, target: string, name: string, value: Expr) => ({id, target, field: name, value});

function reserveAction(): Action {
  const stock = 'reserve.stock';
  const s = name => field(stock, name);
  return {
    inputs: {stockId: string, reservationId: string, quantity: integer(1), expiresAt: integer(0)},
    bindings: [{id: stock, resource: 'stock', key: input('stockId')}],
    preconditions: [
      condition('reserve.capacity', bin('le', input('quantity'), s('available'))),
      condition('reserve.expiry-future', bin('lt', {op: 'clock'}, input('expiresAt'))),
    ],
    policies: [
      {id: 'reserve.small-quantity', effect: 'allow', when: bin('lt', input('quantity'), lit(3))},
      {id: 'reserve.warehouse-approval', effect: 'approval-required', when: bin('le', lit(3), input('quantity')), approvers: s('operator')},
    ],
    updates: [update('reserve.decrement-stock', stock, 'available', bin('sub', s('available'), input('quantity')))],
    inserts: [{
      id: 'reserve.create-record', resource: 'reservation', key: input('reservationId'),
      values: {stockId: input('stockId'), owner: {op: 'actor'}, quantity: input('quantity'), expiresAt: input('expiresAt'), status: lit('active')},
    }],
    deletes: [],
    observe: [{binding: stock, relationship: 'stock.watchers'}, {binding: 'reserve.create-record', relationship: 'reservation.owner'}],
  };
}

function terminalAction(kind: 'cancel' | 'expire'): Action {
  const reservation = `${kind}.reservation`;
  const stock = `${kind}.stock`;
  const r = name => field(reservation, name);
  const s = name => field(stock, name);
  const expiry = kind === 'expire';
  return {
    inputs: {stockId: string, reservationId: string},
    bindings: [
      {id: reservation, resource: 'reservation', key: input('reservationId')},
      {id: stock, resource: 'stock', key: input('stockId')},
    ],
    preconditions: [
      condition(`${kind}.matching-stock`, bin('eq', r('stockId'), input('stockId'))),
      condition(`${kind}.active`, bin('eq', r('status'), lit('active'))),
      ...(expiry ? [condition('expire.boundary', bin('le', r('expiresAt'), {op: 'clock'}))] : []),
    ],
    policies: [{id: `${kind}.${expiry ? 'warehouse' : 'owner'}`, effect: 'allow', when: bin('eq', {op: 'actor'}, expiry ? s('operator') : r('owner'))}],
    updates: [
      update(`${kind}.restore-stock`, stock, 'available', bin('add', s('available'), r('quantity'))),
      update(`${kind}.mark-terminal`, reservation, 'status', lit(expiry ? 'expired' : 'cancelled')),
    ],
    inserts: [], deletes: [],
    observe: [{binding: stock, relationship: 'stock.watchers'}, {binding: reservation, relationship: 'reservation.owner'}],
  };
}

const deleteTerminal = {
  inputs: {reservationId: string},
  bindings: [{id: 'delete.reservation', resource: 'reservation', key: input('reservationId')}],
  preconditions: [{id: 'delete.is-terminal', when: bin('or', bin('eq', field('delete.reservation', 'status'), lit('cancelled')), bin('eq', field('delete.reservation', 'status'), lit('expired')))}],
  policies: [{id: 'delete.owner', effect: 'allow', when: bin('eq', {op: 'actor'}, field('delete.reservation', 'owner'))}],
  updates: [], inserts: [], deletes: [{id: 'delete.remove-record', target: 'delete.reservation'}],
  observe: [{binding: 'delete.reservation', relationship: 'reservation.owner'}],
} satisfies Action;

export const inventoryV2Model = {
  format: 'semantic-core/v2', id: 'inventory.v2',
  resources: {
    stock: {fields: {capacity: integer(0), available: integer(0), watchers: {type: 'ids'}, operator: string}},
    reservation: {fields: {stockId: string, owner: string, quantity: integer(1), expiresAt: integer(0), status: {type: 'string', enum: ['active', 'cancelled', 'expired']}}},
  },
  relationships: [
    {id: 'stock.watchers', resource: 'stock', field: 'watchers'},
    {id: 'reservation.owner', resource: 'reservation', field: 'owner'},
  ],
  actions: {
    'reservation.reserve': reserveAction(),
    'reservation.cancel': terminalAction('cancel'),
    'reservation.expire': terminalAction('expire'),
    'reservation.delete-terminal': deleteTerminal,
  },
} satisfies Model;

export const initialState = validateState(inventoryV2Model, {
  revision: 0,
  records: {
    stock: {camera: {version: 0, values: {capacity: 8, available: 8, watchers: ['alice', 'bob', 'warehouse'], operator: 'warehouse'}}},
    reservation: {},
  },
});

export const runtime = createInterpreter(inventoryV2Model);

type InvocationOptions = {reservationId: string; actor?: string; clock?: number; stockId?: string; quantity?: number; expiresAt?: number};
type Command<A> = {id: string; action: string; actor: string; clock: number; args: A};
type InventoryArgs = Record<string, Scalar> & {reservationId: string};
type ReserveArgs = InventoryArgs & {stockId: string; quantity: number; expiresAt: number};

/** IDs: stock `camera`; reservation IDs are caller-chosen, e.g. `res-alice-1`. */
export function invocation(id: string, kind: 'reserve', options: InvocationOptions): Command<ReserveArgs>;
export function invocation(id: string, kind: string, options: InvocationOptions): Command<InventoryArgs>;
export function invocation(id: string, kind: string, {reservationId, actor = 'alice', clock = 10, stockId = 'camera', quantity = 2, expiresAt = 30}: Partial<InvocationOptions> = {}): Command<Record<string, Scalar | undefined>> {
  const action = `reservation.${kind}`;
  const args = kind === 'reserve' ? {stockId, reservationId, quantity, expiresAt}
    : kind === 'delete-terminal' ? {reservationId} : {stockId, reservationId};
  return {id, action, args, actor, clock};
}
