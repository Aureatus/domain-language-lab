import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeJson,
  decodeStrictJson,
  decodeJsonValue,
  decodeJsonObject,
  encodeJson,
  encodeJsonPretty,
  encodeCanonicalJson,
  DurableOutcomeSchema,
  DurableOperationOutcomeSchema,
  DurableReceiptSchema,
  ApplicationExecuteRequestSchema,
  ApplicationGrantRequestSchema,
  ActionEventsTraceSchema,
  SubmissionTraceSchema,
  WorkspaceExecuteRequestSchema,
  WorkspaceApproveRequestSchema,
  WorkspaceResumeRequestSchema,
} from './json.ts';

test('encodeCanonicalJson sorts keys lexicographically and rejects non-JSON values', () => {
  assert.equal(
    encodeCanonicalJson({ b: 1, '10': 2, '2': 3, a: { z: true, m: [null, 'x'] } }),
    '{"10":2,"2":3,"a":{"m":[null,"x"],"z":true},"b":1}',
  );
  assert.throws(() => encodeCanonicalJson(undefined));
  assert.throws(() => encodeCanonicalJson(Number.NaN));
  assert.throws(() => encodeCanonicalJson(Number.POSITIVE_INFINITY));
});

test('decodeJsonObject and encodeJson/encodeJsonPretty round-trip JSON cleanly', () => {
  assert.deepEqual(decodeJsonObject('{"days":3,"reason":"rest"}'), { days: 3, reason: 'rest' });
  assert.throws(() => decodeJsonObject('[1,2,3]'));
  assert.throws(() => decodeJsonObject('"hello"'));
  assert.throws(() => decodeJsonObject('{broken'));
  assert.equal(encodeJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(encodeJsonPretty({ a: 1 }), '{\n  "a": 1\n}');
  assert.deepEqual(decodeJsonValue('[1,true,null,"ok"]'), [1, true, null, 'ok']);
});

test('DurableOutcomeSchema and DurableOperationOutcomeSchema validate discriminated unions and preserve extra fields', () => {
  const committed = decodeJson(
    DurableOutcomeSchema,
    encodeJson({ status: 'committed', state: { revision: 1, records: {} }, events: [{ id: 'e1', kind: 'created' }], extra: 42 }),
  );
  assert.equal(committed.status, 'committed');
  assert.equal(committed.events[0]['kind'], 'created');
  assert.equal(committed['extra'], 42);

  assert.throws(() => decodeJson(DurableOutcomeSchema, '{"status":"committed","state":{},"events":[{"id":123}]}'));
  assert.throws(() => decodeJson(DurableOutcomeSchema, '{"status":"pending","state":{}}'));
  assert.throws(() => decodeJson(DurableOutcomeSchema, '{"status":"rejected","state":{}}'));

  const approved = decodeJson(
    DurableOperationOutcomeSchema,
    encodeJson({
      status: 'approved',
      receipt: { format: 'semantic-approval-receipt/v2', request: { id: 'r1' }, policyId: 'p1', approver: 'bob', sig: 'ok' },
    }),
  );
  assert.equal(approved.status, 'approved');
  assert.equal(approved.receipt['sig'], 'ok');
  assert.throws(() => decodeJson(DurableReceiptSchema, '{"format":"wrong","request":{},"policyId":"p1","approver":"bob"}'));
});

test('Application and Workspace request schemas enforce strict keys, bounded identities, and safe clocks', () => {
  const execReq = decodeStrictJson(
    ApplicationExecuteRequestSchema,
    encodeJson({ actor: 'maya', action: 'leave.request', args: { days: 2 }, submissionId: 'sub-1' }),
  );
  assert.equal(execReq.submissionId, 'sub-1');
  assert.throws(() => decodeStrictJson(ApplicationExecuteRequestSchema, '{"actor":"maya","action":"a","args":{},"extra":1}'));
  assert.throws(() => decodeStrictJson(ApplicationExecuteRequestSchema, '{"actor":"maya","action":"a","args":{},"submissionId":"   "}'));
  assert.throws(() => decodeStrictJson(ApplicationGrantRequestSchema, '{"actor":"bob","requestId":"","policyId":"p1"}'));

  const wsExec = decodeStrictJson(
    WorkspaceExecuteRequestSchema,
    encodeJson({ profile: 'v2', invocation: { id: 'inv-1', action: 'reserve', args: {}, actor: 'alice', clock: 0 } }),
  );
  assert.equal(wsExec.invocation.clock, 0);
  assert.throws(() => decodeStrictJson(WorkspaceExecuteRequestSchema, '{"profile":"v2","invocation":{"id":"constructor","action":"reserve","args":{},"actor":"alice","clock":0}}'));
  assert.throws(() => decodeStrictJson(WorkspaceExecuteRequestSchema, '{"profile":"v2","invocation":{"id":"inv-1","action":"reserve","args":{},"actor":"alice","clock":-1}}'));
  assert.throws(() => decodeStrictJson(WorkspaceApproveRequestSchema, '{"profile":"v1","command":{"id":"c1","invocationId":"i1","policyId":"p1"},"actor":"bob"}'));
  assert.throws(() => decodeStrictJson(WorkspaceResumeRequestSchema, '{"profile":"v2","command":{"id":"c1","invocationId":"i1","clock":1.5}}'));
});

test('ActionEventsTraceSchema and SubmissionTraceSchema validate replay traces', () => {
  const trace = decodeJson(
    ActionEventsTraceSchema,
    encodeJson({ format: 'action-events/v1', contractId: 'c1', action: 'leave.request', actor: 'maya', args: {}, events: [{ type: 'open' }] }),
  );
  assert.equal(trace.events.length, 1);
  const nonObjectArgsTrace = decodeJson(
    ActionEventsTraceSchema,
    encodeJson({ format: 'action-events/v1', contractId: 'c1', action: 'leave.request', actor: 'maya', args: null, events: [{ type: 'open' }] }),
  );
  assert.equal(nonObjectArgsTrace.args, null);
  assert.throws(() => decodeJson(ActionEventsTraceSchema, '{"format":"wrong","contractId":"c1","action":"a","actor":"b","args":{},"events":[]}'));

  const subTrace = decodeJson(SubmissionTraceSchema, '[{"type":"submit","id":"s1","body":{"actor":"maya"}},{"type":"lost"}]');
  assert.equal(subTrace.length, 2);
  assert.throws(() => decodeJson(SubmissionTraceSchema, '[{"type":"bogus"}]'));
});
