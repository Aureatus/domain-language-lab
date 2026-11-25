import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp, forkApp} from './core.ts';
import {present} from '../semantic/test-support.ts';

const app = () => createApp({clock: () => 1794391200000});
type App=ReturnType<typeof createApp>;
const accepted=<T extends object>(result:({ok:true}&T)|{ok:false;reason:string}):{ok:true}&T=>{
  assert.ok(result.ok,'reason' in result?String(result.reason):undefined);return result;
};

test('trusted forks isolate siblings, prepared snapshots, restores, rule edits and clock contracts', () => {
  let calls=0;
  const parent=createApp({clock:()=>100 + ++calls});
  accepted(parent.dispatch('comment',{issueId:'i1',body:'Before fork'},'u2'));
  const state=parent.state, model=parent.model, document=parent.exportWorkspace();
  let forkCalls=0;
  const child=forkApp(parent,{clock:()=>200 + ++forkCalls});
  const sibling=forkApp(parent);
  audit(child);audit(sibling);
  assert.strictEqual(child.state,state);assert.strictEqual(child.model,model);
  assert.equal(calls,1);assert.equal(forkCalls,0);
  accepted(child.setRule('resolve',{allowedRoles:['member'],notify:[]}));
  accepted(child.dispatch('resolve',{issueId:'i1'},'u2'));
  const prepared=forkApp(child,{clock:()=>300});
  const grandchild=forkApp(prepared,{clock:()=>400});
  assert.equal(accepted(grandchild.dispatch('reopen',{issueId:'i1'},'u2')).event.createdAt,400);
  assert.equal(present(prepared.state.issues[0]).status,'resolved');
  assert.equal(present(child.state.issues[0]).status,'resolved');
  assert.equal(forkCalls,1);assert.equal(calls,1);
  audit(child);audit(prepared);audit(grandchild);
  assert.strictEqual(parent.state,state);assert.strictEqual(parent.model,model);
  assert.deepEqual(parent.exportWorkspace(),document);
  assert.deepEqual(sibling.exportWorkspace(),document);
  assert.equal(accepted(sibling.dispatch('watch',{issueId:'i1'},'u1')).event.createdAt,102);
  accepted(parent.restoreWorkspace(createApp().exportWorkspace()));
  accepted(parent.setRule('comment',{notify:[]}));
  const afterRestore=forkApp(parent,{clock:()=>500});
  assert.equal(afterRestore.state.events.length,0);
  assert.deepEqual(present(afterRestore.model.actions['comment']).notify,[]);
  assert.deepEqual(child.state.events[0],state.events[0]);
  accepted(child.restoreWorkspace(document));
  assert.equal(accepted(child.dispatch('comment',{issueId:'i1',body:'After child restore'},'u1')).event.createdAt,202);
  assert.equal(forkCalls,2);assert.equal(calls,2);
  assert.equal(afterRestore.state.events.length,0);
  assert.throws(()=>{present(afterRestore.model.actions['comment']).notify.push('opener')},TypeError);
  for(const fake of [{},parent.exportWorkspace(),Object.freeze({state,model}),Object.create(parent)]) {
    assert.throws(()=>forkApp(fake),/trusted runtime/);
  }
  assert.throws(()=>forkApp(parent,{state}),/Unknown fork option/);
  assert.throws(()=>forkApp(parent,{clock:42}),/clock/);
  assert.throws(()=>createApp({state,model}),/Unknown application option/);
  const broken=forkApp(parent,{clock:()=>NaN});
  const before=broken.exportWorkspace();
  rejectedWithoutChange(broken,'comment',{issueId:'i1',body:'Clock failure'});
  assert.deepEqual(broken.exportWorkspace(),before);
});

