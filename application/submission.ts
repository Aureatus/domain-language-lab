// Pure JSON transition model. Identity allocation, transport and storage are effects.
export interface SubmissionBody {actor:string;action:string;args:Record<string,unknown>}
export function isNotSubmittedError(value:unknown):value is Error&{notSubmitted:true}{
  return value instanceof Error&&'notSubmitted' in value&&value.notSubmitted===true;
}
export interface SubmissionReceipt {status:string;message?:string}
export type SubmissionPhase='editing'|'submitting'|'unknown'|'checking'|'retryable'|'known';
export type SubmissionState<R extends SubmissionReceipt=SubmissionReceipt> = {
  phase:SubmissionPhase;id?:string;body?:SubmissionBody;result?:R;message?:string;
};
export type SubmissionEvent<R extends SubmissionReceipt=SubmissionReceipt> =
  | {type:'submit';id:string;body:SubmissionBody}
  | {type:'found';result:R}
  | {type:'invalid';message:string}
  | {type:'lost'|'check'|'missing'|'retry'};

export function submissionWireBody(body:object,contractId:string|undefined,encode:(value:object)=>string=JSON.stringify){
  const json=encode({...body,expectedContractId:contractId});
  let bytes=0;
  for(const c of json){const n=c.charCodeAt(0);bytes+=c.length===2?4:n<128?1:n<2048?2:3;}
  if(bytes>16384)throw Object.assign(Error('Submission is too large. Shorten the inputs before submitting.'),{notSubmitted:true});
  return json;
}
const allowed:Record<SubmissionPhase,readonly SubmissionEvent['type'][]>={
  editing:['submit'], submitting:['found','lost','invalid'], unknown:['check'],
  checking:['found','missing','lost'], retryable:['retry','check'], known:['submit']
};
export function submissionControls({phase}:Pick<SubmissionState,'phase'>){
  return {submit:allowed[phase].includes('submit'),check:allowed[phase].includes('check'),retry:allowed[phase].includes('retry')};
}
export function submissionStep<R extends SubmissionReceipt>(state:SubmissionState<R>,event:SubmissionEvent<R>):SubmissionState<R>{
  if(!Object.hasOwn(allowed,state.phase)||!allowed[state.phase].includes(event.type))
    throw Error(`Invalid submission transition: ${state.phase} → ${event.type}`);
  switch(event.type){
    case 'submit':
      if(!event.id||!event.body?.actor||!event.body.action||!event.body.args)throw Error('Missing submission identity or command.');
      return {phase:'submitting',id:event.id,body:JSON.parse(JSON.stringify(event.body))};
    case 'lost':return {...state,phase:'unknown'};
    case 'invalid':return {phase:'editing',message:event.message};
    case 'check':return {...state,phase:'checking'};
    case 'missing':return {...state,phase:'retryable'};
    case 'retry':return {...state,phase:'submitting'};
    case 'found':
      if(!['pending','committed','rejected'].includes(event.result?.status))throw Error('Invalid execution receipt.');
      return {...state,phase:'known',result:event.result};
  }
}
