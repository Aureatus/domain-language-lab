import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from './core.ts';
import {describeChange, runDerivedChecks} from './derive.ts';
import {present} from '../semantic/test-support.ts';

const make = () => createApp({clock: () => 123});
const capture = (app:ReturnType<typeof make>) => JSON.stringify({state: app.state, model: app.model, workspace: app.exportWorkspace()});
const policy = (report:ReturnType<typeof runDerivedChecks>,action:string,actorId:string,entry='invokeTool')=>{
  const result=present(report.cases.find(row=>row.id===`${action}:${actorId}:${entry}:policy`));
  assert.ok('ok' in result.expected);
  return {...result,expected:result.expected};
};

test('declaration diff reports exact roles/routes, no-op and ordering without mutation', () => {
  const app = make();
  const before = capture(app);
  const model = app.model;
  const patch = {allowedRoles: ['member'], notify: ['watchers']};
  const result = describeChange(model, 'resolve', patch);
  assert.deepEqual(result.roleChanges, [{role: 'lead', before: true, after: false}, {role: 'member', before: false, after: true}]);
  assert.deepEqual(result.routes, {added: [], removed: ['opener', 'assignee']});
  assert.equal(result.revision, 1);
  assert.equal(result.unchanged, false);
  assert.equal(describeChange(model, 'watch', {notify: []}).unchanged, true);
  const reorder = describeChange(model, 'comment', {notify: ['watchers', 'opener', 'assignee']});
  assert.deepEqual(reorder.routes, {added: [], removed: []});
  assert.equal(reorder.unchanged, false);
  const added = describeChange(model, 'watch', {notify: ['opener']});
  assert.ok(added.routes);
  assert.equal(added.routes.added[0], 'opener');
  assert.equal(capture(app), before);
  assert.equal(app.model, model);
  assert.deepEqual(patch, {allowedRoles: ['member'], notify: ['watchers']});
});

test('malformed patches match setRule rejection, including sparse arrays and unknown actions', () => {
  const patches = [null, [], {}, {inputs: {}}, {notify: ['unknown']}, {notify: ['opener', 'opener']},
    {allowedRoles: 'lead'}, {allowedRoles: ['admin']}, {allowedRoles: new Array(1)}, {notify: [null]}, {notify: undefined}];
  for (const patch of patches) {
    const app = make();
    const before = capture(app);
    const diff = describeChange(app.model, 'comment', patch);
    assert.deepEqual(diff, app.setRule('comment', patch));
    assert.equal(diff.ok, false);
    assert.equal(capture(app), before);
  }
  const app = make();
  assert.deepEqual(describeChange(app.model, '__proto__', {notify: []}), app.setRule('__proto__', {notify: []}));
});

test('generated current-declaration checks exercise both entry points and leave live snapshots exactly intact', () => {
  const app = make();
  assert.equal(app.dispatch('comment', {issueId: 'i1', body: 'Existing history'}, 'u2').ok, true);
  const state = app.state;
  const model = app.model;
  const before = capture(app);
  const report = runDerivedChecks(app);
  assert.equal(report.result, 'passed');
  assert.equal(report.revision, model.revision);
  assert.ok(report.cases.length > 200);
  assert.ok(report.cases.every(row => row.status === 'passed'));
  for (const action of Object.keys(model.actions)) {
    for (const actor of state.users) {
      for (const entry of ['invokeTool', 'dispatch']) {
        assert.equal(policy(report, action, actor.id, entry).expected.ok, present(model.actions[action]).allowedRoles.includes(actor.role));
      }
    }
  }
  assert.equal(policy(report, 'reopen', 'u2').actual?.ok, true);
  assert.equal(policy(report, 'resolve', 'u1').actual?.ok, true);
  assert.equal(policy(report, 'assign', 'u1').actual?.ok, true);
  assert.ok(report.cases.some(row => row.id.endsWith(':missing-title')));
  assert.ok(report.cases.some(row => row.id.endsWith(':enum-priority')));
  assert.ok(report.cases.some(row => row.id.endsWith(':reference-assignee')));
  assert.equal(capture(app), before);
  assert.equal(app.state, state);
  assert.equal(app.model, model);
  assert.deepEqual(runDerivedChecks(app.exportWorkspace()), report);
});