test('explainAction is a frozen pure query sharing dispatch preparation', () => {
  let samples=0;
  const runtime=createApp({clock:()=>{samples++;return 1794391200000}});
  const state=runtime.state, model=runtime.model, journal=runtime.exportWorkspace();
  const cases=[
    ['create',{title:'Valid'},'u1','available'],
    ['comment',{issueId:'i1',body:'Valid'},'u2','available'],
    ['resolve',{issueId:'i1'},'u1','available'],
    ['watch',{issueId:'i1'},'u3','available'],
    ['create',{},'u1','missing-input'],
    ['comment',{issueId:'i1'},'u1','missing-input'],
    ['comment',{issueId:'i1',body:'   '},'u1','schema'],
    ['resolve',{issueId:'missing'},'u1','schema'],
    ['reopen',{issueId:'i1'},'u1','precondition'],
    ['assign',{issueId:'i1',assignee:'u3'},'u1','precondition'],
    ['assign',{issueId:'i1',assignee:null},'u1','available'],
    ['resolve',{issueId:'i1'},'u2','policy'],
    ['resolve',{issueId:'secret'},'u2','policy'],
    ['comment',{},'missing','actor'],
    ['unknown',{},'u1','action'],
  ];
  for(const [action,args,actorId,category] of cases){
    const e=runtime.explainAction(action,args,actorId);
    assert.equal(e.category,category);
    assert.equal(e.available,category==='available');
    assert.equal(e.revision,1);
    assert.equal(e.source,action==='unknown'?null:`actions.${action}`);
    assert.ok(Object.isFrozen(e) && Object.isFrozen(e.missingRequirements));
    // Independent fresh instance keeps all cases on the identical seed.
    const result=app().dispatch(action,args,actorId);
    assert.equal(result.ok,e.available);
    if(!result.ok)assert.equal(e.reason,result.reason);
  }
  assert.deepEqual(runtime.explainAction('assign',{},'u1').missingRequirements,['args.issueId','args.assignee']);
  assert.deepEqual(runtime.explainAction('resolve',{issueId:'secret'},'u2'),runtime.explainAction('resolve',{issueId:'i1'},'u2'),'denial does not inspect or disclose referenced records');
  assert.equal(samples,0);
  assert.strictEqual(runtime.state,state);assert.strictEqual(runtime.model,model);
  assert.deepEqual(runtime.exportWorkspace(),journal);
});

test('availability tracks applied revisions and preconditions but does not promise clock execution', () => {
  const runtime=app();
  const before=runtime.explainAction('resolve',{issueId:'i1'},'u2');
  accepted(runtime.setRule('resolve',{allowedRoles:['member']}));
  const after=runtime.explainAction('resolve',{issueId:'i1'},'u2');
  assert.equal(before.available,false);assert.equal(after.available,true);assert.equal(after.revision,2);
  accepted(runtime.dispatch('resolve',{issueId:'i1'},'u2'));
  assert.equal(runtime.explainAction('resolve',{issueId:'i1'},'u2').category,'precondition');
  accepted(runtime.dispatch('assign',{issueId:'i1',assignee:null},'u1'));
  assert.equal(runtime.explainAction('assign',{issueId:'i1',assignee:null},'u1').reason,'Assignee is unchanged');
  const broken=createApp({clock:()=>{throw Error('clock unavailable')}});
  assert.equal(broken.explainAction('create',{title:'Valid'},'u1').available,true);
  const failed=broken.dispatch('create',{title:'Valid'},'u1');assert.equal(failed.ok,false);assert.equal(failed.reason,'clock unavailable');
});
function rejectedWithoutChange(runtime:App,action:string,args:unknown,actor='u1') {
  const before = runtime.state;
  const model = runtime.model;
  const result = runtime.dispatch(action, args, actor);
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.strictEqual(runtime.state, before);
  assert.strictEqual(runtime.model, model);
}
function audit(runtime:App) {
  const results = runtime.check();
  assert.ok(results.length >= 6);
  for (const result of results) assert.equal(result.ok, true, result.name);
}

test('seed is a credible real workspace and all current-state audits pass', () => {
  const runtime = app();
  assert.deepEqual(runtime.state.users.map(user => [user.id, user.role]), [['u1', 'lead'], ['u2', 'member'], ['u3', 'member']]);
  assert.equal(runtime.state.issues.length, 2);
  assert.ok(runtime.state.issues.some(issue => issue.priority === 'high'));
  assert.equal(runtime.state.events.length, 0);
  assert.equal(runtime.explain('missing'), null);
  audit(runtime);
});

test('sparse rule arrays reject atomically instead of creating an unreplayable journal', () => {
  const runtime = app();
  for (const field of ['notify', 'allowedRoles']) {
    const before = runtime.exportWorkspace();
    const model = runtime.model;
    assert.equal(runtime.setRule('comment', {[field]: Array(1)}).ok, false);
    assert.strictEqual(runtime.model, model);
    assert.deepEqual(runtime.exportWorkspace(), before);
    assert.equal(runtime.restoreWorkspace(runtime.exportWorkspace()).ok, true);
  }
});

