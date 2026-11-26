// Replay from repository root: node application/action-review-browser-test.ts [counterexample.json]
// Uses the installed Exact SDK/launcher and Chromium. Builds into a new directory;
// never points either renderer at an existing app or writes a shared dist.
import type {Browser,Locator,Page} from 'playwright';
import type {ApplicationReceipt} from './client.ts';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, rm, copyFile, readdir, readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createApplicationServer} from './server.ts';
import {writeAdapter} from '../adapters/exact/generate.ts';
import declaration from '../leave/model.ts';
import defaultCommand from '../leave/review-request.json' with {type:'json'};
type DeliverySnapshot = {pending: {invocation:{clock?:number}}[]};
declare global {
  interface Window {deliveryGate: {held: DeliverySnapshot | null; release: () => void}}
}

const exec=promisify(execFile);
const exactRevision='d8863f736172954b605c3bff22f51337c6983170';
type RecordedDraft={actor:string;action:string;args:Record<string,string>};
async function readSchedule(path:string){
  const {format,actor,action,args,contractId,events}=JSON.parse(await readFile(path,'utf8'));
  assert.equal(format,'action-events/v1','Unsupported trace format');
  assert.deepEqual(events?.map((e:{type:string})=>e.type),['snapshot','draft','submit','lost','snapshot'],'Unsupported renderer replay ordering');
  assert.equal(actor,'maya','Unsupported renderer replay actor');
  assert.equal(action,'leave.request','Unsupported renderer replay action');
  assert.deepEqual(Object.keys(args).sort(),['end','start'],'Unsupported draft fields');
  const [{snapshot:initial},{id,body},,,{snapshot:update}]=events;
  assert.deepEqual(body,{actor,action,args});
  assert.ok(typeof id==='string'&&id.trim()&&id.length<=200,'Missing or invalid submission identity');
  assert.equal(initial.contractId,contractId);
  assert.equal(update.contractId,contractId);
  assert.equal(update.pending.length,1,'Only a single pending inbox update is supported');
  const command:RecordedDraft&{submissionId:string}={...body,submissionId:id};
  const first:DeliverySnapshot=initial,next:DeliverySnapshot=update;
  return {command,initial:first,update:next};
}

// Install before application startup. Delay observation, not the actual
// write, poll, or EventSource connection. Never fabricate an update payload.
function installDeliveryGate(exact:boolean){
  const gate=Promise.withResolvers<void>();
  const probe: Window['deliveryGate']=window.deliveryGate={held:null,release:gate.resolve};
  async function wait(snapshot: DeliverySnapshot){
    if(snapshot.pending.length){probe.held=snapshot;await gate.promise;}
  }
  if(exact){
    const fetch=window.fetch.bind(window);
    window.fetch=async(...args)=>{
      const response=await fetch(...args);
      if(new URL(response.url).pathname==='/api/snapshot')await wait(await response.clone().json());
      return response;
    };
  }else{
    const add=EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener=function(this:EventSource,type:string,listener:EventListenerOrEventListenerObject|((this:EventSource,event:MessageEvent)=>unknown)|null,options?:boolean|AddEventListenerOptions){
      if(type!=='update')return Reflect.apply(add,this,[type,listener,options]);
      return add.call(this,type,async event=>{
        if(event instanceof MessageEvent)await wait(JSON.parse(event.data));
        if(typeof listener==='function')Reflect.apply(listener,this,[event]);
        else listener?.handleEvent(event);
      },options);
    };
  }
}
function normalizedUpdate(snapshot:DeliverySnapshot){
  const copy=structuredClone(snapshot);
  // The fresh server samples its own clock when executing the command.
  for(const p of copy.pending){assert.ok(Number.isSafeInteger(p.invocation.clock));delete p.invocation.clock;}
  return copy;
}

async function mountExact(page:Page,url:string,dir:string){
  await writeAdapter(await (await fetch(url+'/api/contract')).json(),dir,{api:url});
  for(const file of ['exact.mjs','package.json'])await copyFile(join(template,file),join(dir,file));
  for(const args of [['contract','build','app.contract','--json','--errors-only'],['web-build','--out','dist']])
    await exec(env.BUN,['exact.mjs',...args],{cwd:dir,env,timeout:120000});
  // Serve the actual compiled bytes at the backend origin (no CORS bypass).
  const dist=join(dir,'dist'),files=new Set(await readdir(dist));
  await page.route(u=>u.origin===url&&!u.pathname.startsWith('/api/'),route=>{
    const file=new URL(route.request().url()).pathname.slice(1)||'index.html';
    return files.has(file)?route.fulfill({path:join(dist,file)}):route.abort();
  });
}

