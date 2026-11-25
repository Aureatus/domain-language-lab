import test from 'node:test';
import type {TestContext} from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as Effect from 'effect/Effect';
import {createInterpreter} from '../../semantic/v2/core.ts';
import type {Action,Expr,Model,Scalar} from '../../semantic/v2/types.ts';
import {makeDurableRuntime, makeDurableStore, initializeDurableState, durableExecute,
  durableApprove, durableResume, durablePending, durableState, pullOutbox, closeDurableStore} from './durable.ts';
import {present} from '../../semantic/test-support.ts';

const run = Effect.runPromise;
function withStatus<T extends {status:string},S extends T['status']>(value:T,status:S):Extract<T,{status:S}> {
  const matches=(candidate:T):candidate is Extract<T,{status:S}>=>candidate.status===status;
  assert.ok(matches(value),`Expected ${status}, got ${value.status}`);
  return value;
}
type Mutable<T> = T extends object ? {-readonly [K in keyof T]: Mutable<T[K]>} : T;
const lit = (value: Scalar): Expr => ({op: 'literal', value});
function fixture() {
  const action: Mutable<Action> = {inputs: {}, bindings: [], preconditions: [], policies: [{id: 'permit', when: lit(true), effect: 'allow'}],
    updates: [], inserts: [], deletes: [], observe: []};
  const model: Mutable<Model> = {format: 'semantic-core/v2', id: 'durable.approval', resources: {items: {fields: {owner: {type: 'string'}}}}, relationships: [],
    actions: {create: {...structuredClone(action), inputs: {reviewers: {type: 'ids'}}, policies: [{id: 'review', when: lit(true), effect: 'approval-required', approvers: {op: 'input', name: 'reviewers'}}],
      inserts: [{id: 'newItem', resource: 'items', key: lit('new'), values: {owner: {op: 'actor'}}}]}, touch: action}};
  return {model, state: {revision: 0, records: {items: {}}}, inv: {id: 'original', action: 'create', args: {reviewers: ['boss', 'actor']}, actor: 'actor', clock: 10}};
}
async function setup(t:TestContext, mutate: (model: ReturnType<typeof fixture>['model']) => void = () => {}) {
  const f = fixture(); mutate(f.model);
  const dir = mkdtempSync(join(tmpdir(), 'durable-approval-')), path = join(dir, 'state.sqlite');
  let db = await run(makeDurableStore(path)), rt = makeDurableRuntime(f.model);
  t.after(async () => { await run(closeDurableStore(db)); rmSync(dir, {recursive: true, force: true}); });
  await run(initializeDurableState(rt, db, f.state));
  return {...f, get db() { return db; }, get rt() { return rt; },
    async reopen() { await run(closeDurableStore(db)); db = await run(makeDurableStore(path)); rt = makeDurableRuntime(structuredClone(f.model)); }};
}
type Fixture=Awaited<ReturnType<typeof setup>>;
const approve = (f:Fixture, id = 'grant', who = 'boss', options:Pick<Parameters<typeof durableApprove>[3],'beforeCommit'> = {}) => run(durableApprove(f.rt, f.db,
  {id, invocationId: f.inv.id, policyId: 'review'}, {authenticatedApprover: who, ...options}));
const resume = (f:Fixture, id = 'resume', clock = 12, options:NonNullable<Parameters<typeof durableResume>[3]>&{receipts?:unknown} = {}) => run(durableResume(f.rt, f.db, {id, invocationId: f.inv.id, clock}, options));
const pending = (f:Fixture) => run(durablePending(f.rt, f.db, f.inv.id));
const requestFor = async (f: Awaited<ReturnType<typeof setup>>) => {
  const request=await pending(f);
  assert.ok(request);
  return request;
};
const counts = (db:DatabaseSync) => Object.fromEntries(['durable_invocations', 'durable_pending', 'durable_operations', 'durable_grants', 'durable_outbox']
  .map(table => [table, present(db.prepare(`SELECT count(*) AS n FROM ${table}`).get())['n']]));