test('live create, assign, comment, resolve, reopen and watch workflow', () => {
  const runtime = app();
  const created = accepted(runtime.dispatch('create', {title: 'Preserve invoice currency'}, 'u2'));
  assert.equal(created.value.id, 'i3');
  assert.equal(created.value.priority, 'normal');
  assert.equal(created.value.description, '');
  assert.equal(created.value.opener, 'u2');
  assert.equal(created.value.version, 1);
  accepted(runtime.dispatch('assign', {issueId: 'i3', assignee: 'u3'}, 'u1'));
  accepted(runtime.dispatch('watch', {issueId: 'i3'}, 'u2'));
  const comment = accepted(runtime.dispatch('comment', {issueId: 'i3', body: 'Reproduced on EUR invoices.'}, 'u3'));
  assert.equal(present(comment.value.comments[0]).author, 'u3');
  assert.equal(present(comment.value.comments[0]).createdAt, 1794391200000);
  assert.deepEqual(comment.event.recipients.map(item => item.recipient), ['u2']);
  accepted(runtime.dispatch('resolve', {issueId: 'i3'}, 'u1'));
  assert.equal(present(runtime.state.issues.at(-1)).status, 'resolved');
  accepted(runtime.dispatch('reopen', {issueId: 'i3'}, 'u2'));
  accepted(runtime.dispatch('watch', {issueId: 'i3'}, 'u2'));
  const final = accepted(runtime.dispatch('assign', {issueId: 'i3', assignee: null}, 'u1'));
  assert.equal(final.value.version, 8);
  assert.equal(final.value.assignee, null);
  assert.deepEqual(final.value.watchers, []);
  assert.equal(runtime.state.events.length, 8);
  audit(runtime);
});

test('policy edits immediately change authorization and derived tool declarations', () => {
  const runtime = app();
  rejectedWithoutChange(runtime, 'resolve', {issueId: 'i1'}, 'u2');
  const oldTools = runtime.tools();
  accepted(runtime.setRule('resolve', {allowedRoles: ['member'], notify: ['assignee']}));
  assert.equal(runtime.model.revision, 2);
  const tool=present(runtime.tools().find(tool=>tool.name==='resolve'));
  assert.deepEqual(tool.allowedRoles, ['member']);
  assert.deepEqual(tool.notify, ['assignee']);
  assert.deepEqual(present(oldTools.find(tool=>tool.name==='resolve')).allowedRoles, ['lead']);
  rejectedWithoutChange(runtime, 'resolve', {issueId: 'i1'}, 'u1');
  const result = accepted(runtime.dispatch('resolve', {issueId: 'i1'}, 'u2'));
  assert.equal(result.event.revision, 2);
  assert.deepEqual(result.event.recipients.map(item => item.recipient), ['u3']);
  assert.equal(result.event.source, 'actions.resolve');
  accepted(runtime.setRule('comment', {allowedRoles: [], notify: []}));
  rejectedWithoutChange(runtime, 'comment', {issueId: 'i1', body: 'No longer permitted'}, 'u1');
  audit(runtime);
});

test('relationship routing excludes actor and deduplicates recipients without losing reasons', () => {
  const runtime = app();
  accepted(runtime.dispatch('assign', {issueId: 'i1', assignee: 'u2'}, 'u1'));
  const result = accepted(runtime.dispatch('comment', {issueId: 'i1', body: 'Retry patch is ready.'}, 'u3'));
  const routed = result.event.recipients;
  assert.deepEqual(routed.map(item => item.recipient), ['u2', 'u1']);
  assert.deepEqual(present(routed[0]).reasons, ['opener', 'assignee', 'watchers']);
  assert.deepEqual(present(routed[0]).paths, [
    {from: 'i1', relationship: 'opener', to: 'u2'},
    {from: 'i1', relationship: 'assignee', to: 'u2'},
    {from: 'i1', relationship: 'watchers', to: 'u2'},
  ]);
  const inbox = runtime.state.notifications.filter(item => item.eventId === result.event.id);
  assert.equal(inbox.length, 2);
  assert.deepEqual(present(inbox[0]).reasons, present(routed[0]).reasons);
  const actorComment = accepted(runtime.dispatch('comment', {issueId: 'i1', body: 'Verified.'}, 'u2'));
  assert.ok(actorComment.event.recipients.every(item => item.recipient !== 'u2'));
  audit(runtime);
});

