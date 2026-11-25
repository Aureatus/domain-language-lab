import type {Invocation, State} from '../semantic/core.ts';

function count(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('Inventory count must be a safe integer');
  return BigInt(value);
}

// Independent of the expression evaluator: integer accounting over accepted commands.
export function inspectInventory(state: State, accepted: readonly Invocation[]) {
  const ledger = new Map<Invocation['args'][string], Pick<Invocation['args'], 'quantity' | 'stockId'>>();
  const failures: string[] = [];
  for (const command of accepted) {
    const {slotId,quantity,stockId} = command.args;
    if (command.action === 'reservation.reserve') {
      if (ledger.has(slotId)) failures.push(`Slot ${slotId} accepted twice`);
      ledger.set(slotId,{quantity,stockId});
    } else if (['reservation.cancel','reservation.expire'].includes(command.action)) ledger.delete(slotId);
    else failures.push(`Unsupported oracle action: ${command.action}`);
  }
  for (const [key,{values:s}] of Object.entries(state.records['stock'])) {
    const active = Object.values(state.records['reservation']).filter(r=>r.values['stockId']===key && r.values['status']==='active').reduce((n,r)=>n+count(r.values['quantity']),0n);
    const promised = [...ledger.values()].filter(r=>r.stockId===key).reduce((n,r)=>n+count(r.quantity),0n);
    const available=count(s['available']), capacity=count(s['capacity']);
    if (available+active!==capacity) failures.push(`${key}: state conservation failed`);
    if (promised>capacity) failures.push(`${key}: oversold — accepted ${promised} of ${s['capacity']}`);
    if (available+promised!==capacity) failures.push(`${key}: accepted-ledger conservation failed`);
  }
  for (const [key,{values:r}] of Object.entries(state.records['reservation'])) {
    const expected=ledger.get(key);
    if ((r['status']==='active') !== !!expected || (expected && (expected.quantity!==r['quantity'] || expected.stockId!==r['stockId']))) failures.push(`${key}: lost reservation / ledger mismatch`);
  }
  return {ok:failures.length===0,failures};
}
