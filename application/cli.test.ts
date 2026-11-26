import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,copyFile} from 'node:fs/promises';
import {createApplicationServer} from './server.ts';
import {createApplicationClient} from './client.ts';
import {deriveApplication} from './derive.ts';
import declaration from '../leave/model.ts';
import {present} from '../semantic/test-support.ts';
const exec=promisify(execFile);
export async function cli(url:string,...args:string[]){
  const {stdout}=await exec(process.execPath,['application/cli.ts','--view','leave/cli.domain',...args,'--url',url,'--json']);return JSON.parse(stdout);
}
test('spawned CLI advances the same durable HTTP backend; grant/resume, duplicates, stale and reopen',async()=>{
  const directory=await mkdtemp('/tmp/opencode/cli-');let server=await createApplicationServer(declaration,{directory});
  const args=JSON.stringify({start:'2026-11-23',end:'2026-11-25'});
  try{
    const list=await cli(server.url,'list');assert.ok(list.some((a:{id:string})=>a.id==='leave.request'));
    assert.deepEqual(list.find((a:{id:string})=>a.id==='leave.request').arguments.map((a:{name:string})=>a.name),['start','end']);
    const action=await cli(server.url,'inspect','leave.request');assert.equal(action.fields.find((f:{name:string})=>f.name==='days').hidden,true);
    const sources=await mkdtemp('/tmp/opencode/cli-views-');
    for(const name of ['time-away','demo','cli'])await copyFile(`leave/${name}.domain`,`${sources}/${name}.domain`);
    const domain=await readFile(`${sources}/time-away.domain`,'utf8');
    await writeFile(`${sources}/time-away.domain`,domain.replace('employee.balance - days','employee.balance + days'));
    await assert.rejects(exec(process.execPath,['application/cli.ts','execute','leave.request','--actor','maya','--args',args,'--url',server.url,'--view',`${sources}/cli.domain`]),/domain differs from the backend/);
    assert.equal((await cli(server.url,'inbox')).length,0);
    await assert.rejects(cli(server.url,'execute','leave.request','--args',args),/explicit --actor/);
    assert.equal((await cli(server.url,'preview','leave.request','--actor','maya','--args',args)).status,'pending');
    assert.equal((await cli(server.url,'execute','leave.request','--actor','maya','--args',args)).status,'pending');
    let [p]=await cli(server.url,'inbox','--actor','sam');assert.equal(p.invocation.actor,'maya');
    assert.equal((await cli(server.url,'grant',p.id,'--actor','sam','--policy',p.requirements[0].policyId)).status,'approved');
    const client=createApplicationClient(server.url);await client.contract();
    const balance=async()=>present(present((await client.snapshot()).state.records['employee'])['maya']).values['balance'];
    assert.equal(await balance(),5);
    assert.equal((await cli(server.url,'resume',p.id,'--actor','sam')).status,'committed');
    assert.equal(await balance(),2);
    assert.equal((await cli(server.url,'resume',p.id,'--actor','sam')).code,'consumed');
    await cli(server.url,'execute','leave.request','--actor','leo','--args',args);
    p=(await cli(server.url,'inbox','--actor','leo')).find((p:{status:string})=>p.status==='pending');
    await cli(server.url,'grant',p.id,'--actor','sam','--policy',p.requirements[0].policyId);
    assert.equal((await cli(server.url,'execute','settings.change','--actor','sam','--args','{"threshold":2}')).status,'committed');
    assert.equal((await cli(server.url,'resume',p.id,'--actor','sam')).code,'stale');
    assert.equal((await cli(server.url,'list','employee')).leo.values.balance,5);
    await server.close();server=await createApplicationServer(declaration,{directory});
    assert.equal((await cli(server.url,'list','employee')).maya.values.balance,2);
    assert.equal((await cli(server.url,'inbox','--actor','leo')).find((x:{id:string})=>x.id===p.id).grants.length,1);
  }finally{await server.close();}
});
test('shared client fails closed on contract mismatch',async()=>{
  const {contract}=deriveApplication(declaration);
  let calls=0;const client=createApplicationClient('http://127.0.0.1:1',{fetch:async()=>Response.json({contractId:++calls===1?'a':'b',contract})});
  await client.contract();await assert.rejects(client.snapshot(),/contract changed/);
});
