import {createApplicationClient,inboxFor} from './client.ts';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {loadSource} from '../syntax/load.ts';
import {deriveApplication} from './derive.ts';
import {decodeJsonObject,encodeJson,encodeJsonPretty} from '../adapters/effect/json.ts';

const usage=`Usage: pnpm run application:cli COMMAND [ID] --url http://127.0.0.1:4174 [options]
Commands: list [RESOURCE], inspect [ACTION], preview ACTION, execute ACTION,
          reconcile SUBMISSION --actor ID, inbox, grant REQUEST --policy POLICY, resume REQUEST
          execute accepts --submission-id ID for repeatable delivery
Options: --actor ID (required for preview/execute/grant/resume), --args JSON, --json
         --view SOURCE.domain (optional local presentation; exact domain check)
inspect ACTION prints generated schemas, hidden bindings and adapters. Submit only
visible arguments; server supplies actor/operation IDs and named computed inputs.
Local actor simulation is not authentication. No automatic retry of writes.`;

export async function runCLI(argv,{stdout=console.log}={}){
  const options={},positionals=[];
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--json'||arg==='--help'){options[arg.slice(2)]=true;continue;}
    if(arg.startsWith('--')){
      if(!['--url','--actor','--args','--policy','--view','--submission-id'].includes(arg)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error(`Unknown or missing option ${arg}.\n${usage}`);
      if(Object.hasOwn(options,arg.slice(2)))throw Error(`Duplicate option ${arg}.`);
      options[arg.slice(2)]=argv[++i];
    }else positionals.push(arg);
  }
  if(options.help||!positionals.length){stdout(usage);return;}
  const [command,id,...extra]=positionals;
  if(extra.length||!['list','inspect','preview','execute','reconcile','inbox','grant','resume'].includes(command))throw Error(usage);
  if(['preview','execute','reconcile','grant','resume'].includes(command)&&(!options.actor||!id))throw Error(`${command} requires an ID and explicit --actor.\n${usage}`);
  if(options['submission-id']&&command!=='execute')throw Error('--submission-id applies only to execute.');
  if(command==='grant'&&!options.policy)throw Error('grant requires --policy POLICY.');
  const client=createApplicationClient(options.url??process.env.APPLICATION_URL??'http://127.0.0.1:4174');
  const {contract,contractId}=await client.contract();let result,presentation;
  if(options.view){
    const loaded=loadSource(options.view);
    if(loaded.modules.at(-1).kind!=='view')throw Error('--view must select a view module entry.');
    const derived=deriveApplication(loaded.declaration);
    const expected=createHash('sha256').update(encodeJson({model:derived.model,contract})).digest('hex');
    if(expected!==contractId)throw Error('Local view domain differs from the backend. No command was sent.');
    presentation=derived.contract;
  }
  if(command==='list'){
    if(id){if(!Object.hasOwn(contract.resources,id))throw Error(`Unknown resource '${id}'.`);result=(await client.snapshot()).state.records[id];}
    else result=Object.entries(contract.actions).map(([id,a])=>({id,label:presentation?.actions[id].label??a.label,arguments:a.fields.filter(f=>!f.hidden).map(f=>({name:f.name,schema:f.schema}))}));
  }else if(command==='inspect'){
    if(id&&!Object.hasOwn(contract.actions,id))throw Error(`Unknown action '${id}'.`);result=id?contract.actions[id]:contract;
  }else if(command==='inbox')result=inboxFor(await client.snapshot(),options.actor);
  else if(command==='preview'||command==='execute'){
    if(!Object.hasOwn(contract.actions,id))throw Error(`Unknown action '${id}'. Use list or inspect.`);
    let args;try{args=decodeJsonObject(options.args??'{}');}catch{throw Error('--args must be a JSON object.');}
    if(command==='preview')result=await client.preview({actor:options.actor,action:id,args});
    else{
      const submissionId=options['submission-id']??randomUUID();
      try{result={...await client.execute({actor:options.actor,action:id,args,submissionId}),submissionId};}
      catch(e){if(e.notSubmitted)throw e;throw Error(`${e.message} Check submission ${submissionId} with reconcile before retrying.`);}
    }
  }else if(command==='reconcile'){
    result=await client.reconcile({actor:options.actor,submissionId:id});
  }else result=await client[command]({actor:options.actor,requestId:id,...(command==='grant'?{policyId:options.policy}:{})});
  if(options.json)stdout(encodeJson(result));
  else if(result.message)stdout(`${result.message}\nStatus: ${result.status}${result.code?` (${result.code})`:''}${result.submissionId?`\nSubmission: ${result.submissionId}`:''}${result.snapshot?`\nRevision: ${result.snapshot.state.revision}`:''}`);
  else if(command==='list'&&!id)stdout(result.map(a=>`${a.id} — ${a.label}\n  arguments: ${a.arguments.map(f=>`${f.name}: ${f.schema.type}`).join(', ')||'(none)'}\n  inspect: inspect ${a.id}`).join('\n'));
  else stdout(encodeJsonPretty(result));
  return result;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try{await runCLI(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
}
