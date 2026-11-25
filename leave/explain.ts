// Optional demonstration-only source-excerpt adapter. The running
// application uses generic application-evidence/v1 and does not import this file.
import {readFileSync} from 'node:fs';
import {relative} from 'node:path';
import {createInterpreter} from '../semantic/v2/core.ts';
import {leaveModel,sourceMap} from './model.ts';

export function declaration(id,value,path){
  const span=sourceMap[id];if(!span)throw Error(`Missing declaration ${id}`);
  const source=readFileSync(span.filename,'utf8').split('\n');
  const line=span.start.line;
  return {id,path,source:`${relative(process.cwd(),span.filename)}:${line}`,line,span,excerpt:source.slice(line-1,span.end.line).join('\n'),ast:value};
}
// Diagnostic replay, NOT instrumentation of the original execution. Each boolean
// expression is passed unchanged to the existing interpreter as a precondition.
// This deliberately avoids a second expression evaluator or copied domain rules.
export function explainEvaluation(state,invocation,result,{phase='preview',grantStatus}:{phase?:string;grantStatus?:string}={}){
  const a=leaveModel.actions[invocation.action];
  if(!a)throw Error(`Unknown leave action: ${invocation.action}`);
  const checks=[...a.policies.map((p,i)=>({p,kind:p.effect,path:`actions.${invocation.action}.policies[${i}]`})),...a.preconditions.map((p,i)=>({p,kind:'precondition',path:`actions.${invocation.action}.preconditions[${i}]`}))].map(({p,kind,path})=>{
    const probe=structuredClone(leaveModel);
    probe.actions={ [invocation.action]:{...structuredClone(a),policies:[{id:'explain.probe-allow',effect:'allow',when:{op:'literal',value:true}}],preconditions:[{id:p.id,when:p.when}],updates:[],inserts:[],deletes:[],observe:[]} };
    const r=createInterpreter(probe).prepare(state,invocation);
    return {...declaration(p.id,p,path),kind,value:r.status==='prepared'?true:r.status==='rejected'&&r.code==='precondition'?false:null,diagnostic:r.status==='rejected'?r.code:undefined};
  });
  return {format:'leave-explanation/v1',phase,
    method:'Read-only diagnostic re-evaluation with semantic/v2/core.ts, not a live execution-order or parser trace. Each guard is evaluated independently, even if original execution stopped earlier.',
    representation:'Experimental text source parsed into semantic-core/v2 and validated by the existing interpreter. Source spans come from the parser; no compiler correctness proof.',
    invocation,revision:state.revision,
    inputs:{days:invocation.args.days,threshold:state.records.settings['leave-rule'].values.threshold,balance:state.records.employee[invocation.args.employeeId]?.values.balance,manager:state.records.employee[invocation.args.employeeId]?.values.manager},
    host:'application/inputs.ts utc-weekday-range/v1 converts dates to UTC Monday–Friday days. The local server supplies simulated actor, operation ID and wall clock. No holiday calendar.',
    checks,group:[...a.updates.map((u,i)=>declaration(u.id,u,`actions.${invocation.action}.updates[${i}]`)),...a.inserts.map((u,i)=>declaration(u.id,u,`actions.${invocation.action}.inserts[${i}]`))],
    outcome:{status:result.status,code:result.code,grantStatus,requirements:result.request?.requirements,events:result.events??[]},
    adapter:phase==='preview'?'prepare only; no persistence, domain commit or published facts.':result.status==='pending'?'Durable pending request saved. No domain commit, deduction or committed facts.':grantStatus==='approved'?'Grant saved in one transaction; resume is a separate transaction with fresh clock and full-state freshness checks.':'Effect/SQLite adapter owns atomic domain state, operation result and outbox persistence.',
    ui:'application/browser.ts derives forms/views from the shared application contract. This optional excerpt adapter is demonstration tooling, not required application code. SSE is not recipient-secured delivery.'};
}
