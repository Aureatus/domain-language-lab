import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {request} from 'node:http';
import {createWorkspaceServer} from './server.ts';
import type {deriveTools,WorkspaceChange} from './derive.ts';
import {invocation as v1} from '../inventory/model.ts';
import {invocation as v2} from '../inventory/v2/model.ts';

async function fixture(t:TestContext) {
  const directory = await mkdtemp('/tmp/opencode/workspace-test-');
  let server = await createWorkspaceServer({directory, port: 0});
  t.after(async () => { await server.close(); await rm(directory, {recursive: true, force: true}); });
  return {directory, get url() { return server.url; }, async restart() { await server.close(); server = await createWorkspaceServer({directory, port: 0}); }, close: () => server.close()};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const get = async (f:Fixture, profile = 'v2') => { const r = await fetch(`${f.url}/api/snapshot?profile=${profile}&actor=alice`); assert.equal(r.status, 200); return r.json(); };

test('serves the workspace browser bundle without exposing TypeScript sources', async t => {
  const f = await fixture(t);
  const page = await fetch(f.url);
  assert.match(await page.text(), /src="\/app\.js"/);
  const script = await fetch(f.url + '/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type')??'', /^text\/javascript/);
  assert.ok((await script.text()).length > 0);
  assert.equal((await fetch(f.url + '/app.ts')).status, 404);
});
async function post(f:Fixture, endpoint:string, value:object, expected = 200) {
  const response = await fetch(`${f.url}/api/${endpoint}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(value)});
  const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
}
const execute = (f:Fixture, profile:string, invocation:object) => post(f, 'execute', {profile, invocation});
const approve = (f:Fixture, id:string, invocationId:string) => post(f, 'approve', {profile: 'v2', command: {id, invocationId, policyId: 'reserve.warehouse-approval'}, actor: 'warehouse'});
const resume = (f:Fixture, id:string, invocationId:string, clock = 11) => post(f, 'resume', {profile: 'v2', command: {id, invocationId, clock}});

async function sse(f:Fixture, t:TestContext, actor = 'alice', last?:number) {
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${f.url}/api/events?profile=v2&actor=${actor}`, {signal: controller.signal, headers: last === undefined ? {} : {'last-event-id': String(last)}});
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader(); let buffer = '';
  return {close: () => controller.abort(), async next():Promise<WorkspaceChange> {
    while (!buffer.includes('\n\n')) {
      const {value, done} = await reader.read(); assert.equal(done, false); buffer += new TextDecoder().decode(value);
    }
    const index = buffer.indexOf('\n\n'), frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
    assert(frame.includes('event: change'));
    const data=frame.split('\n').find(x => x.startsWith('data: '));
    assert.ok(data);return JSON.parse(data.slice(6));
  }};
}

test('v1 persists interpreter outcomes, schema/tool parity and independent v2 DB', async t => {
  const f = await fixture(t), before = await get(f, 'v1');
  assert.equal(before.model.format, 'semantic-core/v1'); assert.equal(before.scope.authentication, false);
  assert.equal((await execute(f, 'v1', v1('reserve1', 'reserve'))).status, 'committed');
  assert.equal((await execute(f, 'v1', v1('reserve1', 'reserve'))).status, 'duplicate');
  const call=v1('invalid1','reserve'), invalid={...call,args:{...call.args,quantity:'3'}};
  assert.equal((await execute(f, 'v1', invalid)).code, 'schema');
  assert.equal(before.tools.find((x:{name:string}) => x.name === invalid.action).inputs.quantity.type, 'integer');
  assert.equal((await get(f)).state.revision, 0);
  const after = await get(f, 'v1'); assert.equal(after.state.revision, 1); assert(after.events.length > 0);
  await f.restart(); assert.deepEqual(await get(f, 'v1'), after);
  assert.equal((await execute(f, 'v1', v1('cancel1', 'cancel'))).status, 'committed');
  await post(f, 'approve', {profile: 'v1', command: {id: 'x', invocationId: 'reserve1', policyId: 'x'}, actor: 'warehouse'}, 400);
});