test('historical why retains rule, actor, relationship and change snapshots', () => {
  const runtime = app();
  const result = accepted(runtime.dispatch('comment', {issueId: 'i1', body: 'Captured evidence'}, 'u3'));
  const historical=runtime.explain(result.event.id);assert.ok(historical);
  const encoded = JSON.stringify(historical);
  accepted(runtime.dispatch('watch', {issueId: 'i1'}, 'u2')); // remove prior recipient path
  accepted(runtime.dispatch('assign', {issueId: 'i1', assignee: 'u1'}, 'u1'));
  const patch: {notify: string[]; allowedRoles: string[]} = {notify: [], allowedRoles: ['lead']};
  accepted(runtime.setRule('comment', patch));
  patch.notify.push('watchers');
  assert.deepEqual(present(runtime.model.actions['comment']).notify, []);
  assert.equal(JSON.stringify(runtime.explain(result.event.id)), encoded);
  assert.equal(historical.revision, 1);
  assert.equal(historical.relationshipSnapshot.assignee, 'u3');
  assert.deepEqual(historical.relationshipSnapshot.watchers, ['u1', 'u2']);
  assert.throws(() => { historical.rule.notify.push('assignee'); }, TypeError);
  assert.throws(() => { historical.actor.role = 'lead'; }, TypeError);
  const after=present(historical.changes[0]).after;
  assert.ok(Array.isArray(after));const savedComment=present(after[0]);assert.equal(typeof savedComment.body,'string');
  assert.throws(() => { savedComment.body = 'tampered'; }, TypeError);
  assert.throws(() => { present(runtime.state.users[0]).role = 'member'; }, TypeError);
  assert.throws(() => { Object.assign(present(runtime.model.actions['comment']).inputs, {type: 'unknown'}); }, TypeError);
  const future = accepted(runtime.dispatch('comment', {issueId: 'i1', body: 'Future rule'}, 'u1'));
  assert.deepEqual(future.event.recipients, []);
  audit(runtime);
});

test('invalid inputs, unknown IDs, actions, and invalid transitions never mutate', () => {
  const runtime = app();
  const invalidCases: [string, unknown, string][] = [
    ['missing', {}, 'u1'], ['__proto__', {}, 'u1'], ['create', {title: 'Hi'}, 'missing'],
    ['create', {}, 'u1'], ['create', {title: '   '}, 'u1'],
    ['create', {title: 'x'.repeat(161)}, 'u1'], ['create', {title: 'Hi', priority: 'urgent'}, 'u1'],
    ['create', {title: 'Hi', hidden: true}, 'u1'], ['create', null, 'u1'], ['create', [], 'u1'],
    ['create', {title: 42}, 'u1'], ['create', {title: 'Hi', description: null}, 'u1'],
    ['assign', {issueId: 'i1', assignee: 'u9'}, 'u1'], ['assign', {issueId: 'i1'}, 'u1'],
    ['assign', {issueId: 'i1', assignee: 'u2'}, 'u2'], ['assign', {issueId: 'i1', assignee: 'u3'}, 'u1'],
    ['comment', {issueId: 'missing', body: 'Hi'}, 'u1'], ['comment', {issueId: 'i1', body: ''}, 'u1'],
    ['reopen', {issueId: 'i1'}, 'u1'], ['watch', {issueId: 'i1', userId: 'u2'}, 'u1'],
  ];
  for (const [action, args, actor] of invalidCases) rejectedWithoutChange(runtime, action, args, actor);
  accepted(runtime.dispatch('resolve', {issueId: 'i1'}, 'u1'));
  rejectedWithoutChange(runtime, 'resolve', {issueId: 'i1'});
  audit(runtime);
});