test('pending -> restart -> grant -> restart -> exactly one resumed lifecycle commit', async t => {
  const f = await setup(t);
  const p = await run(durableExecute(f.rt, f.db, f.inv)); assert.equal(p.status, 'pending');
  assert.ok('request' in p);
  await f.reopen(); assert.deepEqual((await requestFor(f)).request, p.request);
  assert.equal((await approve(f)).status, 'approved');
  await f.reopen(); assert.deepEqual((await requestFor(f)).grants, [{policyId: 'review', approver: 'boss'}]);
  const result = await resume(f); assert.equal(result.status, 'committed');
  assert.equal(result.state.records['items']?.['new']?.version, 0); assert.equal(result.events[0]?.clock, 12);
  assert.deepEqual(result.events.map(e => e.kind), ['action', 'create']);
  await f.reopen(); assert.deepEqual(withStatus(await resume(f),'duplicate').result, result);
  assert.equal(withStatus(await resume(f, 'second-resume'),'rejected').code, 'consumed');
  assert.equal(withStatus(await approve(f, 'late-grant'),'rejected').code, 'consumed');
  assert.equal((await requestFor(f)).status, 'consumed'); assert.equal((await requestFor(f)).resumeId, 'resume');
  assert.equal((await run(durableState(f.rt, f.db))).revision, 1);
  assert.equal((await run(pullOutbox(f.db))).length, 2);
  assert.equal(withStatus(await run(durableExecute(f.rt, f.db, f.inv)),'duplicate').result.status, 'pending');
});

test('denied/self grants, fabricated receipts and premature resume confer no authority', async t => {
  const f = await setup(t); await run(durableExecute(f.rt, f.db, f.inv));
  for (const who of ['actor', 'intruder']) assert.equal(withStatus(await approve(f, who, who),'rejected').code, 'unauthorized-approval');
  const persisted = await requestFor(f);
  assert.equal(persisted.grants.length, 0);
  const runtime=createInterpreter(f.model), prepared=runtime.prepare(f.state,f.inv);
  assert.equal(prepared.status,'pending'); assert.deepEqual(prepared.request,persisted.request);
  const approval=runtime.approve(prepared.request,{policyId:'review',approver:'boss'});
  assert.equal(approval.status,'approved');
  const receipt=approval.receipt;
  await assert.rejects(run(durableResume(f.rt, f.db, {id: 'fabricated', invocationId: f.inv.id, clock: 12, receipts: [receipt]})));
  await assert.rejects(resume(f, 'fabricated-options', 12, {receipts: [receipt]}));
  assert.equal(withStatus(await resume(f, 'early'),'rejected').code, 'approval');
  assert.equal((await approve(f)).status, 'approved');
  assert.equal(withStatus(withStatus(await resume(f, 'early'),'duplicate').result,'rejected').code, 'approval');
  assert.equal((await resume(f)).status, 'committed');
});

test('IDs bind exact operation, command, approver and clock regardless of member order', async t => {
  const f = await setup(t);
  assert.equal((await pending(f)), null);
  assert.equal(withStatus(await approve(f, 'missing'),'rejected').code, 'missing-request');
  await run(durableExecute(f.rt, f.db, f.inv));
  assert.equal(withStatus(withStatus(await approve(f, 'missing'),'duplicate').result,'rejected').code, 'missing-request');
  assert.equal(withStatus(await approve(f, f.inv.id),'rejected').code, 'invocation-conflict');
  await approve(f);
  assert.equal((await run(durableApprove(f.rt, f.db, {policyId: 'review', invocationId: 'original', id: 'grant'}, {authenticatedApprover: 'boss'}))).status, 'duplicate');
  assert.equal(withStatus(await approve(f, 'grant', 'actor'),'rejected').code, 'invocation-conflict');
  assert.equal(withStatus(await approve(f, 'another-grant'),'rejected').code, 'already-granted');
  assert.equal(withStatus(await resume(f, 'grant'),'rejected').code, 'invocation-conflict');
  assert.equal(withStatus(await run(durableExecute(f.rt, f.db, {...f.inv, id: 'grant'})),'rejected').code, 'invocation-conflict');
  await resume(f);
  assert.equal(withStatus(await resume(f, 'resume', 13),'rejected').code, 'invocation-conflict');
  await f.reopen(); assert.equal((await approve(f)).status, 'duplicate');
});