test('v2 pending/grants/reopen/consumed lifecycle and immutable duplicate results', async t => {
  const f = await fixture(t), command = v2('pending1', 'reserve', {reservationId: 'res1', quantity: 3});
  assert.equal((await execute(f, 'v2', command)).status, 'pending');
  let snap = await get(f); assert.equal(snap.state.revision, 0); assert.equal(snap.pending[0].status, 'pending');
  assert.equal(snap.sequence, 1); assert.deepEqual(snap.events, []);
  await f.restart(); assert.equal((await approve(f, 'grant1', command.id)).status, 'approved');
  assert.equal((await get(f)).pending[0].grants[0].approver, 'warehouse');
  await f.restart(); assert.equal((await resume(f, 'resume1', command.id)).status, 'committed');
  snap = await get(f); assert.equal(snap.pending[0].status, 'consumed'); assert.equal(snap.pending[0].resumeId, 'resume1');
  assert.equal(snap.state.records.stock.camera.values.available, 5); assert.equal(snap.sequence, 3);
  assert.equal((await execute(f, 'v2', command)).result.status, 'pending');
  assert.equal((await resume(f, 'resume1', command.id)).status, 'duplicate');
  assert.equal((await resume(f, 'resume2', command.id)).code, 'consumed');
  await f.restart(); assert.equal((await get(f)).pending[0].status, 'consumed');
  assert.equal((await execute(f, 'v2', v2('cancel', 'cancel', {reservationId: 'res1'}))).status, 'committed');
  assert.equal((await execute(f, 'v2', v2('delete', 'delete-terminal', {reservationId: 'res1'}))).status, 'committed');
  assert.equal((await get(f)).state.records.reservation.res1, undefined);
});

test('multi-client SSE preserves actor views, grant changes and reconnect/restart history without ack', async t => {
  const f = await fixture(t), alice = await sse(f, t), bob = await sse(f, t, 'bob');
  assert.equal((await alice.next()).reason, 'resync'); assert.equal((await bob.next()).reason, 'resync');
  await execute(f, 'v2', v2('small', 'reserve', {reservationId: 'res1'}));
  const a = await alice.next(), b = await bob.next(); assert.deepEqual(a, b);
  assert(a.invalidations.some(x => x.resource === 'reservation'));
  assert(!a.recipients.some(x => x.recipient === 'alice'));
  const first = await get(f); assert.equal(first.state.revision, 1);
  alice.close(); bob.close();
  await execute(f, 'v2', v2('large', 'reserve', {reservationId: 'res2', quantity: 3}));
  await approve(f, 'grant', 'large');
  const reconnected = await sse(f, t, 'alice', first.sequence);
  const resync = await reconnected.next(); assert.equal(resync.reason, 'resync'); assert(resync.sequence!==undefined&&resync.sequence > first.sequence);
  const current = await get(f); assert.equal(current.pending[0].grants.length, 1);
  await resume(f, 'resume', 'large');
  assert((await reconnected.next()).invalidations.some(x => x.view === 'pending'));
  reconnected.close();
  const db = new DatabaseSync(join(f.directory, 'v2.sqlite'));
  assert.equal(db.prepare('SELECT count(*) n FROM durable_outbox WHERE acknowledged=1').get()?.['n'], 0);
  // Even externally acknowledged rows remain historical UI facts.
  db.prepare('UPDATE durable_outbox SET acknowledged=1').run(); db.close();
  const saved = await get(f); await f.restart();
  const again = await sse(f, t, 'bob', 0); assert.equal((await again.next()).reason, 'resync');
  assert.deepEqual(await get(f), saved); assert(saved.events.length > first.events.length);
  again.close();
});

test('stale/expired approvals, competing commands, denied grant and invalid schema fail truthfully', async t => {
  const f = await fixture(t);
  await execute(f, 'v2', v2('stale', 'reserve', {reservationId: 'stale', quantity: 3}));
  await approve(f, 'grant-stale', 'stale');
  const competing = await Promise.all(['one', 'two'].map(id => execute(f, 'v2', v2(id, 'reserve', {reservationId: 'competing', quantity: 1}))));
  assert.deepEqual(competing.map(x => x.status).sort(), ['committed', 'rejected']);
  assert.equal((await resume(f, 'resume-stale', 'stale')).code, 'stale');
  await execute(f, 'v2', v2('expired', 'reserve', {reservationId: 'expired', quantity: 3, expiresAt: 20}));
  assert.equal((await post(f, 'approve', {profile: 'v2', command: {id: 'bad-grant', invocationId: 'expired', policyId: 'reserve.warehouse-approval'}, actor: 'alice'})).code, 'unauthorized-approval');
  await approve(f, 'grant-expired', 'expired');
  assert.equal((await resume(f, 'resume-expired', 'expired', 20)).code, 'precondition');
  const call=v2('invalid','reserve',{reservationId:'invalid'}),invalid={...call,args:{...call.args,quantity:'2'}};
  assert.equal((await execute(f, 'v2', invalid)).code, 'schema');
  const snap = await get(f); assert.equal(snap.state.revision, 1); assert(snap.pending.every((x:{status:string}) => x.status === 'pending'));
});

