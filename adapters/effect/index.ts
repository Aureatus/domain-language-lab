import * as Effect from 'effect/Effect';
import * as SynchronizedRef from 'effect/SynchronizedRef';
import { createInterpreter, jsonSnapshot } from '../../semantic/core.ts';
import { encodeCanonicalJson as canonical } from './json.ts';

/** Effect 4 adapter. The clock is data on each invocation, never read implicitly. */
export const makeStore = initialState => Effect.suspend(() => SynchronizedRef.make({ state: jsonSnapshot(initialState), events: [], invocations: new Map() }));

export const execute = (runtime, store, invocation, { beforePublish } = {}) =>
  SynchronizedRef.modifyEffect(store, current => Effect.gen(function* () {
    const command = yield* Effect.try({ try: () => jsonSnapshot(invocation), catch: error => error });
    const modelKey = canonical(runtime.model);
    const prior = current.invocations.get(command.id);
    if (prior) {
      const same = prior.modelKey === modelKey && canonical(prior.invocation) === canonical(command);
      return [{ status: same ? 'duplicate' : 'rejected', code: same ? undefined : 'invocation-conflict', result: prior.result }, current];
    }
    const result = runtime.execute(current.state, command);
    if (result.status !== 'committed') return [result, current];
    if (beforePublish) yield* Effect.try({ try: () => beforePublish(result), catch: error => error });
    const invocations = new Map(current.invocations);
    invocations.set(command.id, { invocation: command, result, modelKey });
    return [result, { state: result.state, events: [...current.events, ...result.events], invocations }];
  }));

export const makeRuntime = model => createInterpreter(model);
export { Effect };