test('changed durable state and changed model fail closed without consuming pending', async t => {
  const f = await setup(t); await run(durableExecute(f.rt, f.db, f.inv)); await approve(f);
  const changed = structuredClone(f.model); changed.id = 'changed'; const other = makeDurableRuntime(changed);
  await assert.rejects(run(durableResume(other, f.db, {id: 'changed-model', invocationId: f.inv.id, clock: 12})));
  await run(durableExecute(f.rt, f.db, {...f.inv, id: 'touch', action: 'touch', args: {}}));
  await f.reopen(); assert.equal(withStatus(await resume(f),'rejected').code, 'stale');
  assert.equal((await requestFor(f)).status, 'pending'); assert.equal((await run(pullOutbox(f.db))).length, 1);
});

for (const scenario of ['deny', 'precondition', 'requirements']) test(`fresh clock rechecks ${scenario}; no approval bypass`, async t => {
  const guard: Expr = {op: 'lt', left: {op: 'clock'}, right: lit(20)};
  const f = await setup(t, model => {
    const a = present(model.actions['create']);
    if (scenario === 'deny') a.policies.push({id: 'lateDeny', effect: 'deny', when: {op: 'not', value: guard}});
    if (scenario === 'precondition') a.preconditions.push({id: 'deadline', when: guard});
    if (scenario === 'requirements') { present(a.policies[0]).when = guard; a.policies.push({id: 'allowLater', when: lit(true), effect: 'allow'}); }
  });
  await run(durableExecute(f.rt, f.db, f.inv)); await approve(f); await f.reopen();
  assert.equal(withStatus(await resume(f, 'late', 20),'rejected').code, {deny: 'denied', precondition: 'precondition', requirements: 'stale'}[scenario]);
  assert.equal((await requestFor(f)).status, 'pending'); assert.equal((await run(pullOutbox(f.db))).length, 0);
  assert.deepEqual(await run(durableState(f.rt, f.db)), f.state);
});

test('beforeCommit failures roll back every request/grant/operation/state/outbox write', async t => {
  const f = await setup(t), fail = {beforeCommit() { throw Error('injected'); }};
  let before = counts(f.db);
  await assert.rejects(run(durableExecute(f.rt, f.db, f.inv, fail))); assert.deepEqual(counts(f.db), before);
  await run(durableExecute(f.rt, f.db, f.inv)); before = counts(f.db);
  await assert.rejects(approve(f, 'grant', 'boss', fail)); assert.deepEqual(counts(f.db), before);
  assert.equal((await requestFor(f)).grants.length, 0);
  await approve(f); before = counts(f.db);
  await assert.rejects(resume(f, 'resume', 12, fail)); assert.deepEqual(counts(f.db), before);
  assert.equal((await requestFor(f)).status, 'pending'); assert.deepEqual(await run(durableState(f.rt, f.db)), f.state);
  await f.reopen(); assert.equal((await resume(f)).status, 'committed');
});

test('every policy needs an internal grant; early/older-clock attempts do not consume', async t => {
  const f = await setup(t, model => present(model.actions['create']).policies.push({id: 'secondReview', when: lit(true), effect: 'approval-required', approvers: lit('other')}));
  await run(durableExecute(f.rt, f.db, f.inv)); await approve(f);
  assert.equal(withStatus(await resume(f, 'partial'),'rejected').code, 'approval');
  assert.equal((await run(durableApprove(f.rt, f.db, {id: 'second-grant', invocationId: f.inv.id, policyId: 'secondReview'}, {authenticatedApprover: 'other'}))).status, 'approved');
  await f.reopen();
  assert.equal((await resume(f, 'old-clock', 9)).status, 'rejected');
  assert.equal((await requestFor(f)).status, 'pending');
  assert.equal((await resume(f)).status, 'committed');
});

test('malformed stored operation outcome fails closed on retry', async t => {
  const f = await setup(t); await run(durableExecute(f.rt, f.db, f.inv)); await approve(f);
  f.db.prepare('UPDATE durable_operations SET outcome_json=? WHERE id=?').run('3', 'grant');
  await f.reopen(); await assert.rejects(approve(f));
});

test('explicit format selection and v2 state validation reject malformed declarations/state', async t => {
  const f = await setup(t);
  assert.throws(() => makeDurableRuntime({...f.model, format: 'semantic-core/v99'}));
  f.db.prepare("UPDATE durable_meta SET value=? WHERE key='state_json'").run(JSON.stringify({revision: 0, records: {items: {bad: {version: 0, values: {owner: 1}}}}}));
  await assert.rejects(run(durableState(f.rt, f.db)));
  await assert.rejects(run(durableExecute(f.rt, f.db, f.inv)));
});
