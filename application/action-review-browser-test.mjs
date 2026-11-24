// Replay from repository root: node application/action-review-browser-test.mjs [counterexample.json]
// Uses the installed Exact SDK/launcher and Chromium. Builds into a new directory;
// never points either renderer at an existing app or writes a shared dist.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, rm, copyFile, readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from '/tmp/opencode/workbench-tooling/node_modules/playwright/index.mjs';
import {createApplicationServer} from './server.mjs';
import {writeAdapter} from '../adapters/exact/generate.mjs';
import declaration from '../leave/model.mjs';
import defaultCommand from '../leave/review-request.json' with {type:'json'};

const exec=promisify(execFile);
async function readSchedule(path){
  const {format,actor,action,args,contractId,events}=JSON.parse(await readFile(path,'utf8'));
  assert.equal(format,'action-events/v1','Unsupported trace format');
  assert.deepEqual(events?.map(e=>e.type),['snapshot','draft','submit','lost','snapshot'],'Unsupported renderer replay ordering');
  assert.equal(actor,'maya','Unsupported renderer replay actor');
  assert.equal(action,'leave.request','Unsupported renderer replay action');
  assert.deepEqual(Object.keys(args).sort(),['end','start'],'Unsupported draft fields');
  const [{snapshot:initial},{id,body},,,{snapshot:update}]=events;
  assert.deepEqual(body,{actor,action,args});
  assert.ok(typeof id==='string'&&id.trim()&&id.length<=200,'Missing or invalid submission identity');
  assert.equal(initial.contractId,contractId);
  assert.equal(update.contractId,contractId);
  assert.equal(update.pending.length,1,'Only a single pending inbox update is supported');
  return {command:{...body,submissionId:id},initial,update};
}

// Install before application startup. Delay observation, not the actual
// write, poll, or EventSource connection. Never fabricate an update payload.
function installDeliveryGate(exact){
  const gate=Promise.withResolvers();
  const probe=window.deliveryGate={held:null,release:gate.resolve};
  async function wait(snapshot){
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
    EventSource.prototype.addEventListener=function(type,listener,...rest){
      if(type!=='update')return add.call(this,type,listener,...rest);
      return add.call(this,type,async event=>{
        await wait(JSON.parse(event.data));listener.call(this,event);
      },...rest);
    };
  }
}
function normalizedUpdate(snapshot){
  const copy=structuredClone(snapshot);
  // The fresh server samples its own clock when executing the command.
  for(const p of copy.pending){assert.ok(Number.isSafeInteger(p.invocation.clock));delete p.invocation.clock;}
  return copy;
}

async function mountExact(page,url,dir){
  const env={...process.env,EXACT:process.env.EXACT_ROOT??'/tmp/opencode/exact-source',
    BUN:process.env.BUN??'/tmp/opencode/exact-bun/bun-linux-x64/bun',EXACT_FEEDBACK:'0'};
  assert.equal((await exec('git',['-C',env.EXACT,'rev-parse','HEAD'])).stdout.trim(),'d8863f736172954b605c3bff22f51337c6983170','Unsupported Exact revision');
  await writeAdapter(await (await fetch(url+'/api/contract')).json(),dir,{api:url});
  const template=process.env.EXACT_TEMPLATE??'/tmp/opencode/exact-generated';
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

async function trace(browser,exact,dir,schedule){
  const server=await createApplicationServer(declaration,{directory:join(dir,'db')});
  const page=await browser.newPage();
  const release=Promise.withResolvers();
  try{
    const command=schedule?.command??defaultCommand;
    const {url}=server,{actor,action,args,submissionId}=command,errors=[],writes=[];
    page.setDefaultTimeout(15000);
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.method()==='POST'&&!r.url().endsWith('/preview'))writes.push(new URL(r.url()).pathname);});
    if(exact)await mountExact(page,url,dir);
    if(schedule)await page.addInitScript(installDeliveryGate,exact);
    // Explicit identity-allocation input, not a rewritten POST or canned receipt.
    await page.addInitScript(id=>{crypto.randomUUID=()=>id;},submissionId);
    await page.goto(url);
    const form=page.locator(`[data-action="${action}"]`);
    const field=name=>exact?page.getByTestId(`${actor}:${action}:${name}`):form.locator(`[name="${name}"]`);
    const submit=exact?page.getByTestId(`${actor}:${action}:execute`):form.locator('[type=submit]');
    const button=name=>page.getByRole('button',{name,exact:true});
    const check=button('Check submission');
    const select=exact?page.getByTestId('actor'):page.locator('#actor');
    const balance=n=>exact?page.getByTestId(`view:0:${actor}`).filter({hasText:`Days remaining: ${n}`}):
      page.locator(`[data-record="${actor}"] [data-field="balance"]`).filter({hasText:new RegExp(`^${n}$`)});
    const snapshot=async()=>await (await fetch(url+'/api/snapshot')).json();
    const initialSnapshot=await snapshot(),initial=initialSnapshot.state;
    if(schedule)assert.deepEqual(initialSnapshot,schedule.initial,'Trace initial snapshot does not match this isolated server');
    await balance(5).waitFor();
    for(const [key,value] of Object.entries(args))await field(key).fill(value);
    if(!exact)await form.locator('[data-preview]').filter({hasText:'Needs Sam'}).waitFor();

    let posted,receipt;
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
    assert.deepEqual(posted,{...command,expectedContractId:receipt.contractId});
    assert.equal(receipt.status,'pending');
    assert.equal(receipt.snapshot.pending.length,1);
    const original=receipt.snapshot.pending[0],{leaveId}=original.invocation.args;
    if(!schedule)assert.equal(original.invocation.args.days,3);
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
    const press=async(control,path)=>{
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

if(process.argv.length>3)throw Error('Usage: node application/action-review-browser-test.mjs [counterexample.json]');
const schedule=process.argv[2]?await readSchedule(process.argv[2]):null;
const browser=await chromium.launch({headless:true});
try{
  for(const exact of [false,true]){
    const dir=await mkdtemp('/tmp/opencode/action-review-');
    try{await trace(browser,exact,dir,schedule);}finally{await rm(dir,{recursive:true,force:true});}
  }
}finally{await browser.close();}
