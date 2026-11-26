// Shared, renderer-independent HTTP client. No domain rules or local execution.
import {ApplicationReceiptSchema,ApplicationSnapshotSchema,decodeJson,decodeJsonObject,decodeValue,encodeJson,isApplicationContract} from '../adapters/effect/json.ts';
import {submissionWireBody} from './submission.ts';
import type {SubmissionBody,SubmissionReceipt} from './submission.ts';
import type {ApplicationContract} from './derive.ts';
import type {ApprovalRequest, Grant, State, Value} from '../semantic/v2/types.ts';

type PendingEntry={
  id:string;status:'pending'|'consumed';invocation:ApprovalRequest['invocation'];requirements:ApprovalRequest['requirements'];
  grants:readonly Grant[];stale:boolean;
};
export type ApplicationSnapshot={
  contractId:string;snapshotVersion:number;state:State;pending:readonly PendingEntry[];
  defaults:Record<string,Record<string,Record<string,Value|undefined>>>;availability:Record<string,Record<string,boolean>>;
};
export type ApplicationReceipt=SubmissionReceipt&{
  contractId:string;submissionId?:string;code?:string;args?:unknown;requirements?:ApprovalRequest['requirements'];
  evidence?:{phase:string;invocation:{id:string;actor:string;action:string;args:unknown};outcome:{status:string}};
  snapshot?:ApplicationSnapshot;
};
type ExecuteBody=SubmissionBody&{submissionId?:string};
type ReconcileBody={actor:string;submissionId:string};
type ResumeBody={actor:string;requestId:string};
type GrantBody=ResumeBody&{policyId:string};
type RequestBody=ExecuteBody|ReconcileBody|GrantBody|ResumeBody;

export function decodeApplicationSnapshot(text:unknown):ApplicationSnapshot{
  return decodeJson(ApplicationSnapshotSchema,text);
}

export function createApplicationClient(url: string | URL,{fetch:transport=globalThis.fetch}={}){
  const base=new URL(url);let contractId:string|undefined;
  async function request(path: string,body?:RequestBody){
    const submissionId=body&&'submissionId' in body?body.submissionId:undefined;
    let init:RequestInit={};
    if(body!==undefined){
      try{
        const wire=submissionId?submissionWireBody(body,contractId,encodeJson):encodeJson(body);
        init={method:'POST',headers:{'content-type':'application/json'},body:wire};
      }
      catch(error){if(path==='/api/actions/execute'&&error instanceof Error)Object.assign(error,{notSubmitted:true});throw error;}
    }
    const response=await transport(new URL(path,base),init);
    const value=decodeJsonObject(await response.text());
    if(!response.ok){
      const error=Error(typeof value['error']==='string'?value['error']:`HTTP ${response.status}`);
      if(path==='/api/actions/execute'&&response.status===400&&contractId&&value['contractId']===contractId&&submissionId&&value['submissionId']===submissionId&&value['disposition']==='not-submitted')Object.assign(error,{notSubmitted:true});
      throw error;
    }
    if(contractId&&value['contractId']!==contractId)throw Error('Application contract changed; reconnect before continuing.');
    if(submissionId&&value['submissionId']!==submissionId)throw Error('Submission receipt identity mismatch.');
    if(path==='/api/actions/reconcile'&&value['message'])return {...value,message:`Original submission outcome: ${value['message']}`};
    return value;
  }
  async function receipt(path:string,body:RequestBody):Promise<ApplicationReceipt>{
    const value=await request(path,body);
    if(typeof value['contractId']!=='string'||typeof value['status']!=='string')throw Error('Invalid application receipt.');
    return decodeValue(ApplicationReceiptSchema)(value);
  }
  return {
    async contract(): Promise<{contract:ApplicationContract;contractId:string}>{
      const value=await request('/api/contract');
      const contract=value['contract'];
      if(typeof value['contractId']!=='string'||!isApplicationContract(contract))throw Error('Invalid application contract.');
      contractId=value['contractId'];return {contractId,contract};
    },
    snapshot:async():Promise<ApplicationSnapshot>=>decodeValue(ApplicationSnapshotSchema)(await request('/api/snapshot')),
    preview:(body:SubmissionBody):Promise<ApplicationReceipt>=>receipt('/api/actions/preview',body),
    execute:(body:ExecuteBody):Promise<ApplicationReceipt>=>receipt('/api/actions/execute',body),
    reconcile:(body:ReconcileBody):Promise<ApplicationReceipt>=>receipt('/api/actions/reconcile',body),
    grant:(body:GrantBody):Promise<ApplicationReceipt>=>receipt('/api/approvals/grant',body),
    resume:(body:ResumeBody):Promise<ApplicationReceipt>=>receipt('/api/approvals/resume',body)
  };
}

// Display projection only; server/core always authorize grants/resumptions.
export const inboxFor=(snapshot:Pick<ApplicationSnapshot,'pending'>,actor?:string)=>snapshot.pending.filter(p=>!actor||p.invocation.actor===actor||p.requirements.some(r=>r.approvers.includes(actor)));
