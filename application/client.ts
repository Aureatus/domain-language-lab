// Shared, renderer-independent HTTP client. No domain rules or local execution.
import {submissionWireBody} from './submission.ts';
export function createApplicationClient(url,{fetch:transport=globalThis.fetch}={}){
  const base=new URL(url);let contractId;
  async function request(path,body){
    const wire=body?.submissionId?submissionWireBody(body,contractId):JSON.stringify(body);
    const response=await transport(new URL(path,base),body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:wire});
    const value=await response.json();
    if(!response.ok){
      const error=Error(value.error??`HTTP ${response.status}`);
      if(path==='/api/actions/execute'&&response.status===400&&contractId&&value.contractId===contractId&&body?.submissionId&&value.submissionId===body.submissionId&&value.disposition==='not-submitted')error.notSubmitted=true;
      throw error;
    }
    if(contractId&&value.contractId!==contractId)throw Error('Application contract changed; reconnect before continuing.');
    if(body?.submissionId&&value.submissionId!==body.submissionId)throw Error('Submission receipt identity mismatch.');
    if(path==='/api/actions/reconcile'&&value.message)return {...value,message:`Original submission outcome: ${value.message}`};
    return value;
  }
  return {
    async contract(){const value=await request('/api/contract');contractId=value.contractId;return value;},
    snapshot:()=>request('/api/snapshot'),
    preview:body=>request('/api/actions/preview',body),
    execute:body=>request('/api/actions/execute',body),
    reconcile:body=>request('/api/actions/reconcile',body),
    grant:body=>request('/api/approvals/grant',body),
    resume:body=>request('/api/approvals/resume',body)
  };
}

// Display projection only; server/core always authorize grants/resumptions.
export const inboxFor=(snapshot,actor)=>snapshot.pending.filter(p=>!actor||p.invocation.actor===actor||p.requirements.some(r=>r.approvers.includes(actor)));
