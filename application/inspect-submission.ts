import {submissionStep,submissionControls} from './submission.ts';
import type {SubmissionEvent,SubmissionState} from './submission.ts';
import {loadSource} from '../syntax/load.ts';
import {deriveApplication,inputDefaults} from './derive.ts';
import {readFileSync} from 'node:fs';
import {decodeJson,encodeJsonPretty,SubmissionTraceSchema} from '../adapters/effect/json.ts';
const [entry='leave/browser.domain',actionId,actorId,tracePath]=process.argv.slice(2);
const {contract,initialState}=deriveApplication(loadSource(entry).declaration);
const action=actionId??Object.keys(contract.actions)[0],actor=actorId??contract.actors[0]?.id;
if(!action||!actor||!contract.actions[action]||!contract.actors.some(a=>a.id===actor))throw Error('Unknown action or actor.');
const body={actor,action,args:inputDefaults(contract,action,initialState,actor)};
function traceEvent(event:(typeof SubmissionTraceSchema)['Type'][number]):SubmissionEvent {
  if(event.type==='submit'){
    const {actor,action,args}=event.body;
    if(typeof actor!=='string'||typeof action!=='string'||!args||typeof args!=='object'||Array.isArray(args))throw Error('Missing submission identity or command.');
    return {...event,body:{actor,action,args:Object.fromEntries(Object.entries(args))}};
  }
  if(event.type==='found'){
    const {status,message}=event.result;
    if(typeof status!=='string')throw Error('Invalid execution receipt.');
    return {...event,result:{status,...(typeof message==='string'?{message}:{})}};
  }
  if(event.type==='invalid'){
    const message=event['message'];
    if(typeof message!=='string')throw Error('Missing submission error message.');
    return {...event,message};
  }
  return event;
}
function replay(events:readonly SubmissionEvent[]){
  let state: SubmissionState={phase:'editing'};
  return events.map(event=>{
    if(event.type==='submit'&&(event.body?.actor!==actor||event.body?.action!==action))throw Error('Trace actor/action differs from selected action.');
    state=submissionStep(state,event);return {event,state,controls:submissionControls(state)};
  });
}
const lost:SubmissionEvent[]=[{type:'submit',id:'illustrative-1',body},{type:'lost'},{type:'check'}];
console.log(encodeJsonPretty(tracePath?{scope:'User-supplied events; replay does not authenticate receipts.',trace:replay(decodeJson(SubmissionTraceSchema,readFileSync(tracePath,'utf8')).map(traceEvent))}:{scope:'Illustrative transport events and receipts; not an execution of the domain.',recorded:replay([...lost,{type:'found',result:{status:'committed'}}]),absent:replay([...lost,{type:'missing'},{type:'retry'}])}));
