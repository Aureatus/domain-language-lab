import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSource} from '../syntax/load.mjs';
import {deriveApplication} from './derive.mjs';
import {exampleArgs} from './action-review.mjs';
import {checkInteractions} from './interaction-check.mjs';
import {checkerBuild} from './checker-build.mjs';
const {positionals,values}=parseArgs({allowPositionals:true,options:{actor:{type:'string'},args:{type:'string'},mutant:{type:'string'},out:{type:'string'}}});
const [entry,action]=positionals;
if(positionals.length!==2)throw Error('Usage: check:interactions -- VIEW.domain ACTION [--actor ID] [--args JSON] [--mutant snapshot-unlocks] [--out PATH]');
if(values.mutant&&values.mutant!=='snapshot-unlocks')throw Error('Unknown test mutant.');
const {declaration}=loadSource(entry),derived=deriveApplication(declaration),{contract,model}=derived;
const actor=values.actor??contract.actors[0].id;
if(!Object.hasOwn(contract.actions,action)||!contract.actors.some(a=>a.id===actor))throw Error('Unknown action or actor.');
const {args,selection}=values.args?{args:JSON.parse(values.args),selection:'explicit arguments'}:exampleArgs(derived,action,actor);
const report=await checkInteractions(declaration,contract,{action,actor,args,submissionId:'review-request-1'},{mutant:values.mutant});
const {counterexample,...summary}=report;
if(counterexample){
  const path=values.out??join(await mkdtemp(join(tmpdir(),'interaction-check-')),'counterexample.json');
  const {events,observed,...failure}=counterexample;
  const contractId=createHash('sha256').update(JSON.stringify({model,contract})).digest('hex');
  await writeFile(path,JSON.stringify({format:'action-events/v1',contractId,checkerBuild:await checkerBuild(),action,actor,args,selection,mutant:values.mutant,failure:{...failure,eventCount:events.length},events},null,2),{flag:'wx'});
  Object.assign(summary,{...failure,trace:path,sequence:events.map(e=>e.type),observedControls:observed?.controls});
}
console.log(JSON.stringify(summary,null,2));
if(report.status!=='bounded-pass')process.exitCode=report.status==='failed'?1:2;
