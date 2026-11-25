import {parseArgs} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadSource} from '../syntax/load.ts';
import {deriveApplication} from './derive.ts';
import {exampleArgs,actionReview} from './action-review.ts';
import {walkthrough} from './action-walkthrough.ts';
import {interactionOracle} from './interaction-check.ts';
import {checkerBuild} from './checker-build.ts';
import {decodeJson,decodeJsonObject,encodeJson,encodeJsonPretty,ActionEventsTraceSchema} from '../adapters/effect/json.ts';

const {values,positionals}=parseArgs({allowPositionals:true,options:{actor:{type:'string'},args:{type:'string'},json:{type:'boolean'},record:{type:'string'},replay:{type:'string'}}});
const [entry,action]=positionals;
if(!entry||!action||positionals.length!==2)throw Error('Usage: pnpm run inspect:action VIEW.domain ACTION [--actor ID] [--args JSON] [--json]');
if(values.replay&&(values.args||values.record))throw Error('--replay cannot be combined with --args or --record.');
const {declaration}=loadSource(entry),derived=deriveApplication(declaration),{contract}=derived;
const contractId=createHash('sha256').update(encodeJson({model:derived.model,contract})).digest('hex');
let trace: (typeof ActionEventsTraceSchema)['Type'] | null=null;
if(values.replay){
  try{trace=decodeJson(ActionEventsTraceSchema,await readFile(values.replay,'utf8'));}
  catch{throw Error('Event trace does not match the selected contract, action and actor.');}
}
const actor=values.actor??trace?.actor??contract.actors[0].id;
if(!contract.actors.some(a=>a.id===actor)||!Object.hasOwn(contract.actions,action))throw Error('Unknown actor or action.');
if(trace&&(trace.contractId!==contractId||trace.actor!==actor||trace.action!==action))throw Error('Event trace does not match the selected contract, action and actor.');
const {args,selection}=trace??(values.args?{args:decodeJsonObject(values.args),selection:'explicit arguments'}:exampleArgs(derived,action,actor));
if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Expected action arguments object.');
const mutant=trace?.['mutant'];
if(mutant&&mutant!=='snapshot-unlocks')throw Error('Unknown replay mutant.');
const fold=actionReview(contract,actor,action,mutant==='snapshot-unlocks'?{mutant}:{}),steps=[fold({type:'open'})];
const check=interactionOracle(actor);let firstFailure: {rule:string;eventCount:number} | null=null;
if(trace?.['failure']&&trace['checkerBuild']!==await checkerBuild())throw Error('Incompatible counterexample: checker/projection build differs.');
const events: unknown[]=[];
for await(const event of trace?.events??walkthrough(declaration,{actor,action,args:Object.fromEntries(Object.entries(args)),submissionId:'review-request-1'})){
  const payload=event.result;
  const snap=event.snapshot??(payload&&typeof payload==='object'&&'snapshot' in payload?payload.snapshot:undefined);
  if(snap&&(typeof snap!=='object'||!('contractId' in snap)||snap.contractId!==contractId))throw Error('Snapshot contract mismatch.');
  let rule: string | null=null;
  try{const step=fold(event);steps.push(step);if(trace?.['failure'])rule=check(event,step);}
  catch(e){if(!trace?.['failure'])throw e;rule=`projection.error: ${e.message}`;}
  events.push(event);
  if(rule){firstFailure={rule,eventCount:events.length};break;}
}
if(values.record)await writeFile(values.record,encodeJsonPretty({format:'action-events/v1',contractId,action,actor,args,selection,events}),{flag:'wx'});
const failure=trace?.['failure'];
const replayStatus=!failure?undefined:firstFailure&&typeof failure==='object'&&'rule' in failure&&'eventCount' in failure&&firstFailure.rule===failure['rule']&&firstFailure.eventCount===failure['eventCount']&&events.length===trace?.events.length?'reproduced':'not-reproduced';
if(replayStatus==='not-reproduced')process.exitCode=1;
if(values.json)console.log(encodeJsonPretty({format:'action-review/v1',contractId,replayStatus,firstFailure,mutant:trace?.['mutant'],provenance:trace?'unauthenticated file replay':'isolated backend execution',entry,actor,action,selection,steps}));
else{
  console.log(`${contract.actions[action].label} · ${actor}\n${selection}: ${encodeJson(args)}\n${trace?'Offline replay; file provenance is not authenticated.':'Isolated database.'} Input and transport schedule simulated; receipts and snapshots recorded in the original run.\n`);
  for(const s of steps){
    if(s.step===1&&trace?.['mutant'])console.log(`Replaying deliberate test fault: ${trace['mutant']} (${failure&&typeof failure==='object'&&'rule' in failure?failure['rule']:'unspecified rule'})`);
    const actions=Object.keys(s.controls).filter(k=>s.controls[k]).join(', ')||'none';
    console.log(`${s.step}. ${s.event}${s.performedBy?' by '+s.performedBy:''} [${s.source}] → ${s.submission}; submission lifecycle permits: ${actions}`);
    if(s.message)console.log(`   ${s.message}`);
    console.log(`   Draft: ${encodeJson(s.draft)} · Inbox: ${s.inbox.length} · Original receipt: ${s.receipt?.status??'not observed'}`);
    for(const v of s.views)console.log(`   ${v.label}: ${v.phase==='initial'?(v.placeholder??'deferred'):v.records.map(r=>Object.values(r.fields).join(' · ')).join('; ')||'empty'}`);
    if(s.evidence)console.log(`   Evidence: ${s.evidence.phase} ${s.evidence.status} · ${s.evidence.invocationId}`);
  }
  if(replayStatus)console.log(`Failure replay: ${replayStatus} (${firstFailure?.rule??'no failing observation'})`);
}
