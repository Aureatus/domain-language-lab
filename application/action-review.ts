import {submissionStep,submissionControls} from './submission.ts';
import {loadingPlan,loadingPresentation} from './loading.ts';
import {viewRecords} from './view-records.ts';
import {inboxFor} from './client.ts';
import {acceptsSnapshot} from './snapshot.ts';
import {buildInvocation,inputDefaults} from './derive.ts';

// Finite search for a useful *example*, never a claim that approval is unreachable.
export function exampleArgs({runtime,contract,initialState},action,actor){
  const defaults=inputDefaults(contract,action,initialState,actor),inputs=[defaults];
  for(const f of contract.actions[action].fields.filter(f=>!f.hidden)){
    const x=defaults[f.name];let choices=f.schema.enum??[];
    if(f.widget==='date'&&Number.isFinite(Date.parse(x)))choices=Array.from({length:10},(_,i)=>new Date(Date.parse(x)+(i+1)*86400000).toISOString().slice(0,10));
    if(f.schema.type==='integer')choices=[...Array.from({length:10},(_,i)=>(x??0)+i+1),f.schema.max].filter(Number.isSafeInteger);
    if(f.schema.type==='boolean')choices=[!x];
    for(const value of choices)inputs.push({...defaults,[f.name]:value});
  }
  for(const args of inputs){
    let invocation;try{invocation=buildInvocation(contract,{action,actor,args,id:'review-preview',clock:0});}catch{continue;}
    if(runtime.prepare(initialState,invocation).status==='pending')return {args,selection:'bounded preview found approval-required inputs'};
  }
  return {args:defaults,selection:'declared defaults; bounded preview did not find an approval example'};
}

// Fold only what the viewer has observed. In particular, a snapshot never
// supplies a transport receipt for this submission.
export function actionReview(contract,actor,action,{mutant}: {mutant?: string}={}){
  if(mutant!==undefined&&mutant!=='snapshot-unlocks')throw Error('Unknown review mutant.');
  const forms=new Map();
  function formFor(owner){
    if(!forms.has(owner))forms.set(owner,{submission:{phase:'editing'},receipt:null,evidence:null});
    return forms.get(owner);
  }
  let viewer=actor,snapshot,refreshPending=false,number=0;
  const regions=loadingPlan(contract);
  return event=>{
    const {type,result}=event;
    if(!['open','switch','refresh-start','refresh-end','draft','submit','lost','check','receipt','grant','complete','snapshot','invalid','unavailable','blocked'].includes(type))throw Error('Unknown review event.');
    if(type==='switch'){
      if(!contract.actors.some(a=>a.id===event.actor))throw Error('Unknown review viewer.');
      viewer=event.actor;
    }
    const visible=formFor(viewer);
    const outcome=['receipt','grant','complete'].includes(type);
    const form=outcome?forms.get(result?.evidence?.invocation?.actor):visible;
    if(type==='draft'&&(event.body?.actor!==viewer||event.body?.action!==action||!event.id))throw Error('Draft selection mismatch.');
    if(outcome){
      const inv=result?.evidence?.invocation,phase={receipt:'execute',grant:'grant',complete:'resume'}[type];
      if(!form||result?.evidence?.phase!==phase||result.status!==result.evidence.outcome?.status||inv?.action!==action||
          (type!=='receipt'&&(!form.receipt||inv.id!==form.receipt.invocationId)))throw Error('Outcome evidence does not match selected command.');
      if(type==='grant'&&!result.snapshot?.pending.find(p=>p.id===inv.id)?.requirements.some(r=>r.policyId===event.policyId&&r.approvers.includes(event.actor)))throw Error('Grant requirement mismatch.');
    }
    if(type==='draft'){form.body=event.body;form.id=event.id;}
    if(type==='submit'){
      form.submission=submissionStep(form.submission,{type,id:form.id,body:form.body});
      form.receipt=null;form.evidence=null;
    }
    if(['lost','check','invalid'].includes(type))form.submission=submissionStep(form.submission,event);
    if(type==='receipt'){
      const id=form.submission.id;
      if(!id||result.submissionId!==id)throw Error('Unexpected submission receipt.');
      const receipt={submissionId:id,invocationId:result.evidence.invocation.id,status:result.status,code:result.code??null};
      form.submission=submissionStep(form.submission,{type:'found',result:receipt});
      form.receipt=receipt;
    }
    if(outcome)form.evidence={phase:result.evidence.phase,status:result.status,invocationId:result.evidence.invocation.id};
    // Do not apply an inactive form's transport snapshot to the current viewer.
    const next=form===visible?(event.snapshot??(type==='grant'?null:result?.snapshot)):null;
    if(next&&acceptsSnapshot(snapshot,next,snapshot?.contractId??next.contractId)){
      snapshot=next;
      // Negative control for conformance tests ONLY; snapshots are not receipts.
      if(mutant==='snapshot-unlocks'&&type==='snapshot'&&visible.submission.phase==='unknown')visible.submission={phase:'editing'};
    }
    if(type==='refresh-start')refreshPending=true;
    if(type==='refresh-end')refreshPending=false;
    const {submission,receipt,body,evidence}=visible;
    const loaded=!!snapshot,controls=submissionControls(submission);
    controls.submit&&=loaded&&!!snapshot.availability[viewer][action]&&!!body;
    return {step:++number,event:type,viewer,performedBy:event.actor??null,policyId:event.policyId??null,message:event.message??null,source:type==='grant'?'runner observed approver response':next||result||type==='invalid'?'recorded backend':'simulated interaction',
      submission:submission.phase,draft:body?.args??null,controls,receipt,evidence,
      snapshotVersion:snapshot?.snapshotVersion??null,
      views:regions.map(({index,label,strategy})=>{const view=contract.views[index];return {label,...loadingPresentation(strategy,{owned:loaded,pending:!loaded||refreshPending,failed:false}),records:loaded?viewRecords(snapshot,view,viewer).map(([id,r])=>({id,fields:Object.fromEntries(view.columns.map(c=>[c.field,r.values[c.field]]))})):[]};}),
      inbox:loaded?inboxFor(snapshot,viewer).filter(p=>p.status==='pending').map(p=>({id:p.id,requester:p.invocation.actor,requirements:p.requirements,grants:p.grants})):[]};
  };
}