test('unknown schema/rule extension attempts fail rather than silently weakening declarations', () => {
  const runtime = app();
  const before = runtime.model;
  for (const [action, patch] of [
    ['missing', {notify: []}], ['__proto__', {notify: []}], ['comment', {}], ['comment', null],
    ['comment', {inputs: {type: 'mystery'}}], ['comment', {allowedRoles: ['admin']}],
    ['comment', {notify: ['project.members']}], ['comment', {notify: ['watchers', 'watchers']}],
    ['comment', {allowedRoles: 'lead'}], ['comment', {notify: [], unexpected: true}],
  ]) {
    assert.equal(runtime.setRule(action, patch).ok, false);
    assert.strictEqual(runtime.model, before);
  }
  assert.throws(() => createApp({model: {actions: {bad: {inputs: {type: 'mystery'}}}}}), /Unknown application option/);
  assert.throws(() => createApp({clock: 1}), /clock/);
  audit(runtime);
});

test('tool schemas derive from declarations and tool/direct invocation have exact parity', () => {
  const direct = app();
  const tool = app();
  assert.equal(direct.tools().length, 6);
  for (const descriptor of direct.tools()) {
    assert.deepEqual(descriptor.parameters, present(direct.model.actions[descriptor.name]).inputs);
    assert.equal(descriptor.label, present(direct.model.actions[descriptor.name]).label);
    assert.equal(descriptor.parameters.additionalProperties, false);
  }
  for (const [name, args, actor] of [
    ['create', {title: 'Make exports resumable', priority: 'high'}, 'u2'],
    ['assign', {issueId: 'i3', assignee: 'u3'}, 'u1'],
    ['watch', {issueId: 'i3'}, 'u2'], ['comment', {issueId: 'i3', body: 'Use a cursor.'}, 'u3'],
    ['resolve', {issueId: 'i3'}, 'u2'], ['resolve', {issueId: 'i3'}, 'u1'],
    ['reopen', {issueId: 'i3'}, 'u2'], ['unknown', {}, 'u1'],
  ]) assert.deepEqual(direct.dispatch(name, args, actor), tool.invokeTool(name, args, actor));
  assert.deepEqual(direct.state, tool.state);
  audit(direct);
});

test('commit groups issue changes, event and inbox; retained state sees no partial updates', () => {
  const runtime = app();
  const before = runtime.state;
  const result = accepted(runtime.dispatch('resolve', {issueId: 'i1'}, 'u1'));
  assert.equal(present(before.issues[0]).status, 'open');
  assert.equal(before.events.length, 0);
  assert.equal(before.notifications.length, 0);
  assert.notStrictEqual(runtime.state, before);
  assert.deepEqual(result.event.changes, [
    {field: 'status', before: 'open', after: 'resolved'}, {field: 'version', before: 1, after: 2},
  ]);
  assert.equal(runtime.state.events.length, 1);
  assert.equal(runtime.state.notifications.length, 2);
  assert.equal(present(runtime.state.issues[0]).version, 2);
  audit(runtime);
});

test('failing clocks do not publish a partial mutation or consume event identity', () => {
  for (const clock of [() => NaN, () => Infinity, () => 'now', () => { throw Error('Clock unavailable'); }]) {
    const runtime = createApp({clock});
    rejectedWithoutChange(runtime, 'create', {title: 'Test clock'});
    rejectedWithoutChange(runtime, 'comment', {issueId: 'i1', body: 'Test clock'});
    audit(runtime);
  }
  let calls = 0;
  const runtime = createApp({clock: () => ++calls});
  rejectedWithoutChange(runtime, 'resolve', {issueId: 'i1'}, 'u2');
  assert.equal(calls, 0);
  const result = accepted(runtime.dispatch('resolve', {issueId: 'i1'}, 'u1'));
  assert.equal(result.event.id, 'e1');
  assert.equal(result.event.createdAt, 1);
});

const mutable=<T>(value:T):T=>JSON.parse(JSON.stringify(value));

