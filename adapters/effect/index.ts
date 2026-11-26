import * as Effect from 'effect/Effect';
import * as Data from 'effect/Data';
import * as SynchronizedRef from 'effect/SynchronizedRef';
import {errorMessage} from '../../errors.ts';
import { createInterpreter, jsonSnapshot } from '../../semantic/core.ts';
import type { Committed, Event, Interpreter, Invocation, State } from '../../semantic/types.ts';
import { encodeCanonicalJson as canonical } from './json.ts';

/** Effect 4 adapter. The clock is data on each invocation, never read implicitly. */
type Store = {state: State; events: Event[]; invocations: Map<string, {invocation: Invocation; result: Committed; modelKey: string}>};
type Outcome = ReturnType<Interpreter['execute']>
  | {status: 'duplicate'; code: undefined; result: Committed}
  | {status: 'rejected'; code: 'invocation-conflict'; result: Committed};
type PublishOptions = {beforePublish?: (result: Committed) => void};
class MemoryStoreError extends Data.TaggedError('MemoryStoreError')<{message:string;cause:unknown}> {}
const memoryError = (cause:unknown) => new MemoryStoreError({message:errorMessage(cause),cause});
export const makeStore = (initialState: State) => Effect.suspend(() => SynchronizedRef.make<Store>({ state: jsonSnapshot(initialState), events: [], invocations: new Map() }));

export const execute = (runtime: Interpreter, store: SynchronizedRef.SynchronizedRef<Store>, invocation: Invocation, { beforePublish }: PublishOptions = {}) =>
  SynchronizedRef.modifyEffect(store, current => Effect.gen(function* (): Effect.fn.Return<readonly [Outcome, Store], MemoryStoreError> {
    const command = yield* Effect.try({ try: () => jsonSnapshot(invocation), catch: memoryError });
    const modelKey = canonical(runtime.model);
    const prior = current.invocations.get(command.id);
    if (prior) {
      const same = prior.modelKey === modelKey && canonical(prior.invocation) === canonical(command);
      return [same
        ? { status: 'duplicate', code: undefined, result: prior.result }
        : { status: 'rejected', code: 'invocation-conflict', result: prior.result }, current];
    }
    const result = runtime.execute(current.state, command);
    if (result.status !== 'committed') return [result, current];
    if (beforePublish) yield* Effect.try({ try: () => beforePublish(result), catch: memoryError });
    const invocations = new Map(current.invocations);
    invocations.set(command.id, { invocation: command, result, modelKey });
    return [result, { state: result.state, events: [...current.events, ...result.events], invocations }];
  }));

/** @public */
export const makeRuntime = createInterpreter;
export { Effect, SynchronizedRef };
