// Pure JSON transition model. Identity allocation, transport and storage are effects.
export function submissionWireBody(body,contractId){
  const json=JSON.stringify({...body,expectedContractId:contractId});
  let bytes=0;
  for(const c of json){const n=c.codePointAt(0);bytes+=n<128?1:n<2048?2:n<65536?3:4;}
  if(bytes>16384)throw Object.assign(Error('Submission is too large. Shorten the inputs before submitting.'),{notSubmitted:true});
  return json;
}
const allowed={
  editing:['submit'], submitting:['found','lost','invalid'], unknown:['check'],
  checking:['found','missing','lost'], retryable:['retry','check'], known:['submit']
};
export function submissionControls({phase}){
  return {submit:allowed[phase].includes('submit'),check:allowed[phase].includes('check'),retry:allowed[phase].includes('retry')};
}
export function submissionStep(state,event){
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
