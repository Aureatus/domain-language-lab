import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import declaration from '../leave/model.ts';
import {createApplicationServer} from './server.ts';
import {acceptsSnapshot} from './snapshot.ts';

test('delayed snapshots cannot undo pending/grant updates, including across reopen',async()=>{
  const directory=await mkdtemp('/tmp/opencode/snapshot-order-');
  let server=await createApplicationServer(declaration,{directory});
  const snapshot=async()=>await(await fetch(`${server.url}/api/snapshot`)).json();
  const post=async(path:string,body:object)=>await(await fetch(`${server.url}/api/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
  try{
    const before=await snapshot();
    const pending=await post('actions/execute',{actor:'maya',action:'leave.request',args:{start:'2026-11-23',end:'2026-11-25'}});
    assert.equal(pending.status,'pending');
    const saved=pending.snapshot,request=saved.pending[0];
    const grant=await post('approvals/grant',{actor:'sam',requestId:request.id,policyId:request.requirements[0].policyId});
    assert.equal(grant.status,'approved');
    const latest=grant.snapshot;
    assert.equal(before.state.revision,latest.state.revision);
    assert.ok(saved.snapshotVersion>before.snapshotVersion);
    assert.ok(latest.snapshotVersion>saved.snapshotVersion);
    assert.equal(acceptsSnapshot(latest,saved,latest.contractId),false);
    assert.equal(acceptsSnapshot(latest,before,latest.contractId),false);
    assert.equal(acceptsSnapshot(saved,latest,latest.contractId),true);
    await server.close();server=await createApplicationServer(declaration,{directory});
    const reopened=await snapshot();
    assert.equal(reopened.snapshotVersion,latest.snapshotVersion);
    assert.equal(acceptsSnapshot(latest,reopened,latest.contractId),true);
    assert.equal(acceptsSnapshot(latest,{...latest,snapshotVersion:undefined},latest.contractId),false);
  }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});