async function trace(browser:Browser,exact:boolean,dir:string,schedule:Awaited<ReturnType<typeof readSchedule>>|null){
  const server=await createApplicationServer(declaration,{directory:join(dir,'db')});
  const page=await browser.newPage();
  const release=Promise.withResolvers<void>();
  try{
    const command=schedule?.command??defaultCommand;
    const {url}=server,{actor,action,args,submissionId}=command,errors: string[]=[],writes: string[]=[];
    page.setDefaultTimeout(15000);
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.method()==='POST'&&!r.url().endsWith('/preview'))writes.push(new URL(r.url()).pathname);});
    if(exact)await mountExact(page,url,dir);
    if(schedule)await page.addInitScript(installDeliveryGate,exact);
    // Explicit identity-allocation input, not a rewritten POST or canned receipt.
    await page.addInitScript(id=>{Object.defineProperty(crypto,'randomUUID',{configurable:true,writable:true,value:()=>id});},submissionId);
    await page.goto(url);
    const form=page.locator(`[data-action="${action}"]`);
    const field=(name:string)=>exact?page.getByTestId(`${actor}:${action}:${name}`):form.locator(`[name="${name}"]`);
    const submit=exact?page.getByTestId(`${actor}:${action}:execute`):form.locator('[type=submit]');
    const button=(name:string)=>page.getByRole('button',{name,exact:true});
    const check=button('Check submission');
    const select=exact?page.getByTestId('actor'):page.locator('#actor');
    const balance=(n:number)=>exact?page.getByTestId(`view:0:${actor}`).filter({hasText:`Days remaining: ${n}`}):
      page.locator(`[data-record="${actor}"] [data-field="balance"]`).filter({hasText:new RegExp(`^${n}$`)});
    const snapshot=async()=>await (await fetch(url+'/api/snapshot')).json();
    const initialSnapshot=await snapshot(),initial=initialSnapshot.state;
    if(schedule)assert.deepEqual(initialSnapshot,schedule.initial,'Trace initial snapshot does not match this isolated server');
    await balance(5).waitFor();
    for(const [key,value] of Object.entries(args))await field(key).fill(value);
    if(!exact)await form.locator('[data-preview]').filter({hasText:'Needs Sam'}).waitFor();

    let posted:unknown,receipt:ApplicationReceipt|undefined;
    await page.route('**/api/actions/execute',async route=>{
      posted=route.request().postDataJSON();
      const response=await route.fetch({maxRetries:0});
      try{receipt=await response.json();await release.promise;await route.abort('failed');}
      finally{await response.dispose();}
    },{times:1});
    await submit.click();
    const pending=exact?page.getByText('Approval: Sam Rivera',{exact:true}):page.locator('[data-request]');
    if(schedule){
      await page.waitForFunction(()=>!!window.deliveryGate.held);
      const held=await page.evaluate(()=>window.deliveryGate.held);
      assert.ok(held);
      assert.deepEqual(normalizedUpdate(held),normalizedUpdate(schedule.update),'Actual held update differs from the recorded update');
      assert.equal(await pending.count(),0,'Inbox update arrived before loss');
      assert.equal(await check.count(),0,'Loss was observed before releasing the writer');
    }else{
      // Original coverage: deliver the independent update BEFORE the loss.
      await pending.waitFor();
    }
    release.resolve();
    await check.waitFor();
    if(schedule){
      assert.equal(await pending.count(),0,'Inbox update was not held through loss');
      await page.evaluate(()=>window.deliveryGate.release());
      await pending.waitFor();
    }
    assert.ok(receipt?.snapshot);
    assert.deepEqual(posted,{...command,expectedContractId:receipt.contractId});
    assert.equal(receipt.status,'pending');
    assert.equal(receipt.snapshot.pending.length,1);
    const [original]=receipt.snapshot.pending;assert.ok(original);
    const leaveId=original.invocation.args['leaveId'];
    if(!schedule)assert.equal(original.invocation.args['days'],3);
    assert.equal(receipt.submissionId,submissionId);
    assert.deepEqual(receipt.snapshot.state,initial);
    assert.equal(await submit.isDisabled(),true);
    assert.equal(await check.isEnabled(),true);
    for(const [key,value] of Object.entries(args))assert.equal(await field(key).inputValue(),value);
    assert.equal(await page.getByRole('button',{name:/retry.*submission/i}).count(),0);
    await pending.waitFor();
    if(schedule){
      // Stop at the counterexample boundary: Check is offered, never pressed.
      await page.getByText(exact?/Submission has an ambiguous outcome/:/Outcome unknown\./).waitFor();
      assert.equal(await page.getByText(/Original submission outcome:/).count(),0);
      assert.deepEqual(writes,['/api/actions/execute']);
      assert.deepEqual(errors,[]);
      console.log(`${exact?'Compiled Exact web / poll':'Generic browser / SSE'}: ${submissionId}, lost → inbox update; no receipt, draft retained, Submit disabled, Check enabled.`);
      return;
    }
    const press=async(control:Locator,path:string)=>{
      const [reply]=await Promise.all([page.waitForResponse(r=>r.url()===url+'/api/'+path&&r.request().method()==='POST'),control.click()]);
      assert.equal(reply.ok(),true);
      return {body:reply.request().postDataJSON(),result:await reply.json()};
    };
    const checked=await press(check,'actions/reconcile');
    assert.deepEqual(checked.body,{actor,submissionId,expectedContractId:receipt.contractId});
    assert.equal(checked.result.status,'pending');
    assert.equal(checked.result.submissionId,submissionId);
    assert.deepEqual(checked.result.evidence,receipt.evidence);
    await check.waitFor({state:'hidden'});
    await page.getByText(/Original submission outcome: Approval needed/).waitFor();
    await select.selectOption('sam');
    const grant=await press(button('Save approval'),'approvals/grant');
    assert.equal(grant.body.requestId,original.id);
    assert.equal(grant.result.status,'approved');
    assert.deepEqual(grant.result.snapshot.state,initial);
    assert.equal(grant.result.snapshot.pending[0].grants.length,1);
    const completed=await press(button('Complete request'),'approvals/resume');
    assert.equal(completed.body.requestId,original.id);
    assert.equal(completed.result.status,'committed');
    await select.selectOption(actor);
    await balance(2).waitFor();
    const row=exact?page.getByTestId(`view:2:${leaveId}`).filter({hasText:`First day: ${args.start}`}):
      page.locator(`[data-resource="leave"] [data-record="${leaveId}"]`);
    await row.waitFor();
    const state=completed.result.snapshot.state;
    assert.deepEqual(Object.keys(state.records.leave),[leaveId]);
    assert.deepEqual(writes,['/api/actions/execute','/api/actions/reconcile','/api/approvals/grant','/api/approvals/resume']);
    // Independent backend probe: an actual second resume cannot debit again.
    const again=await fetch(url+'/api/approvals/resume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(completed.body)});
    assert.equal((await again.json()).code,'consumed');
    assert.deepEqual((await snapshot()).state,state);
    assert.deepEqual(errors,[]);
    console.log(`${exact?'Compiled Exact web / poll':'Generic browser / SSE'}: ${submissionId}, pending before check, original receipt, 5 → granted 5 → completed 2, one leave.`);
  }finally{
    release.resolve();
    await page.close();
    await server.close();
  }
}

if(process.argv.length>3)throw Error('Usage: node application/action-review-browser-test.ts [counterexample.json]');
const schedule=process.argv[2]?await readSchedule(process.argv[2]):null;
if(!process.env['EXACT_ROOT']||!process.env['EXACT_TEMPLATE'])
  throw Error('Set EXACT_ROOT and EXACT_TEMPLATE as described in docs/exact-adapter.md.');
const template=resolve(process.env['EXACT_TEMPLATE']);
const env={...process.env,EXACT:resolve(process.env['EXACT_ROOT']),BUN:process.env['BUN']??'bun',EXACT_FEEDBACK:'0'};
assert.equal((await exec('git',['-C',env.EXACT,'rev-parse','HEAD'])).stdout.trim(),exactRevision,'Unsupported Exact revision');
const require=createRequire(join(env.EXACT,'package.json'));
const {chromium}=require('playwright-core');
const browser:Browser=await chromium.launch({headless:true});
try{
  for(const exact of [false,true]){
    const dir=await mkdtemp(join(tmpdir(),'action-review-'));
    try{await trace(browser,exact,dir,schedule);}finally{await rm(dir,{recursive:true,force:true});}
  }
}finally{await browser.close();}
