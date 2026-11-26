// All application content comes from /api/contract. This module has no domain IDs.
import {errorMessage} from '../errors.ts';
import {acceptsSnapshot} from './snapshot.ts';
import {viewRecords} from './view-records.ts';
import {isNotSubmittedError,submissionStep,submissionControls} from './submission.ts';
import {loadingPlan,loadingPresentation} from './loading.ts';
import {ApplicationSavedSubmissionsSchema,decodeStrictJson,encodeJson} from '../adapters/effect/json.ts';
import {createApplicationClient,decodeApplicationSnapshot,inboxFor} from './client.ts';
import type {ApplicationReceipt,ApplicationSnapshot} from './client.ts';
import type {State,Value} from '../semantic/v2/types.ts';
import type {ApplicationContract,ApplicationField} from './derive.ts';
import type {SubmissionBody,SubmissionEvent,SubmissionState} from './submission.ts';
function required<T extends HTMLElement>(parent: ParentNode,selector: string,kind: new () => T): T {
  const element=parent.querySelector(selector);
  if(!(element instanceof kind))throw Error(`Missing application control: ${selector}`);
  return element;
}
const $=(id: string)=>required(document,`#${id}`,HTMLElement),params=new URLSearchParams(location.search);
const actorControl=required(document,'#actor',HTMLSelectElement);
const client=createApplicationClient(location.origin);
const {contract,contractId}=await client.contract().catch(error=>{
  $('connection').textContent='Disconnected';actorControl.disabled=true;
  $('notice').textContent='Could not load the application. ';$('notice').hidden=false;
  const retry=document.createElement('button');retry.textContent='Retry';retry.onclick=()=>location.reload();$('notice').append(retry);
  throw error;
});
const [defaultActor]=contract.actors;
if(!defaultActor)throw Error('Application has no actors.');
let actor=contract.actors.find(a=>a.id===params.get('actor'))?.id??defaultActor.id;
let snapshot:ApplicationSnapshot|undefined,busy=false,sequence=0,lastEvidence:ApplicationReceipt['evidence'],currentEvidence:ApplicationReceipt['evidence'],showSaved=false,initialLoadError=false;
const drafts=new Map<string,Record<string,unknown>>(),previews=new Map<string,number>();
type SavedSubmission=SubmissionState&{body:SubmissionBody;id:string};
const submissions=new Map<string,SavedSubmission>(),storageKey=`submissions/v1/${contractId}`;
const recovery=document.createElement('section');$('notice').after(recovery);
// A tab reload interrupts the observation, not necessarily the durable write.
const savedSubmissions=(()=>{
  try{return decodeStrictJson(ApplicationSavedSubmissionsSchema,sessionStorage.getItem(storageKey)??'[]');}
  catch(error){$('connection').textContent='Disconnected';actorControl.disabled=true;notice(`Could not load saved submissions. ${errorMessage(error)}`,true);throw error;}
})();
for(const s of savedSubmissions){
  const k=JSON.stringify([s.body.actor,s.body.action]);submissions.set(k,{...s,phase:'unknown'});drafts.set(k,{...s.body.args});
}
function track(k:string,state:SubmissionState){
  if(state.phase==='known'||state.phase==='editing')submissions.delete(k);
  else{
    const {id,body}=state;
    if(!id||!body)throw Error('Missing saved submission.');
    submissions.set(k,{...state,id,body});
  }
  sessionStorage.setItem(storageKey,encodeJson([...submissions.values()],ApplicationSavedSubmissionsSchema));
  return state;
}
const escapes: Record<string,string>={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const esc=(s: unknown)=>String(s??'').replace(/[&<>"']/g,c=>escapes[c]??c);
const person=(id:Value|undefined)=>{const a=contract.actors.find(a=>a.id===id);return a?.name??a?.label??id;};
const key=(action:string)=>JSON.stringify([actor,action]);
const value=(v:unknown)=>Array.isArray(v)?v.join(', '):String(v??'');
document.title=contract.title;$('brand').textContent=contract.title;$('heading').textContent=contract.title;$('subtitle').textContent=contract.subtitle;$('scope').textContent=contract.scope;
$('eyebrow').textContent=contract.eyebrow;$('eyebrow').hidden=!contract.eyebrow;
actorControl.innerHTML=contract.actors.map(a=>`<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');actorControl.value=actor;
if(params.get('watch')==='1')document.body.classList.add('watch');
if(params.get('explain')==='1'){document.body.classList.add('explaining');$('companion').hidden=false;}
function showEvidence(){const e=showSaved?lastEvidence:currentEvidence;$('evidence').textContent=e?JSON.stringify(e,null,2):'Choose an action to see its declaration and result.';}
$('current-evidence').onclick=()=>{showSaved=false;showEvidence();};$('saved-evidence').onclick=()=>{showSaved=true;showEvidence();};
function notice(message:string|undefined,error=false){$('notice').hidden=false;$('notice').textContent=message??null;$('notice').classList.toggle('error',error);}
const actionFor=(form:HTMLFormElement)=>{const action=form.dataset['action'];if(!action)throw Error('Missing action for form');return action;};
function getDraft(action:string){
  const id=key(action),existing=drafts.get(id);
  if(existing)return existing;
  const draft={...snapshot?.defaults[actor]?.[action]};drafts.set(id,draft);return draft;
}
function inputHTML(f: ApplicationField,args:Record<string,unknown>,action:string,current:ApplicationSnapshot){
  if(f.hidden)return '';
  const id=`input-${encodeURIComponent(action)}-${encodeURIComponent(f.name)}`,v=args[f.name];
  const {reference,schema}=f,records: State['records']=current.state.records;
  const collection=reference?records[reference.resource]:undefined;
  if(reference&&!collection)throw Error(`Missing reference resource: ${reference.resource}`);
  const options=reference&&collection?Object.entries(collection).map(([id,r])=>[id,reference.labelField?r.values[reference.labelField]:id]):schema.type==='string'?schema.enum?.map(v=>[v,v]):undefined;
  const control=options?`<select name="${esc(f.name)}" id="${id}">${options.map(([k,label])=>`<option value="${esc(k)}" ${k===v?'selected':''}>${esc(label)}</option>`).join('')}</select>`:`<input id="${id}" name="${esc(f.name)}" type="${f.widget}" ${f.widget==='checkbox'?(v?'checked':''):`value="${esc(v)}" required`} ${schema.type==='integer'&&schema.min!==undefined?`min="${schema.min}"`:''} ${schema.type==='integer'&&schema.max!==undefined?`max="${schema.max}"`:''} ${schema.type==='integer'?'step="1"':''}>`;
  return `<label>${esc(f.label)}${control}</label>`;
}
function renderForms(current:ApplicationSnapshot){
  $('forms').innerHTML=Object.values(contract.actions).filter(a=>current.availability[actor]?.[a.id]).map(a=>`<form class="panel" data-action="${esc(a.id)}"><h2>${esc(a.label)}</h2><p class="muted">${esc(a.description)}</p><div class="fields">${a.fields.map(f=>inputHTML(f,getDraft(a.id),a.id,current)).join('')}</div><p class="preview" data-preview></p><button type="submit" ${busy?'disabled':''}>${esc(a.label)}</button></form>`).join('');
  for(const form of $('forms').querySelectorAll('form')){
    const action=actionFor(form);
    const a=contract.actions[action];if(!a)throw Error(`Unknown form action: ${action}`);
    form.addEventListener('input',()=>{const args=getDraft(a.id);for(const f of a.fields.filter(f=>!f.hidden)){
      const el=form.elements.namedItem(f.name);
      if(!(el instanceof HTMLInputElement||el instanceof HTMLSelectElement))throw Error(`Missing input: ${f.name}`);
      args[f.name]=f.schema.type==='integer'?Number(el.value):f.schema.type==='boolean'&&el instanceof HTMLInputElement?el.checked:el.value;
    }preview(a.id);});
    form.addEventListener('submit',e=>{e.preventDefault();const k=key(action);if(!busy&&!submissions.has(k))sendSubmission(k,{phase:'editing'},{type:'submit',id:crypto.randomUUID(),body:{actor,action,args:getDraft(action)}});});
  }
}
function renderViews(current:ApplicationSnapshot){
  type View=ApplicationContract['views'][number];
  const format=(v:View,c:View['columns'][number],x:Value|undefined)=>{
    if(contract.relationships.some(r=>r.resource===v.resource&&r.field===c.field))return Array.isArray(x)?x.map(person).join(', '):person(x);
    if(c.format==='date'&&typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)){
      const date=new Date(`${x}T00:00:00Z`);if(Number.isFinite(+date)&&date.toISOString().slice(0,10)===x)return date.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
    }
    return value(x);
  };
  const html: Record<'summary'|'list', string[]>={summary:[],list:[]};
  for(const v of contract.views){
    const records=viewRecords(current,v,actor);
    if(v.kind==='summary'&&!records.length)continue;
    html[v.kind].push(`<section class="panel ${v.kind}" data-resource="${esc(v.resource)}"><h2>${esc(v.label)}</h2>${records.length?records.map(([id,r])=>`<article data-record="${esc(id)}">${v.columns.map(c=>`<div class="datum"><span>${esc(c.label)}</span><strong data-field="${esc(c.field)}">${esc(format(v,c,r.values[c.field]))}</strong></div>`).join('')}</article>`).join(''):'<p class="empty">Nothing saved yet.</p>'}</section>`);
  }
  $('summaries').innerHTML=html.summary.join('');$('lists').innerHTML=html.list.join('');
  const rows=inboxFor(current,actor).filter(p=>p.status==='pending');
  $('inbox').innerHTML=rows.length?rows.map(p=>{
    const a=contract.actions[p.invocation.action];
    if(!a)throw Error(`Unknown pending action: ${p.invocation.action}`);
    const covered=p.requirements.every(r=>p.grants.some(g=>g.policyId===r.policyId));
    return `<article class="request" data-request="${esc(p.id)}"><div class="request-head"><strong>${esc(person(p.invocation.actor))}</strong><span class="badge">${p.stale?'Needs a new request':'Awaiting approval'}</span></div><h3>${esc(a.label)}</h3><dl>${a.fields.filter(f=>!f.binding).map(f=>`<div><dt>${esc(f.label)}</dt><dd>${esc(value(p.invocation.args[f.name]))}</dd></div>`).join('')}</dl><p>No changes have been made.${p.stale?' Something changed; send a new request.':''}</p>${p.requirements.map(r=>`<p class="muted">Approval: ${r.approvers.map(person).map(esc).join(', ')||'No eligible approver'}</p>${p.grants.some(g=>g.policyId===r.policyId)?'<p class="saved-grant">Approval saved</p>':r.approvers.includes(actor)?`<button data-grant="${esc(p.id)}" data-policy="${esc(r.policyId)}" ${busy?'disabled':''}>Save approval</button>`:''}`).join('')}${covered?`<button data-resume="${esc(p.id)}" ${busy?'disabled':''}>Complete request</button>`:''}</article>`;
  }).join(''):'<p class="empty">You’re all caught up. Requests waiting for you will appear here.</p>';
}
function showInitialViews(){
  const placeholders: Record<'summary'|'list',string[]>={summary:[],list:[]};
  for(const {index,label,strategy} of loadingPlan(contract)){
    const {placeholder}=loadingPresentation(strategy,{pending:true,failed:false,owned:false});
    if(!placeholder)continue;
    const message=esc(`Loading ${label}…`);
    const body=placeholder==='text'?message:placeholder==='icon'?'<span aria-hidden="true">◷</span>':'<span class="loading-bars" aria-hidden="true"></span>';
    const view=contract.views[index];if(!view)throw Error(`Missing loading view: ${index}`);
    placeholders[view.kind].push(`<section class="panel" role="status" aria-label="${message}" data-loading="${placeholder}">${body}</section>`);
  }
  $('summaries').innerHTML=placeholders.summary.join('');$('lists').innerHTML=placeholders.list.join('');
}
function updateLocks(){
  actorControl.disabled=busy;
  for(const el of document.querySelectorAll<HTMLButtonElement>('[data-grant], [data-resume]'))el.disabled=busy;
  for(const form of $('forms').querySelectorAll('form')){
    const locked=busy||submissions.has(key(actionFor(form)));
    for(const el of form.elements)if(el instanceof HTMLInputElement||el instanceof HTMLSelectElement||el instanceof HTMLButtonElement)el.disabled=locked||(el.type==='submit'&&form.dataset['invalid']==='true');
  }
  recovery.replaceChildren();
  for(const [k,s] of submissions)if(s.body.actor===actor){
    const p=document.createElement('p');p.textContent=`${contract.actions[s.body.action]?.label??s.body.action}: ${s.phase==='retryable'?'No receipt found.':s.phase==='unknown'?'Outcome unknown.':s.phase==='checking'?'Checking submission…':'Submitting…'}`;
    const controls=submissionControls(s);
    for(const [type,label] of [['check','Check submission'],['retry','Retry same submission']] as const)if(controls[type]){
      const b=document.createElement('button');b.textContent=label;b.disabled=busy;b.onclick=()=>sendSubmission(k,s,{type});p.append(' ',b);
    }
    recovery.append(p);
  }
}
async function preview(action:string){
  const token=++sequence,k=key(action);previews.set(k,token);
  const form=[...$('forms').querySelectorAll('form')].find(f=>f.dataset['action']===action);if(!form)return;
  try{const r=await client.preview({actor,action,args:getDraft(action)});if(previews.get(k)!==token||key(action)!==k)return;
    const names=r.requirements?.flatMap(r=>r.approvers).map(person);
    required(form,'[data-preview]',HTMLElement).textContent=r.status==='pending'?`Needs ${[...new Set(names)].join(', ')}’s approval. No changes yet.`:r.message??null;
    form.dataset['invalid']=String(r.status==='rejected');required(form,'button[type=submit]',HTMLButtonElement).disabled=busy||submissions.has(k)||r.status==='rejected';currentEvidence=r.evidence;if(!showSaved)showEvidence();
  }catch(e){if(previews.get(k)===token&&key(action)===k){required(form,'[data-preview]',HTMLElement).textContent=errorMessage(e);required(form,'button[type=submit]',HTMLButtonElement).disabled=true;}}
}
async function command(requestId:string,policyId?:string){
  if(busy)return;busy=true;updateLocks();
  try{const r=await (policyId===undefined?client.resume({actor,requestId}):client.grant({actor,requestId,policyId}));if(r.evidence){lastEvidence=r.evidence;showSaved=true;showEvidence();}if(r.snapshot)accept(r.snapshot);notice(policyId===undefined&&r.status==='rejected'?`Approval is saved, but completion failed. ${r.message}`:r.message,r.status==='rejected');}
  catch(e){notice(errorMessage(e),true);}finally{busy=false;updateLocks();for(const f of $('forms').querySelectorAll('form'))preview(actionFor(f));}
}
async function sendSubmission(k:string,previous:SubmissionState,event:SubmissionEvent){
  if(busy)return;
  const s=track(k,submissionStep(previous,event));busy=true;updateLocks();
  try{
    const {id,body}=s;
    if(!id||!body)throw Error('Missing saved submission.');
    const r=event.type==='check'?await client.reconcile({actor:body.actor,submissionId:id}):await client.execute({...body,submissionId:id});
    if(event.type==='check'&&r.status==='not-found'){track(k,submissionStep(s,{type:'missing'}));return;}
    track(k,submissionStep(s,{type:'found',result:r}));
    if(r.evidence){lastEvidence=r.evidence;showSaved=true;showEvidence();}
    if(r.snapshot)accept(r.snapshot);notice(r.message,r.status==='rejected');
  }catch(e){
    if(submissions.has(k))track(k,submissionStep(s,isNotSubmittedError(e)?{type:'invalid',message:e.message}:{type:'lost'}));
    notice(errorMessage(e),true);
  }finally{busy=false;updateLocks();for(const f of $('forms').querySelectorAll('form'))preview(actionFor(f));}
}
$('inbox').addEventListener('click',e=>{if(!(e.target instanceof Element))return;const grant=e.target.closest<HTMLButtonElement>('[data-grant]'),resume=e.target.closest<HTMLButtonElement>('[data-resume]');const grantId=grant?.dataset['grant'],policyId=grant?.dataset['policy'],resumeId=resume?.dataset['resume'];if(grantId&&policyId)command(grantId,policyId);if(resumeId)command(resumeId);});
function accept(next:ApplicationSnapshot){if(next.contractId!==contractId){notice('The declaration changed. Reload before continuing.',true);return;}if(!acceptsSnapshot(snapshot,next,contractId))return;snapshot=next;renderViews(next);const visible=Object.values(contract.actions).filter(a=>next.availability[actor]?.[a.id]).map(a=>a.id);if(JSON.stringify([...$('forms').querySelectorAll('form')].map(f=>f.dataset['action']))!==JSON.stringify(visible))renderForms(next);updateLocks();for(const f of $('forms').querySelectorAll('form'))preview(actionFor(f));}
actorControl.addEventListener('change',()=>{if(!snapshot)return;actor=actorControl.value;$('notice').hidden=true;renderForms(snapshot);renderViews(snapshot);updateLocks();for(const f of $('forms').querySelectorAll('form'))preview(actionFor(f));});
actorControl.disabled=true;showInitialViews();
try{accept(await client.snapshot());}catch(e){initialLoadError=true;$('summaries').replaceChildren();$('lists').replaceChildren();notice(`Could not load records. ${errorMessage(e)}`,true);}
const stream=new EventSource('/api/events');stream.addEventListener('open',()=>{$('connection').textContent='Live';});stream.addEventListener('error',()=>{$('connection').textContent='Reconnecting…';});stream.addEventListener('update',e=>{
  try{accept(decodeApplicationSnapshot(e.data));}
  catch(error){notice(`Could not load records. ${errorMessage(error)}`,true);return;}
  if(initialLoadError&&snapshot){initialLoadError=false;$('notice').hidden=true;}
});addEventListener('pagehide',()=>stream.close());
