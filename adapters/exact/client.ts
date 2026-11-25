import {submissionStep,submissionControls,submissionWireBody,isNotSubmittedError} from './submission.ts';
import type {SubmissionEvent,SubmissionState} from '../../application/submission.ts';
import type {State} from '../../semantic/v2/types.ts';
// Each generated actor/action form owns one driver for the mounted app.
// The driver keeps the submitted body independently of polled defaults.
export function submissionDriver(client,actor,action){
  let state: SubmissionState={phase:'editing'};
  const step=(event: SubmissionEvent)=>{state=submissionStep(state,event);};
  const reply=()=>({phase:state.phase,message:state.phase==='known'?state.result?.message:
    state.phase==='retryable'?'Submission not found. Retry the original submission.':
    state.phase==='unknown'?'Submission has an ambiguous outcome. Check submission before retrying.':'Submission in progress.'});
  async function run(type,args){
    // Guard the effect even if the host delivers a stale press.
    if(!submissionControls(state)[type])return reply();
    if(type==='submit'){
      let id;
      try{id=crypto.randomUUID();}
      catch{return {phase:state.phase,message:'Could not allocate a submission ID. Nothing was sent.'};}
      step({type,id,body:{actor,action,args}});
    }else step({type});
    try{
      const result=type==='check'?await client.request('actions/reconcile',{actor,submissionId:state.id}):
        await client.request('actions/execute',{...state.body,submissionId:state.id});
      step(type==='check'&&result.status==='not-found'?{type:'missing'}:{type:'found',result});
    }catch(e){
      if(type!=='check'&&isNotSubmittedError(e)){
        step({type:'invalid',message:e.message});
        return {phase:state.phase,message:e.message};
      }
      step({type:'lost'});
    }
    return reply();
  }
  return {run};
}

// Renderer transport/projection only. All decisions and mutations belong to HTTP.
export function createClient({contract,contractId},base,fetcher=fetch){
  let latest=-1,cached;
  async function request(path,body?){
    const wire=body?.submissionId?submissionWireBody(body,contractId):JSON.stringify(body);
    const response=await fetcher(`${base}/api/${path}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:wire});
    const result=await response.json();
    if(!response.ok){
      const error=Error(result.error??`HTTP ${response.status}`);
      const notSubmitted=path==='actions/execute'&&response.status===400&&
        result.disposition==='not-submitted'&&result.contractId===contractId&&
        typeof body?.submissionId==='string'&&result.submissionId===body.submissionId&&typeof result.error==='string';
      throw Object.assign(error,{notSubmitted});
    }
    if(result.contractId!==contractId)throw Error('Declaration changed. Regenerate this Exact adapter.');
    if(body?.submissionId&&result.submissionId!==body.submissionId)throw Error('Submission receipt identity mismatch.');
    if(path==='actions/reconcile'&&result.message)return {...result,message:`Original submission outcome: ${result.message}`};
    return result;
  }
  async function snapshot(){const s=await request('snapshot');if(!Number.isSafeInteger(s.snapshotVersion))throw Error('Unsupported snapshot version.');if(s.snapshotVersion>=latest){cached=s;latest=s.snapshotVersion;}return cached;}
  const person=id=>contract.actors.find(a=>a.id===id)?.name??contract.actors.find(a=>a.id===id)?.label??id;
  const text=x=>Array.isArray(x)?x.join(', '):String(x??'');
  function project(s,actor){
    const rows: {id:string;title:string;detail:string}[]=[];
    const records: State['records']=s.state.records;
    contract.views.forEach((v,i)=>{const collection=records[v.resource];if(!collection)throw Error(`Missing view resource: ${v.resource}`);for(const [id,r]of Object.entries(collection)){
      if(v.key&&id!==(v.key==='$actor'?actor:v.key)||v.ownerField&&r.values[v.ownerField]!==actor)continue;
      rows.push({id:`view:${i}:${id}`,title:v.label,detail:v.columns.map(c=>{const value=r.values[c.field];return `${c.label}: ${contract.relationships.some(r=>r.resource===v.resource&&r.field===c.field)?Array.isArray(value)?value.map(person).join(', '):person(value):text(value)}`;}).join(' · ')});
    }});
    const inbox=s.pending.filter(p=>p.status==='pending'&&(p.invocation.actor===actor||p.requirements.some(r=>r.approvers.includes(actor)))).map(p=>({
      id:p.id,title:`${person(p.invocation.actor)} · ${contract.actions[p.invocation.action].label}`,
      detail:`${p.stale?'Stale. Send a new request. ':''}${contract.actions[p.invocation.action].fields.filter(f=>!f.binding).map(f=>`${f.label}: ${text(p.invocation.args[f.name])}`).join(' · ')}`,
      grants:p.requirements.map(r=>({id:r.policyId,label:p.grants.some(g=>g.policyId===r.policyId)?'Approval saved':`Approval: ${r.approvers.map(person).join(', ')}`,eligible:r.approvers.includes(actor)&&!p.grants.some(g=>g.policyId===r.policyId)})),
      complete:p.requirements.every(r=>p.grants.some(g=>g.policyId===r.policyId))
    }));
    return {owner:actor,rows,inbox};
  }
  async function command(path,body){
    try{const r=await request(path,body);return {ok:r.status!=='rejected',message:path==='approvals/resume'&&r.status==='rejected'?`Approval is saved, but completion failed. ${r.message}`:r.message};}
    catch(e){return {ok:false,message:`${path==='approvals/resume'?'Approval may be saved, but completion failed. ':''}${(e instanceof Error?e.message:String(e))} Reconnect and inspect saved state before retrying; an HTTP failure can have an ambiguous outcome.`};}
  }
  return {request,snapshot,project,command};
}
