import * as Effect from 'effect/Effect';
import { makeDurableRuntime, makeDurableStore, initializeDurableState, durableExecute, closeDurableStore } from './durable.mjs';
import { issueModel, issueState } from '../../semantic/issues.mjs';
import { inventoryModel, initialState, invocation as stockInvocation } from '../../inventory/model.mjs';

const [path, mode, id = 'worker'] = process.argv.slice(2);
const runtime = makeDurableRuntime(issueModel);
const db = await Effect.runPromise(makeDurableStore(path));
try {
  if (mode === 'init') await Effect.runPromise(initializeDurableState(runtime, db, issueState));
  else if (mode === 'init-stock') await Effect.runPromise(initializeDurableState(makeDurableRuntime(inventoryModel), db, initialState));
  else if (mode === 'execute') await Effect.runPromise(durableExecute(runtime, db, { id, action: 'issue.resolve', args: { issueId: 'i1' }, actor: 'maya', clock: 1730000000000 }));
  else if (mode === 'crash-before') {
    // Exercise SQLite rollback after writing inside an uncommitted transaction.
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE durable_meta SET value='corrupt' WHERE key='state_json'").run();
    process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'crash-after') {
    await Effect.runPromise(durableExecute(runtime, db, { id, action: 'issue.resolve', args: { issueId: 'i1' }, actor: 'maya', clock: 1730000000000 }));
    process.exit(0);
  } else if (mode === 'stock') {
    const result = await Effect.runPromise(durableExecute(makeDurableRuntime(inventoryModel), db,
      stockInvocation(id, 'reserve', id === 'stock-a' ? 'slotA' : 'slotB')));
    process.stdout.write(`${result.status}:${result.code ?? ''}\n`);
  }
} finally { if (db.isOpen) await Effect.runPromise(closeDurableStore(db)); }