function mixedHistory() {
  let time = 1794391200000;
  const runtime = createApp({clock: () => time += 37});
  const prefixes = [{state: runtime.state, model: runtime.model}];
  const save=(result:{ok:true}|{ok:false;reason:string})=> {
    accepted(result);
    prefixes.push({state: runtime.state, model: runtime.model});
  };
  save(runtime.dispatch('create', {title: '  Preserve exact text  ', priority: 'high'}, 'u2'));
  save(runtime.invokeTool('assign', {issueId: 'i3', assignee: 'u3'}, 'u1'));
  save(runtime.dispatch('comment', {issueId: 'i3', body: 'Before routing change'}, 'u3'));
  save(runtime.setRule('comment', {notify: ['assignee'], allowedRoles: ['member']}));
  save(runtime.dispatch('watch', {issueId: 'i3'}, 'u1'));
  save(runtime.dispatch('comment', {issueId: 'i3', body: 'After routing change'}, 'u2'));
  save(runtime.setRule('resolve', {allowedRoles: ['member'], notify: []}));
  save(runtime.dispatch('resolve', {issueId: 'i3'}, 'u2'));
  save(runtime.dispatch('reopen', {issueId: 'i3'}, 'u3'));
  save(runtime.dispatch('assign', {issueId: 'i3', assignee: null}, 'u1'));
  save(runtime.setRule('watch', {notify: []})); // accepted no-op revision
  return {runtime, prefixes};
}

test('workspace roundtrip preserves mixed history, IDs, revisions and event-time explanations', () => {
  const {runtime} = mixedHistory();
  const document = runtime.exportWorkspace();
  const restored = createApp({workspace: mutable(document), clock: () => 987654321});
  assert.deepEqual(restored.state, runtime.state);
  assert.deepEqual(restored.model, runtime.model);
  assert.deepEqual(restored.exportWorkspace(), document);
  assert.deepEqual(document.journal[0], {step: 1, kind: 'dispatch', action: 'create',
    args: {title: '  Preserve exact text  ', description: '', priority: 'high'}, actorId: 'u2',
    createdAt: 1794391200037, eventId: 'e1', issueId: 'i3', revision: 1});
  assert.deepEqual(document.journal[3], {step: 4, kind: 'setRule', action: 'comment',
    patch: {notify: ['assignee'], allowedRoles: ['member']}, revision: 2});
  for (const event of runtime.state.events) assert.deepEqual(restored.explain(event.id), event);
  assert.equal(present(restored.explain('e3')??undefined).rule.notify.length, 3);
  assert.deepEqual(present(restored.explain('e5')??undefined).rule.notify, ['assignee']);
  assert.equal(present(restored.explain('e3')??undefined).revision, 1);
  assert.equal(present(restored.explain('e5')??undefined).revision, 2);
  assert.equal(present(present(restored.state.issues[2]).comments[0]).id, 'c3');
  assert.equal(present(present(restored.state.issues[2]).comments[1]).id, 'c5');
  const next = accepted(restored.dispatch('create', {title: 'Future issue'}, 'u1'));
  assert.equal(next.value.id, 'i4');
  assert.equal(next.event.id, 'e9');
  assert.equal(next.event.createdAt, 987654321);
  assert.equal(restored.exportWorkspace().journal.length, document.journal.length + 1);
  audit(restored);
});