test('both clients mutate the same durable backend and observe pending/grant invalidations', async t => {
  const f = await fixture(t), alice = await sse(f, t), bob = await sse(f, t, 'bob');
  await alice.next(); await bob.next();
  await execute(f, 'v2', v2('alice-reserve', 'reserve', {reservationId: 'alice1', quantity: 3}));
  for (const stream of [alice, bob]) assert((await stream.next()).invalidations.some(x => x.view === 'pending'));
  await approve(f, 'warehouse-grant', 'alice-reserve');
  for (const stream of [alice, bob]) {
    const change = await stream.next(); assert.equal(change.reason, 'approval-ledger');
    assert.deepEqual(change.invalidations, [{view: 'pending'}]);
  }
  await resume(f, 'alice-resume', 'alice-reserve');
  await alice.next(); await bob.next();
  assert.equal((await execute(f, 'v2', v2('bob-reserve', 'reserve', {reservationId: 'bob1', actor: 'bob', quantity: 1}))).status, 'committed');
  assert.deepEqual(await alice.next(), await bob.next());
  assert.equal((await get(f)).state.revision, 2);
  assert.equal((await execute(f, 'v2', v2('warehouse-expire', 'expire', {reservationId: 'bob1', actor: 'warehouse', clock: 30}))).status, 'committed');
  assert.deepEqual(await alice.next(), await bob.next());
  assert.equal((await get(f)).state.records.reservation.bob1.values.status, 'expired');
  alice.close(); bob.close();
  assert.equal((await execute(f, 'v1', v1('v1-active', 'reserve'))).status, 'committed');
  assert.equal((await execute(f, 'v1', v1('v1-expire', 'expire', 'slotA', 'warehouse', 30))).status, 'committed');
});

test('every tool schema is enforced by its profile interpreter, not a UI-only descriptor', async t => {
  const f = await fixture(t);
  let n = 0;
  for (const profile of ['v1', 'v2']) {
    const snap = await get(f, profile);
    const tools:ReturnType<typeof deriveTools>=snap.tools;
    for (const tool of tools) {
      for (const [field, schema] of Object.entries(tool.inputs)) {
        const args = Object.fromEntries(Object.entries(tool.inputs).map(([key, value]) => [key,
          value.type === 'integer' ? Math.max(value.min ?? 0, 1) : value.type === 'string' ? value.enum?.[0] ?? 'camera' : value.type === 'boolean' ? true : []]));
        args[field] = schema.type === 'integer' ? 'not-integer' : 42;
        const result = await execute(f, profile, {id: `schema-${++n}`, action: tool.name, args, actor: 'alice', clock: 10});
        assert.equal(result.code, 'schema', `${profile} ${tool.name} ${field}`);
      }
    }
    assert.equal((await get(f, profile)).state.revision, 0);
  }
});

test('bounded exact API, cross-origin/Host guard, missing routes and SQLite lock/corruption are non-2xx', async t => {
  const f = await fixture(t);
  await post(f, 'execute', {profile: 'unknown', invocation: v1('x', 'reserve')}, 400);
  await post(f, 'resume', {profile: 'v2', command: {id: 'r', invocationId: 'x', clock: 1, receipts: []}}, 400);
  await post(f, 'execute', {profile: 'v2', invocation: v2('x', 'reserve', {reservationId: 'x'}), extra: true}, 400);
  await post(f, 'execute', {pad: 'x'.repeat(270000)}, 413);
  let response = await fetch(`${f.url}/api/execute`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{bad'});
  assert.equal(response.status, 400);
  response = await fetch(`${f.url}/api/execute`, {method: 'POST', headers: {origin: 'https://evil.example'}}); assert.equal(response.status, 403);
  response = await fetch(`${f.url}/api/snapshot?profile=v2`, {headers: {'sec-fetch-site': 'cross-site'}}); assert.equal(response.status, 403);
  const hostStatus = await new Promise((accept, reject) => { const req = request(`${f.url}/api/snapshot?profile=v2`, {headers: {Host: 'evil.example'}}, res => { res.resume(); accept(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(`${f.url}/api/snapshot?profile=unknown`)).status, 400);
  assert.equal((await fetch(`${f.url}/api/missing`)).status, 404);
  assert.equal((await fetch(`${f.url}/api/execute`)).status, 405);
  const db = new DatabaseSync(join(f.directory, 'v2.sqlite')); t.after(() => db.close());
  db.exec('BEGIN IMMEDIATE');
  const locked = await post(f, 'execute', {profile: 'v2', invocation: v2('lock', 'reserve', {reservationId: 'lock'})}, 500);
  assert.match(locked.error, /locked|busy/i); db.exec('ROLLBACK');
  assert.equal((await get(f)).sequence, 0);
  db.prepare("UPDATE durable_meta SET value='not-json' WHERE key='state_json'").run();
  const corrupt = await fetch(`${f.url}/api/snapshot?profile=v2`); assert.equal(corrupt.status, 500); assert.equal(typeof (await corrupt.json()).error, 'string');
});

test('startup port failure cleans databases; close is idempotent and terminates SSE', async t => {
  const f = await fixture(t), stream = await sse(f, t); await stream.next();
  await assert.rejects(createWorkspaceServer({directory: f.directory, port: Number(new URL(f.url).port)}), /EADDRINUSE/);
  await f.close(); await f.close(); await f.restart(); assert.equal((await get(f)).state.revision, 0);
});