test('role and routing edits change the independently generated expectations', () => {
  const app = make();
  const original = runDerivedChecks(app.exportWorkspace());
  app.setRule('comment', {allowedRoles: ['member'], notify: ['assignee']});
  app.setRule('watch', {notify: ['watchers', 'opener']});
  const report = runDerivedChecks(app.exportWorkspace());
  assert.equal(report.result, 'passed');
  assert.equal(policy(original, 'comment', 'u1').expected.ok, true);
  assert.equal(policy(report, 'comment', 'u1').expected.ok, false);
  assert.deepEqual(policy(report, 'comment', 'u2').expected.recipients, [
    {recipient: 'u3', reasons: ['assignee'], paths: [{from: 'i1', relationship: 'assignee', to: 'u3'}]},
  ]);
  assert.notDeepEqual(policy(original, 'watch', 'u3').expected.recipients, policy(report, 'watch', 'u3').expected.recipients);
  const watcher = policy(report, 'watch', 'u3').expected.recipients?.find(row => row.recipient === 'u2');
  assert.deepEqual(present(watcher).reasons, ['watchers', 'opener']);
  assert.ok(policy(report, 'watch', 'u3').expected.recipients?.every(row => row.recipient !== 'u3'));
});

test('all-denied declarations pass negative cases but honestly report absent positive coverage', () => {
  const app = make();
  for (const action of Object.keys(app.model.actions)) app.setRule(action, {allowedRoles: []});
  const before = capture(app);
  const report = runDerivedChecks(app);
  assert.equal(report.result, 'unknown');
  assert.equal(report.cases.filter(row => row.status === 'unknown').length, 6);
  assert.equal(report.cases.filter(row => row.status === 'passed').length, 36);
  assert.ok(report.cases.filter(row => row.status === 'passed').every(row => 'ok' in row.expected && row.expected.ok === false && row.actual?.unchanged));
  assert.equal(capture(app), before);
});

test('unreachable reopen setup is unknown, never weakens resolve policy to pass', () => {
  const app = make();
  app.setRule('resolve', {allowedRoles: []});
  const before = capture(app);
  const report = runDerivedChecks(app);
  assert.equal(report.result, 'unknown');
  for (const actor of app.state.users) {
    const row = policy(report, 'reopen', actor.id);
    assert.equal(row.status, 'unknown');
    assert.match(present(row.reason), /no authorized setup actor/);
    assert.equal(row.actual, null);
  }
  assert.equal(capture(app), before);
});

test('resolve obtains an open witness via permitted create when reopen is denied', () => {
  const app = make();
  app.dispatch('resolve', {issueId: 'i1'}, 'u1');
  app.dispatch('resolve', {issueId: 'i2'}, 'u1');
  app.setRule('reopen', {allowedRoles: []});
  const report = runDerivedChecks(app);
  assert.equal(policy(report, 'resolve', 'u1').status, 'passed');
  assert.equal(report.result, 'unknown'); // denied reopen has no positive coverage
});

test('failed setup dispatch and exhausted history remain unknown rather than false success', () => {
  const app = make();
  for (let index = 0; index < 500; index++) assert.equal(app.setRule('watch', {notify: []}).ok, true);
  const before = capture(app);
  const report = runDerivedChecks(app.exportWorkspace());
  assert.equal(report.result, 'unknown');
  const reopen = policy(report, 'reopen', 'u1');
  assert.equal(reopen.status, 'unknown');
  assert.match(present(reopen.reason), /Setup unavailable: resolve: Workspace history limit exceeded/);
  assert.equal(policy(report, 'comment', 'u1').status, 'unknown');
  assert.match(present(policy(report,'comment','u1').reason), /Resource-bound/);
  assert.ok(report.cases.filter(row => row.status === 'passed').every(row => 'ok' in row.expected && row.expected.ok === false && row.actual?.unchanged));
  assert.equal(capture(app), before);
});

test('invalid reconstruction is reported explicitly as unknown', () => {
  const report = runDerivedChecks({format: 'unrecognized'});
  assert.equal(report.result, 'unknown');
  assert.equal(report.revision, null);
  assert.equal(present(report.cases[0]).status, 'unknown');
  const reason = present(report.cases[0]).reason;
  assert.ok(reason);
  assert.match(reason, /schema/);
});

test('history and prepared setup forks preserve exact parent evidence without sampling its clock', () => {
  let calls=0;
  const app=createApp({clock:()=>++calls});
  for(let index=0;index<100;index++) assert.equal(app.dispatch('comment',{issueId:'i1',body:'Existing history'},'u2').ok,true);
  const before=capture(app), state=app.state, model=app.model;
  const report=runDerivedChecks(app);
  assert.equal(report.result,'passed');assert.equal(report.cases.length,280);
  assert.equal(policy(report,'reopen','u2').status,'passed');
  assert.equal(policy(report,'reopen','u3','dispatch').status,'passed');
  assert.equal(calls,100);assert.equal(capture(app),before);
  assert.strictEqual(app.state,state);assert.strictEqual(app.model,model);
  assert.ok(report.cases.filter(c=>'ok' in c.expected && c.expected.ok===false).every(c=>c.actual?.unchanged));
});
