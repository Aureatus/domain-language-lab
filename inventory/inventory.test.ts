import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime,inventoryModel,initialState,invocation} from './model.ts';
import {createHost,competition,replay} from './host.ts';
import {inspectInventory} from './oracle.ts';
import {present} from '../semantic/test-support.ts';
const run=(host,command)=>host.step({type:'execute',invocation:command});
test('reserve is grouped, routed and conserved; cancel returns stock',()=>{
  const h=createHost();
  const r=run(h,invocation('reserveA','reserve'));
  assert.equal(r.status,'committed');assert.equal(present(present(h.state.records['stock'])['camera']).values['available'],2);
  assert.equal(present(present(h.state.records['reservation'])['slotA']).values['quantity'],3);
  assert.equal(present(present(h.state.records['reservation'])['slotA']).version,1);
  assert.equal(r.events.length,5);
  assert.deepEqual(r.events[0].recipients.map(r=>r.recipient),['bob','warehouse']);
  const cancelled=run(h,invocation('cancelA','cancel'));
  assert.equal(cancelled.status,'committed');assert.equal(present(present(h.state.records['stock'])['camera']).values['available'],5);assert.ok(h.oracle.ok);
  assert.equal(run(h,invocation('cancelAgain','cancel')).code,'precondition');
});
test('expiry boundary is inclusive; owner receives operator event with both supporting paths',()=>{
  const h=createHost();run(h,invocation('reserveA','reserve'));
  const before=h.state;
  assert.equal(run(h,invocation('early','expire','slotA','warehouse',29)).code,'precondition');assert.equal(h.state,before);
  const r=run(h,invocation('boundary','expire','slotA','warehouse',30));
  assert.equal(r.status,'committed');assert.ok(h.oracle.ok);
  assert.equal(r.events[0].recipients.find(r=>r.recipient==='alice').paths.length,2);
  assert.equal(present(present(h.state.records['reservation'])['slotA']).values['status'],'expired');
});
test('all ownership policies reject atomically, including expiration by owner',()=>{
  for(const kind of ['reserve','cancel','expire']) {
    const h=createHost();if(kind!=='reserve')run(h,invocation('seed','reserve'));
    const before=h.state,events=h.events.length;
    const r=run(h,invocation(`deny${kind}`,kind,'slotA',kind==='expire'?'alice':'bob',30));
    assert.equal(r.code,'denied');assert.equal(h.state,before);assert.deepEqual(r.events,[]);assert.equal(h.events.length,events);
  }
});
test('invalid quantities, clock, expiry, slot/stock pairing and capacity reject unchanged',()=>{
  const bad=[invocation('zero','reserve','slotA','alice',10,0),invocation('fraction','reserve','slotA','alice',10,1.5),invocation('full','reserve','slotA','alice',10,6),invocation('past','reserve','slotA','alice',30,1,30),invocation('clock','reserve','slotA','alice',-1),invocation('missing','reserve','unknown')];
  for(const inv of bad){const result=runtime.execute(initialState,inv);assert.equal(result.status,'rejected');assert.equal(result.state,initialState);assert.equal('events' in result,false);}
  const paired=structuredClone(initialState);present(present(paired.records['reservation'])['slotA']).values['stockId']='other';
  const pair=runtime.execute(paired,invocation('pair','reserve'));assert.equal(pair.status,'rejected');assert.equal(pair.code,'precondition');
});
test('late grouped failure and bad routing never partially publish',()=>{
  const overflow=structuredClone(initialState);present(present(overflow.records['reservation'])['slotA']).version=Number.MAX_SAFE_INTEGER;
  const r=runtime.execute(overflow,invocation('overflow','reserve'));assert.equal(r.status,'rejected');assert.equal(r.code,'overflow');assert.equal(r.state,overflow);assert.equal(present(present(overflow.records['stock'])['camera']).values['available'],5);
  const bad=structuredClone(initialState);present(present(bad.records['stock'])['camera']).values['watchers']=['not an id'];
  assert.equal(runtime.execute(bad,invocation('badRoute','reserve')).status,'rejected');assert.equal(bad.revision,0);
});
test('both competing commit orders reject stale; retry 3 rejects, retry 2 fits',()=>{
  for(const order of [['A','B'],['B','A']]) {
    const h=competition(false,order);
    assert.deepEqual(h.steps.map(s=>s.observation.code??s.observation.status),['prepared','prepared','committed','stale','precondition','committed']);
    assert.equal(present(present(h.state.records['stock'])['camera']).values['available'],0);assert.ok(h.oracle.ok);
    assert.deepEqual(replay(JSON.parse(JSON.stringify(h.export()))).export(),h.export());
  }
});
test('both mutant schedules actually lose accepted reservation and oversell; deterministic replay preserves failure',()=>{
  for(const order of [['A','B'],['B','A']]) {
    const h=competition(true,order);
    assert.equal(present(h.steps[3]).observation.status,'committed');assert.equal(h.state.revision,1);
    assert.equal(h.oracle.ok,false);assert.match(h.oracle.failures.join(' '),/oversold/);assert.match(h.oracle.failures.join(' '),/lost reservation/);
    // Snapshot-only conservation cannot expose the overwritten promise.
    const available=present(present(h.state.records['stock'])['camera']).values['available'];assert.ok(typeof available==='number');
    assert.equal(available+Object.values(present(h.state.records['reservation'])).filter(r=>r.values['status']==='active').reduce((n,r)=>{assert.ok(typeof r.values['quantity']==='number');return n+r.values['quantity'];},0),5);
    assert.deepEqual(replay(JSON.parse(JSON.stringify(h.export()))).oracle,h.oracle);
  }
});
test('JSON replay includes declarations; tampered observations fail closed',()=>{
  const b=competition().export();assert.deepEqual(b.model,inventoryModel);
  present(b.steps[0]).observation.status='committed';assert.throws(()=>replay(b),/mismatch/);
});
test('oracle independently detects bad stock and lost reservations',()=>{
  const bad=structuredClone(initialState);present(present(bad.records['stock'])['camera']).values['available']=4;
  assert.equal(inspectInventory(bad,[]).ok,false);
  assert.equal(inspectInventory(initialState,[invocation('promise','reserve')]).ok,false);
});
test('host snapshots declarations and initial state; duplicate IDs do not publish',()=>{
  const m=structuredClone(inventoryModel), s=structuredClone(initialState), h=createHost(m,s);
  m.id='edited';present(present(s.records['stock'])['camera']).values['available']=0;
  const command=invocation('unique','reserve');assert.equal(run(h,command).status,'committed');
  const before=h.state,count=h.events.length;
  assert.equal(run(h,command).reason,'duplicate-invocation');assert.equal(h.state,before);assert.equal(h.events.length,count);
  assert.equal(h.export().model.id,'inventory.v1');assert.equal(present(present(h.export().initial.records['stock'])['camera']).values['available'],5);
});
test('editing a declaration changes behavior in shared interpreter, not domain switches',()=>{
  const m=structuredClone(inventoryModel);
  present(present(m.actions['reservation.reserve']).policies[0]).when={op:'eq',left:{op:'actor'},right:{op:'literal',value:'bob'}};
  const h=createHost(m);
  assert.equal(run(h,invocation('aliceDenied','reserve')).code,'denied');
  assert.equal(run(h,invocation('bobAllowed','reserve','slotA','bob')).status,'committed');
});
