import {errorMessage,httpErrorStatus} from '../errors.ts';
import {createServer} from 'node:http';
import type {ServerResponse} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {browserBundle} from '../browser-build.ts';
import {isDeepStrictEqual} from 'node:util';
import {deriveApplication,buildInvocation,inputDefaults} from './derive.ts';
import {makeDurableRuntime,makeDurableStore,initializeDurableState,durableState,durableExecute,durableApprove,durableResume,durablePending,closeDurableStore} from '../adapters/effect/durable.ts';
import {
  decodeJson,
  decodeStrictJson,
  decodeJsonValue,
  encodeJson,
  DurableInvocationSchema,
  DurableOutcomeSchema,
  ApplicationPreviewRequestSchema,
  ApplicationExecuteRequestSchema,
  ApplicationReconcileRequestSchema,
  ApplicationGrantRequestSchema,
  ApplicationResumeRequestSchema,
} from '../adapters/effect/json.ts';

const requestSchemas={
  preview:ApplicationPreviewRequestSchema,
  execute:ApplicationExecuteRequestSchema,
  reconcile:ApplicationReconcileRequestSchema,
  grant:ApplicationGrantRequestSchema,
  resume:ApplicationResumeRequestSchema,
};

const require=createRequire(new URL('../adapters/effect/package.json',import.meta.url));
const Effect=await import(require.resolve('effect/Effect')),run=Effect.runSync;
const operationId=()=>`application-${randomUUID()}`;
const fail=(message,status=400)=>Object.assign(Error(message),{httpStatus:status});
const unwrap=r=>r.status==='duplicate'?unwrap(r.result):r;
const browserFiles=Object.fromEntries(Object.entries({
  '/':'index.html','/index.html':'index.html','/style.css':'style.css'
}).map(([path,file])=>[path,new URL(file,import.meta.url)]));
const applicationBundle=browserBundle(new URL('./browser.ts',import.meta.url));
export function resultMessage(r){
  if(r.status==='committed')return 'Saved. Your records are up to date.';
  if(r.status==='prepared')return 'Automatically approved';
  if(r.status==='pending')return 'Approval needed. No changes have been made.';
  return ({stale:'Things changed after this request was sent. No changes were made. Please send a new request.',precondition:'This request does not meet the requirements. Check the available balance and inputs.',denied:'You do not have permission for this action.','missing-record':'This person does not have the required record.','unauthorized-approval':'Only a named approver can approve this request.',consumed:'This request has already been completed.'})[r.code]??`Could not complete this request (${r.code??r.status}). No changes were made.`;
}
export async function createApplicationServer(declaration,{directory,port=0,database='application.sqlite',staticFiles=browserFiles}: {directory?: string; port?: number; database?: string; staticFiles?: Record<string, URL>}={}) {
  const derived=deriveApplication(declaration),{model,contract}=derived;
  const contractId=createHash('sha256').update(encodeJson({model,contract})).digest('hex');
  if(directory===undefined)throw new TypeError('Application storage directory required.');
  await mkdir(directory,{recursive:true});
  const runtime=makeDurableRuntime(model),db=run(makeDurableStore(resolve(directory,database),{busyTimeout:250}));
  let server,closed=false;const streams=new Set<ServerResponse>();
  try{
    if(!db.prepare('SELECT value FROM durable_meta WHERE key=?').get('format'))run(initializeDurableState(runtime,db,derived.initialState));else run(durableState(runtime,db));
    // The invocation journal owns the outcome. Keep just the pre-elaboration
    // arguments and contract binding beside it: adapters can fill omitted inputs.
    db.exec(`CREATE TABLE IF NOT EXISTS application_submissions (
      invocation_id TEXT PRIMARY KEY REFERENCES durable_invocations(id),
      contract_id TEXT NOT NULL, args_json TEXT NOT NULL
    )`);
    const submissionKey=id=>`submission-${createHash('sha256').update(encodeJson(id)).digest('hex')}`;
    const storedSubmission=db.prepare(`SELECT i.command_json,i.outcome_json,s.contract_id,s.args_json
      FROM application_submissions s JOIN durable_invocations i ON i.id=s.invocation_id
      WHERE s.invocation_id=?`);
    function lookup(key,body,execute){
      const row=storedSubmission.get(key);
      if(!row)return null;
      const invocation=decodeJson(DurableInvocationSchema,row.command_json);
      if(invocation.actor!==body.actor)throw fail('This submission belongs to another person.',403);
      if(row.contract_id!==contractId||execute&&(invocation.action!==body.action||!isDeepStrictEqual(decodeJsonValue(row.args_json),decodeJsonValue(encodeJson(body.args)))))
        throw fail('Submission ID already bound to another command or contract.',409);
      return {invocation,result:decodeJson(DurableOutcomeSchema,row.outcome_json)};
    }
    const state=()=>run(durableState(runtime,db));
    function preview(actor,action,args,current){
      const invocation=buildInvocation(contract,{actor,action,args,id:operationId(),clock:Date.now()});
      const result=runtime.prepare(current,invocation);
      return {invocation,result};
    }
    function snapshot(){
      // Each adapter projection opens its own read transaction. A different
      // writer process can commit between them; never label a mixed snapshot
      // with the newer ledger version.
      const version=()=>db.prepare('SELECT (SELECT count(*) FROM durable_invocations) + (SELECT count(*) FROM durable_operations) AS version').get().version;
      for(let attempt=0;attempt<4;attempt++){
        const snapshotVersion=version(),value=readSnapshot(snapshotVersion);
        if(version()===snapshotVersion)return value;
      }
      throw fail('Records changed during refresh. Reconnect to see the current snapshot.',503);
    }
    function readSnapshot(snapshotVersion){
      const current=state();
      const pending=db.prepare('SELECT invocation_id FROM durable_pending ORDER BY rowid').all().map(row=>{
        const p=run(durablePending(runtime,db,row.invocation_id));
        return {id:p.invocationId,status:p.status,invocation:p.request.invocation,requirements:p.request.requirements,grants:p.grants,stale:p.status==='pending'&&!isDeepStrictEqual(p.request.prestate,current)};
      });
      // Availability is only an interpreter-derived display hint. Every submit is
      // independently validated/authorized against fresh durable state.
      const defaults={},availability={};
      for(const actor of contract.actors){defaults[actor.id]={};availability[actor.id]={};for(const action of Object.keys(contract.actions)){
        const args=inputDefaults(contract,action,current,actor.id);defaults[actor.id][action]=args;
        try{const {result}=preview(actor.id,action,args,current);availability[actor.id][action]=result.status!=='rejected'||!['denied','missing-record'].includes(result.code);}catch{availability[actor.id][action]=true;}
      }}
      return {contractId,snapshotVersion,state:current,pending,defaults,availability};
    }
    const evidence=(invocation,result,phase)=>{
      const action=model.actions[invocation.action];
      if(!action)throw Error('Missing evidence action declaration.');
      const {policies,preconditions,updates,inserts,deletes}=action;
      return {format:'application-evidence/v1',phase,invocation,policies,preconditions,group:{updates,inserts,deletes},outcome:{status:result.status,code:result.code??null,requirements:result.request?.requirements??[],events:result.events??[]},method:'Actual interpreter/durable result and declared AST; not a parser trace or ordered guard evaluation.'};
    };
    const publish=()=>{const event=`event: update\ndata: ${encodeJson(snapshot())}\n\n`;for(const res of streams)if(!res.write(event))res.destroy();};
    server=createServer(async(req,res)=>{
      const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(encodeJson(value));};
      try{
        if(!req.headers.host||![`127.0.0.1:${server.address().port}`,`localhost:${server.address().port}`].includes(req.headers.host))throw fail('Unexpected host.',403);
        if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)throw fail('Cross-origin requests are not supported.',403);
        if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))throw fail('Cross-site requests are not supported.',403);
        const url=new URL(req.url??'/',`http://${req.headers.host}`);
        if(req.method==='GET'&&url.pathname==='/api/contract')return json(200,{contractId,contract});
        if(req.method==='GET'&&url.pathname==='/api/snapshot')return json(200,snapshot());
        if(req.method==='GET'&&url.pathname==='/api/events'){
          res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store',connection:'keep-alive'});streams.add(res);res.write(`event: update\ndata: ${encodeJson(snapshot())}\n\n`);res.on('close',()=>streams.delete(res));return;
        }
        if(req.method==='POST'&&['/api/actions/preview','/api/actions/execute','/api/actions/reconcile','/api/approvals/grant','/api/approvals/resume'].includes(url.pathname)){
          if(req.headers['content-type']?.split(';')[0]!=='application/json')throw fail('Expected JSON.',415);
          let bytes=0;const chunks: Buffer[]=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)throw fail('Request too large.',413);chunks.push(chunk);}
          const kind=url.pathname.slice(url.pathname.lastIndexOf('/')+1);let body,result,invocation,key,replayed=false;
          try{body=decodeStrictJson(requestSchemas[kind],Buffer.concat(chunks).toString());}catch(e){throw fail(errorMessage(e)||'Invalid JSON.');}
          try{
            if(!contract.actors.some(a=>a.id===body.actor))throw Error('Choose a known person.');
            if(Object.hasOwn(body,'submissionId'))key=submissionKey(body.submissionId);
          }catch(e){throw fail(errorMessage(e));}
           if(Object.hasOwn(body,'expectedContractId')&&body.expectedContractId!==contractId)throw fail('Application contract changed. Reload before continuing.',409);
           if(key){
            const stored=lookup(key,body,kind==='execute');
            if(stored){({invocation,result}=stored);replayed=true;}
             else if(kind==='reconcile')return json(200,{status:'not-found',contractId,submissionId:body.submissionId});
          }
          if(kind==='execute'||kind==='preview'){
            if(!replayed){
               try{invocation=buildInvocation(contract,{...body,id:key??operationId(),clock:Date.now()});}catch(e){
                 if(key)return json(400,{error:errorMessage(e),disposition:'not-submitted',contractId,submissionId:body.submissionId});
                 throw fail(errorMessage(e));
               }
              if(kind==='preview')result=runtime.prepare(state(),invocation);
              else{
                const outcome=run(durableExecute(runtime,db,invocation,key?{beforeCommit:()=>{
                  db.prepare('INSERT INTO application_submissions(invocation_id,contract_id,args_json) VALUES(?,?,?)').run(key,contractId,encodeJson(body.args));
                }}:undefined));
                // Another process may have won after our lookup, with a different
                // host clock. Compare the client command, never retry with a new ID.
                if(key&&(outcome.status==='duplicate'||outcome.code==='invocation-conflict')){
                  const stored=lookup(key,body,true);
                  if(!stored)throw fail('Submission ID unavailable.',409);
                  ({invocation,result}=stored);replayed=true;
                }else result=unwrap(outcome);
              }
            }
          }
          else if(kind==='grant'){
            result=unwrap(run(durableApprove(runtime,db,{id:operationId(),invocationId:body.requestId,policyId:body.policyId},{authenticatedApprover:body.actor})));
            invocation=run(durablePending(runtime,db,body.requestId))?.request.invocation;
          }
          else if(kind==='resume'){
            const pending=run(durablePending(runtime,db,body.requestId));if(!pending)throw fail('Request not found.',404);
            // No arbitrary caller can trigger a previously granted invocation.
            const eligible=pending.request.invocation.actor===body.actor||pending.request.requirements.some(r=>r.approvers.includes(body.actor));
            if(!eligible)throw fail('Only the requester or a named approver can complete this request.',403);
            result=unwrap(run(durableResume(runtime,db,{id:operationId(),invocationId:body.requestId,clock:Date.now()})));
            invocation=pending.request.invocation;
          }
          if(kind!=='preview'&&!replayed)publish();
          return json(200,{submissionId:body.submissionId,status:result.status,code:result.code,message:kind==='grant'&&result.status==='approved'?'Approval saved. Complete the request separately.':resultMessage(result),args:invocation?.args,requirements:result.request?.requirements,evidence:invocation?evidence(invocation,result,kind==='reconcile'?'execute':kind):undefined,snapshot:kind==='preview'?undefined:snapshot(),contractId});
        }
        if(req.method==='GET'&&staticFiles===browserFiles&&url.pathname==='/app.js'){
          const script=await applicationBundle();
          res.writeHead(200,{'content-type':'text/javascript','x-content-type-options':'nosniff','cache-control':'no-store'});
          return res.end(script);
        }
        const file=Object.hasOwn(staticFiles,url.pathname)?staticFiles[url.pathname]:undefined;
        if(req.method!=='GET'||!file)throw fail('Not found.',404);
        const data=await readFile(file);
        res.writeHead(200,{'content-type':file.pathname.endsWith('.html')?'text/html; charset=utf-8':file.pathname.endsWith('.css')?'text/css':'text/javascript','x-content-type-options':'nosniff','cache-control':'no-store'});res.end(data);
      }catch(e){const status=httpErrorStatus(e);if(res.headersSent)res.destroy();else json(status??500,{error:status?errorMessage(e):'Storage failed. The operation may have been recorded; reconnect before retrying.'});}
    });
    await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});
    return {url:`http://127.0.0.1:${server.address().port}`,async close(){if(closed)return;closed=true;for(const res of streams)res.end();streams.clear();await new Promise<void>((yes,no)=>{server.close(e=>e?no(e):yes());server.closeAllConnections();});run(closeDurableStore(db));}};
  }catch(e){run(closeDurableStore(db));throw e;}
}