test('exports are deeply detached frozen JSON and do not journal rejected operations', () => {
  const runtime = app();
  accepted(runtime.dispatch('create', {title: 'Immutable export'}, 'u1'));
  const first = runtime.exportWorkspace();
  const second = runtime.exportWorkspace();
  assert.notStrictEqual(first, second);
  const firstEntry=present(first.journal[0]);assert.equal(firstEntry.kind,'dispatch');
  assert.notStrictEqual(firstEntry.args,present(runtime.state.events[0]).args);
  assert.throws(() => { firstEntry.args['title'] = 'Changed'; }, TypeError);
  assert.throws(() => { Array.prototype.push.call(first.journal,{}); }, TypeError);
  rejectedWithoutChange(runtime, 'resolve', {issueId: 'i1'}, 'u2');
  assert.equal(runtime.setRule('comment', {notify: ['unknown']}).ok, false);
  assert.deepEqual(runtime.exportWorkspace(), first);
  const patch: {notify: string[]} = {notify: []};
  accepted(runtime.setRule('comment', patch));
  patch.notify.push('opener');
  const edited=present(runtime.exportWorkspace().journal[1]);assert.equal(edited.kind,'setRule');
  assert.deepEqual(edited.patch['notify'],[]);
  assert.equal(first.journal.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});

test('every replay prefix is read-only, exact, and never changes the live journal or calls its clock', () => {
  const {runtime, prefixes} = mixedHistory();
  const state = runtime.state;
  const model = runtime.model;
  const journal = runtime.exportWorkspace();
  for (let index = prefixes.length - 1; index >= 0; index--) {
    const preview = accepted(runtime.previewWorkspace(index));
    assert.deepEqual(preview.state, present(prefixes[index]).state);
    assert.deepEqual(preview.model, present(prefixes[index]).model);
    assert.throws(() => { present(preview.state.issues[0]).title = 'Changed'; }, TypeError);
    assert.throws(() => { present(preview.model.actions['create']).notify.push('opener'); }, TypeError);
    assert.equal(Reflect.get(preview,'dispatch'),undefined);
  }
  for (const count of [-1, 0.5, NaN, Infinity, '1', null, undefined, prefixes.length]) {
    assert.equal(runtime.previewWorkspace(count).ok, false);
  }
  assert.strictEqual(runtime.state, state);
  assert.strictEqual(runtime.model, model);
  assert.deepEqual(runtime.exportWorkspace(), journal);
});

test('restore replaces privately reconstructed state atomically and retains original future clock', () => {
  const {runtime: source} = mixedHistory();
  let calls = 0;
  const runtime = createApp({clock: () => 1000 + ++calls});
  accepted(runtime.dispatch('comment', {issueId: 'i1', body: 'Old state'}, 'u1'));
  const before = runtime.state;
  accepted(runtime.restoreWorkspace(source.exportWorkspace()));
  assert.equal(calls, 1);
  assert.deepEqual(runtime.state, source.state);
  assert.equal(present(before.events[0]).args['body'], 'Old state');
  accepted(runtime.previewWorkspace(5));
  assert.equal(calls, 1);
  const next = accepted(runtime.dispatch('comment', {issueId: 'i3', body: 'New time'}, 'u2'));
  assert.equal(next.event.createdAt, 1002);
  assert.equal(calls, 2);
  assert.equal(runtime.exportWorkspace().journal.length, source.exportWorkspace().journal.length + 1);
  accepted(runtime.restoreWorkspace(app().exportWorkspace()));
  assert.equal(runtime.state.events.length, 0);
  assert.equal(runtime.model.revision, 1);
  assert.equal(runtime.exportWorkspace().journal.length, 0);
});

test('malformed imports including late replay failures preserve state/model/events/journal identities', () => {
  const {runtime} = mixedHistory();
  const valid = runtime.exportWorkspace();
  const state = runtime.state;
  const model = runtime.model;
  const events = runtime.state.events;
  type EditableEntry={kind?:unknown;step?:unknown;action?:unknown;actorId?:unknown;args:Record<string,unknown>;eventId?:unknown;issueId?:unknown;revision?:unknown;createdAt?:unknown;patch:Record<string,unknown>};
  type EditableDocument={format?:unknown;seedVersion?:unknown;extra?:unknown;journal:EditableEntry[]};
  const edits:((doc:EditableDocument)=>void)[] = [
    doc => { doc.format = 'live-issue-workspace/v2'; },
    doc => { doc.seedVersion = 2; },
    doc => { doc.extra = true; },
    doc => { delete doc.format; },
    doc => { Object.assign(doc,{journal:{}}); },
    doc => { present(doc.journal[0]).kind = 'network'; },
    doc => { present(doc.journal[0]).step = 2; },
    doc => { present(doc.journal[0]).action = 'unknown'; },
    doc => { present(doc.journal[0]).action = ['create']; },
    doc => { present(doc.journal[0]).actorId = 'u9'; },
    doc => { present(doc.journal[0]).args['title'] = ' '; },
    doc => { delete present(doc.journal[0]).args['description']; }, // canonical validated arguments required
    doc => { present(doc.journal[0]).args['schema'] = {type: 'unknown'}; },
    doc => { present(doc.journal[0]).eventId = 'e99'; },
    doc => { present(doc.journal[0]).issueId = 'i99'; },
    doc => { present(doc.journal[0]).revision = 99; },
    doc => { present(doc.journal[0]).createdAt = Infinity; },
    doc => { present(doc.journal[0]).createdAt = NaN; },
    doc => { present(doc.journal[0]).createdAt = 1e100; },
    doc => { present(doc.journal[0]).createdAt = '2026-11-11'; },
    doc => { present(doc.journal[1]).args['issueId'] = 'i9'; },
    doc => { present(doc.journal[1]).args['assignee'] = 'u9'; },
    doc => { present(doc.journal[3]).patch['inputs'] = {type: 'mystery'}; },
    doc => { present(doc.journal[3]).patch['notify'] = ['unknown']; },
    doc => { present(doc.journal[3]).patch['notify'] = ['opener', 'opener']; },
    doc => { present(doc.journal[3]).patch['allowedRoles'] = ['admin']; },
    doc => { present(doc.journal.at(-1)).revision = 100; }, // late failure after accepted actions
    doc => { present(doc.journal.at(-1)).patch = {}; },
    doc => { doc.journal.reverse(); },
    doc => { doc.journal.push(present(doc.journal.at(-1))); },
  ];
  for (const edit of edits) {
    const document:EditableDocument=JSON.parse(JSON.stringify(valid));
    edit(document);
    const result = runtime.restoreWorkspace(document);
    assert.equal(result.ok, false, JSON.stringify(document));
    assert.equal(typeof result.reason, 'string');
    assert.strictEqual(runtime.state, state);
    assert.strictEqual(runtime.model, model);
    assert.strictEqual(runtime.state.events, events);
    assert.deepEqual(runtime.exportWorkspace(), valid);
  }
  assert.throws(() => createApp({workspace: {...valid, seedVersion: 99}}), /Unsupported.*version/);
  for (const document of [null, [], 'not JSON', undefined, {format: valid.format, seedVersion: 1, journal: [] , extra: undefined}]) {
    assert.equal(runtime.restoreWorkspace(document).ok, false);
    assert.strictEqual(runtime.state, state);
  }
});

test('imports reject lossy JSON, executable properties, oversized documents and history', () => {
  const runtime = app();
  const state = runtime.state;
  const document=():{format:string;journal:unknown[]}=>JSON.parse(JSON.stringify(runtime.exportWorkspace()));
  const cycle = document();
  cycle.journal.push(cycle);
  const sparse = document();
  sparse.journal.length = 1;
  const accessor = document();
  Object.defineProperty(accessor, 'format', {enumerable: true, get() { throw Error('must not execute'); }});
  const symbol = document();
  Object.defineProperty(symbol,Symbol('hidden'),{value:true});
  const many = document();
  many.journal = Array(501).fill({});
  const large = document();
  large.format = 'x'.repeat(2_000_001);
  const custom = document();
  custom.journal.push(new Date());
  for (const value of [cycle, sparse, accessor, symbol, many, large, custom]) {
    assert.equal(runtime.restoreWorkspace(value).ok, false);
    assert.strictEqual(runtime.state, state);
  }
});

test('history limit rejects new actions and rule edits without publishing partial changes', () => {
  const runtime = app();
  for (let index = 0; index < 500; index++) accepted(runtime.setRule('watch', {notify: []}));
  const state = runtime.state;
  const model = runtime.model;
  const document = runtime.exportWorkspace();
  assert.equal(runtime.explainAction('create', {title: 'Beyond history limit'}, 'u1').available, true,
    'Pre-execution availability deliberately does not promise execution resource capacity');
  rejectedWithoutChange(runtime, 'create', {title: 'Beyond history limit'});
  assert.equal(runtime.setRule('watch', {notify: ['opener']}).ok, false);
  assert.strictEqual(runtime.state, state);
  assert.strictEqual(runtime.model, model);
  assert.deepEqual(runtime.exportWorkspace(), document);
  const restored = createApp({workspace: document});
  assert.deepEqual(restored.model, model);
  assert.deepEqual(restored.exportWorkspace(), document);
});

test('large comment evidence is bounded before publication and accepted prefixes remain restorable', () => {
  const runtime = app();
  let rejected = false;
  for (let index = 0; index < 100; index++) {
    const state = runtime.state;
    const model = runtime.model;
    const document = runtime.exportWorkspace();
    const result = runtime.dispatch('comment', {issueId: 'i1', body: 'x'.repeat(5000)}, 'u1');
    if (!result.ok) {
      assert.match(result.reason, /materialized state is too large/);
      assert.strictEqual(runtime.state, state);
      assert.strictEqual(runtime.model, model);
      assert.deepEqual(runtime.exportWorkspace(), document);
      const restored = createApp({workspace: document});
      assert.deepEqual(restored.state, state);
      assert.deepEqual(restored.exportWorkspace(), document);
      rejected = true;
      break;
    }
  }
  assert.equal(rejected, true, 'must bound snapshot growth well before history limit');
});
