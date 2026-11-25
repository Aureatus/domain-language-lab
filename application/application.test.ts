import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {encodeJson} from '../adapters/effect/json.ts';
import {deriveApplication,buildInvocation} from './derive.ts';
import {createApplicationServer} from './server.ts';
import {fixture,renamedFixture,extendedFixture} from './fixture.ts';
import leave from '../leave/model.ts';
import {present} from '../semantic/test-support.ts';

test('leave contract retains the published submission identity',()=>{
  const {model,contract}=deriveApplication(leave);
  assert.equal(createHash('sha256').update(encodeJson({model,contract})).digest('hex'),
    '136de0f000fc5aed5febb25583ca25c9ecdacb562bd42b50b54124f2c92d4144');
});

test('automatic input types, inferred references, added actions/inputs and policy changes alter contract',()=>{
  const {contract}=deriveApplication(fixture),a=present(contract.actions['supply.take']);
  assert.deepEqual(a.fields.map(f=>[f.name,f.widget]),[['cabinetKey','select'],['quantity','number'],['reason','select'],['tracked','checkbox']]);
  assert.equal(present(a.fields[0]).reference?.resource,'cabinet');
  const {actions: _actions,...inferredMeta}=fixture.application;
  const inferred={...structuredClone(fixture),application:inferredMeta};
  assert.deepEqual(present(present(deriveApplication(inferred).contract.actions['supply.take']).fields[0]).reference,{resource:'cabinet'});
  const changed=structuredClone(fixture);
  present(changed.domain.actions['supply.take']).inputs['memo']={type:'string'};
  const review=present(present(changed.domain.actions['supply.take']).policies[1]);
  assert.equal(review.effect,'approval-required');review.approvers={op:'literal',value:'nora'};
  changed.domain.actions['supply.audit']={inputs:{comment:{type:'string'}},bindings:[],policies:[{id:'audit.allow',effect:'allow',when:{op:'literal',value:true}}],preconditions:[],updates:[],inserts:[],deletes:[],observe:[]};
  const derived=deriveApplication(changed);
  assert.ok(present(derived.contract.actions['supply.take']).fields.some(f=>f.name==='memo'));
  assert.equal(present(present(derived.contract.actions['supply.audit']).fields[0]).label,'Comment');
  const inv=buildInvocation(derived.contract,{action:'supply.take',actor:'quinn',args:{cabinetKey:'tools',quantity:2,reason:'Repair',tracked:true,memo:'Test'},id:'i',clock:1});
  const result=derived.runtime.prepare(derived.initialState,inv);
  assert.equal(result.status,'pending');assert.deepEqual(present(result.request.requirements[0]).approvers,['nora']);
});
test('hidden actor/id/clock/constant mappings are host-owned, not client defaults or overrides',()=>{
  const x=structuredClone(fixture),a=present(x.domain.actions['supply.take']);
  Object.assign(a.inputs,{operator:{type:'string'},nonce:{type:'string'},stamp:{type:'integer',min:0},origin:{type:'string',enum:['host']}});
  Object.assign(x.application.actions['supply.take'].fields,{operator:{binding:{source:'actor'}},nonce:{binding:{source:'operation-id'}},stamp:{binding:{source:'clock'}},origin:{binding:{source:'constant',value:'host'}}});
  const {contract}=deriveApplication(x),args={cabinetKey:'tools',quantity:1,reason:'Repair',tracked:true};
  const i=buildInvocation(contract,{action:'supply.take',actor:'nora',id:'command-one',clock:42,args});
  assert.deepEqual(i.args,{...args,operator:'nora',nonce:'command-one',stamp:42,origin:'host'});
  assert.ok(present(contract.actions['supply.take']).fields.filter(f=>['operator','nonce','stamp','origin'].includes(f.name)).every(f=>f.hidden));
  assert.throws(()=>buildInvocation(contract,{action:'supply.take',actor:'nora',id:'command-two',clock:42,args:{...args,stamp:0}}));
});
test('all matching approval policies must be granted; inbox records actual requirements and grants',async()=>{
  const x=extendedFixture();
  present(x.domain.actions['supply.take']).policies.push({id:'supply.second-review',effect:'approval-required',when:{op:'literal',value:true},approvers:{op:'literal',value:'quinn'}});
  const server=await createApplicationServer(x,{directory:await mkdtemp('/tmp/opencode/multiple-approvals-')});
  const post=async(path,body)=>{const r=await fetch(`${server.url}/api/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
  try{
    let r=await post('actions/execute',{actor:'nora',action:'supply.take',args:{cabinetKey:'tools',quantity:2,reason:'Repair',tracked:false,memo:'Both policies'}});
    const p=r.snapshot.pending[0];assert.deepEqual(p.requirements.map(r=>r.approvers),[['rory'],['quinn']]);
    await post('approvals/grant',{actor:'rory',requestId:p.id,policyId:p.requirements[0].policyId});
    r=await post('approvals/resume',{actor:'rory',requestId:p.id});assert.equal(r.status,'rejected');assert.equal(r.snapshot.state.records.cabinet.tools.values.stock,8);
    r=await post('approvals/grant',{actor:'quinn',requestId:p.id,policyId:p.requirements[1].policyId});assert.equal(r.snapshot.pending[0].grants.length,2);
    r=await post('approvals/resume',{actor:'quinn',requestId:p.id});assert.equal(r.status,'committed');assert.equal(r.snapshot.state.records.cabinet.tools.values.stock,6);
  }finally{await server.close();}
});
test('invalid/unsupported presentation, references, bindings, adapters fail at startup',()=>{
  const mutations=[
    x=>x.application.actions.unknown={},
    x=>x.application.actions['leave.request'].fields.typo={},
    x=>x.application.actions['leave.request'].fields.start.widget='html',
    x=>x.application.actions['leave.request'].fields.start.template='<h1>custom</h1>',
    x=>x.application.actions['leave.request'].fields.employeeId.binding.source='javascript',
    x=>x.application.actions['leave.request'].adapters[0].name='unknown/v1',
    x=>x.application.actions['leave.request'].adapters[0].mapping.output='typo',
    x=>x.application.actions['settings.change'].fields.threshold.default.field='typo',
    x=>x.application.views[0].fields[0].field='typo',
    x=>x.application.views[0].resource='unknown',
    x=>x.application.actors.push(x.application.actors[0]),
    x=>x.application.actions['leave.request'].fields.start.reference={resource:'employee',labelField:'typo'},
    x=>x.application.actions['settings.change'].fields.threshold.default='not a number',
    x=>x.application.actions['settings.change'].fields.threshold.binding={source:'actor'},
    x=>x.application.views[2].columns[1].format='eval',
    x=>x.application.actions['leave.request'].fields.employeeId.binding=null,
    x=>x.application.actions=[],
    x=>x.handler='not supported',
    x=>x.application.actions['leave.request'].fields.employeeId.default='maya',
    x=>x.application.actions.toString={},
    x=>x.application.actions['leave.request']=null,
    x=>x.application.actions['leave.request'].fields.start=null,
    x=>x.application.actions['leave.request'].adapters=null,
    x=>x.application.views=null,
  ];
  for(const mutate of mutations){const x=structuredClone(leave);mutate(x);assert.throws(()=>deriveApplication(x));}
});
for(const [name,declaration,action,actor,approver,args,resource,record,stock,policy] of [
  ['non-leave',fixture,'supply.take','nora','quinn',{cabinetKey:'tools',quantity:2,reason:'Repair',tracked:true},'cabinet','tools','stock','supply.review'],
  ['systematically renamed',renamedFixture(),'kit.issue','ari','devon',{rackId:'parts',units:2,purpose:'Repair',logged:true},'rack','parts','remaining','kit.authorization'],
])test(`${name}: same contract drives generic route, pending requirements, grant/resume, projections`,async()=>{
  const server=await createApplicationServer(declaration,{directory:await mkdtemp('/tmp/opencode/application-test-')});
  const post=async(path,body)=>{const response=await fetch(`${server.url}/api/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
  try{
    const {contractId,contract}=await(await fetch(`${server.url}/api/contract`)).json();assert.deepEqual(contract,deriveApplication(declaration).contract);
    let r=await post('actions/preview',{actor,action,args});assert.equal(r.status,'pending');assert.deepEqual(r.requirements,[{policyId:policy,approvers:[approver],allowSelfApproval:false}]);
    r=await post('actions/execute',{actor,action,args});assert.equal(r.contractId,contractId);const p=r.snapshot.pending[0];assert.equal(r.snapshot.state.records[resource][record].values[stock],8);
    assert.equal((await post('approvals/grant',{actor,requestId:p.id,policyId:policy})).code,'unauthorized-approval');
    r=await post('approvals/grant',{actor:approver,requestId:p.id,policyId:policy});assert.equal(r.status,'approved');assert.equal(r.snapshot.state.records[resource][record].values[stock],8);
    r=await post('approvals/resume',{actor:approver,requestId:p.id});assert.equal(r.status,'committed');assert.equal(r.snapshot.state.records[resource][record].values[stock],6);
    assert.equal((await post('approvals/resume',{actor:approver,requestId:p.id})).code,'consumed');
  }finally{await server.close();}
});
