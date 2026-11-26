import assert from 'node:assert/strict';

export function withStatus<T extends {status:string},S extends T['status']>(
  result:T,status:S,
): Extract<T,{status:S}> {
  function matches(value:T):value is Extract<T,{status:S}> { return value.status===status; }
  assert.ok(matches(result),`Expected ${status}, got ${result.status}`);
  return result;
}

export function observedEvents(result:object):unknown {
  return 'events' in result ? result.events : undefined;
}
