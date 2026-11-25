import {errorMessage} from '../errors.ts';
import { createApp } from './core.ts';
import { describeChange } from './derive.ts';
import { decodeJsonValue, decodeStrictJson, encodeJson, encodeJsonPretty, LiveWorkspaceDocumentSchema } from '../adapters/effect/json.ts';
import type { runDerivedChecks } from './derive.ts';

declare const __liveWorkerSource: string;

const core = createApp();
const storageKey = 'relay.workspace.v1';
let view: Pick<typeof core, 'state' | 'model'> = core;
let previewStep: number | null = null;
let liveSelected: string | undefined;
let storageBlocked = false;
let saveStatus = 'Not saved yet · browser-local only.';
let savedRaw: string | null = null;
try {
  savedRaw = localStorage.getItem(storageKey);
  if (savedRaw !== null) {
    const result = core.restoreWorkspace(decodeStrictJson(LiveWorkspaceDocumentSchema,savedRaw));
    if (!result.ok) throw new Error(result.reason);
    saveStatus = 'Recovered saved workspace · this browser only.';
  }
} catch (error) {
  storageBlocked = savedRaw !== null;
  saveStatus = storageBlocked ? `Saved document could not be recovered: ${errorMessage(error)}. Original retained; export it, import a valid workspace, or explicitly reset. Automatic saving paused.` : `Storage unavailable: ${errorMessage(error)}. Changes remain in memory; export before leaving.`;
}
function persist() {
  if (storageBlocked) return;
  try {
    localStorage.setItem(storageKey, encodeJson(core.exportWorkspace(),LiveWorkspaceDocumentSchema));
    saveStatus = 'Saved in this browser · not synced or backed up.';
  } catch (error) {
    saveStatus = `Not saved: ${errorMessage(error)}. Changes remain in memory; export before leaving.`;
  }
}
const commentDrafts = new Map();
const toolDrafts = new Map();
const draftKey = () => JSON.stringify([actorId, selected]);
let search = '';
let unresolved = false;
let assigned = false;
let historyOpen = false;
let actorId = core.state.users[0]?.id || 'u1';
let selected: string | undefined = core.state.issues[0]?.id;
let labOpen = false;
let feedback = 'Actor switching simulates local roles and inboxes; it is not login or shared access.';
let failed = false;
let toolName = 'comment';
let toolOutput = '';
let checkOutput: ReturnType<typeof core.check> | null = null;
let derivedOutput: ReturnType<typeof runDerivedChecks> | null = null;
const ruleDrafts = new Map();
let derivedJob: {worker: Worker; url: string; timer: ReturnType<typeof setTimeout>} | null = null;
let derivedGeneration = 0;
function stopDerived() {
  derivedGeneration++;
  if (derivedJob) {
    derivedJob.worker.terminate();
    URL.revokeObjectURL(derivedJob.url);
    clearTimeout(derivedJob.timer);
    derivedJob=null;
  }
}
function invalidateChecks() { stopDerived(); checkOutput=null; derivedOutput=null; }
function derivedUnknown(reason: string): ReturnType<typeof runDerivedChecks> {
  return {result:'unknown',revision:core.model.revision,scope:'Worker execution did not establish declaration-check evidence.',cases:[{id:'worker-execution',action:null,actorId:null,expected:{completed:true},actual:null,status:'unknown',reason}]};
}
function startDerived() {
  if (previewStep !== null) return;
  stopDerived(); derivedOutput=null; labOpen=true;
  const id=derivedGeneration;
  const state=core.state, model=core.model;
  let worker: Worker | undefined, url: string | undefined;
  try {
    if (typeof Worker !== 'function') throw Error('Web Worker unavailable; checks were not run. No synchronous fallback.');
    url=URL.createObjectURL(new Blob([__liveWorkerSource],{type:'text/javascript'}));
    worker=new Worker(url);
    const finish=(report: ReturnType<typeof runDerivedChecks>)=>{
      if (id !== derivedGeneration) return;
      if (previewStep !== null || core.state !== state || core.model !== model) {
        stopDerived(); derivedOutput=null; render(); return;
      }
      stopDerived(); derivedOutput=report; render();
    };
    derivedJob={worker,url,timer:setTimeout(()=>finish(derivedUnknown('Worker time budget exceeded (60 seconds); result unknown.')),60000)};
    worker.onmessage=({data})=>{if(data.id===id)finish(data.report ?? derivedUnknown(data.error || 'Worker returned no result.'))};
    worker.onerror=e=>{e.preventDefault();finish(derivedUnknown(`Worker failed: ${e.message || 'resource or execution error'}`))};
    worker.onmessageerror=()=>finish(derivedUnknown('Worker result could not be decoded.'));
    worker.postMessage({id,workspace:core.exportWorkspace()});
  } catch(error) {
    stopDerived(); worker?.terminate(); if(url)URL.revokeObjectURL(url);
    derivedOutput=derivedUnknown(String(errorMessage(error) ?? error));
  }
  render();
}
function requiredElement<T extends Element>(selector: string, kind: new () => T, parent: ParentNode = document): T {
  const element = parent.querySelector(selector);
  if (!(element instanceof kind)) throw new Error(`Missing ${selector}`);
  return element;
}
const root = requiredElement('#app', HTMLDivElement);
const modal = requiredElement('#modal', HTMLDialogElement);
const escapes: Record<string, string> = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const esc = (value:unknown) => String(value ?? '').replace(/[&<>"']/g, c => escapes[c] ?? c);
const user = (id:string|null|undefined) => view.state.users.find(u => u.id === id);
const name = (id:string|null|undefined) => user(id)?.name || 'Unassigned';
const availability = (action:unknown,args:unknown) => previewStep === null ? core.explainAction(action,args,actorId) : {available:false,category:'preview',reason:'Current availability explanations are disabled in read-only history. Return to live first.'};
const allowed = (action:string) => {const e=availability(action,action==='create'?{}:{issueId:selected});return e.available || e.category==='missing-input'};
const availabilityDetails = (e:ReturnType<typeof availability>) => `<p>${esc(e.reason)}</p><details><summary>Availability details</summary><pre>${esc(JSON.stringify(e,null,2))}</pre></details>`;
const unavailableButton = (action:string) => previewStep === null ? `<button class="link" data-unavailable="${action}">Why unavailable<span class="sr-only"> · ${esc(label(action))}</span></button>` : '';
function formArgs(form: HTMLFormElement) {
  const args: Record<string, FormDataEntryValue | null | undefined>=Object.fromEntries(new FormData(form));
  if(form.dataset['action']!=='create') args['issueId']=selected;
  if(form.dataset['action']==='assign' && args['assignee']==='') args['assignee']=null;
  return args;
}
function updateFormAvailability(form: HTMLFormElement) {
  const e=availability(form.dataset['action'],formArgs(form));
  requiredElement('.primary', HTMLButtonElement, form).disabled=!e.available;
  requiredElement('.availability', HTMLElement, form).innerHTML=e.available ? '' : `<p>${esc(e.reason)}</p><details><summary>Why unavailable</summary><pre>${esc(JSON.stringify(e,null,2))}</pre></details>`;
}
const label = (action:unknown) => typeof action==='string'?(view.model.actions[action]?.label||action):String(action);
const issue = () => view.state.issues.find(i => i.id === selected);
const option = (value:unknown,text:unknown,current:unknown) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(text)}</option>`;
const whyButton = (eventId:string) => `<button class="link" data-why="${esc(eventId)}">Why<span class="sr-only"> event ${esc(eventId)}</span></button>`;
function fields(action: string, values: Record<string, unknown> = {}, omit: string[] = []) {
  const schema=view.model.actions[action]?.inputs;
  if(!schema)throw Error(`Unknown action: ${action}`);
  return Object.entries(schema.properties).filter(([key]) => !omit.includes(key)).map(([key, def]) => {
    const titles: Record<string, string> = {issueId:'Issue',body:'Comment',assignee:'Assign to'};
    const title = def.title || def.label || titles[key] || key.charAt(0).toUpperCase()+key.slice(1);
    const required = schema.required?.includes(key) ? 'required' : '';
    let input;
    if (key === 'assignee') input = `<select name="${key}">${option('', 'Unassigned', values[key] ?? '')}${view.state.users.map(u=>option(u.id,u.name,values[key])).join('')}</select>`;
    else if (def.enum) input = `<select name="${key}" ${required}>${def.enum.map(v=>option(v,v,values[key])).join('')}</select>`;
    else if (['body','description'].includes(key)) input = `<textarea name="${key}" ${required} ${def.maxLength ? `maxlength="${def.maxLength}"` : ''}>${esc(values[key] || '')}</textarea>`;
    else input = `<input name="${key}" value="${esc(values[key] || '')}" ${required} ${def.maxLength ? `maxlength="${def.maxLength}"` : ''}>`;
    return `<label>${esc(title)}${!required ? ' <small>Optional</small>' : ''}${input}</label>`;
  }).join('');
}
function actionForm(action: string, values: Record<string, unknown> = {}, omit: string[] = []) {
  return `<form class="action-form" data-action="${action}">${fields(action, values, omit)}<div class="form-actions"><button class="primary">${esc(label(action))}</button></div><div class="availability"></div></form>`;
}
function renderDetail() {
  const i = issue();
  if (!i) return '<h1>Select an issue</h1><p class="empty">Create an issue to start the conversation.</p>';
  const events = view.state.events.filter(e=>e.issueId===i.id).slice().reverse();
  return `<div class="issue-top"><span class="mono muted">${esc(i.id)}</span><span class="badge">${esc(i.status)}</span><span class="end"></span>${['watch',i.status==='resolved'?'reopen':'resolve'].map(a=>`<span><button data-run="${a}" ${allowed(a)?'':'disabled'}>${a==='watch' && i.watchers.includes(actorId)?'Unwatch':esc(label(a))}</button>${!allowed(a)?unavailableButton(a):''}</span>`).join('')}</div>
    <h1>${esc(i.title)}</h1><p class="description">${esc(i.description || 'No description yet.')}</p>
    <div class="facts"><div class="fact"><small>Assignee</small><button data-editor="assign" ${allowed('assign')?'':'disabled'}>${esc(name(i.assignee))} ↗</button>${!allowed('assign')?unavailableButton('assign'):''}</div><div class="fact"><small>Opened by</small><span>${esc(name(i.opener))}</span></div><div class="fact"><small>Priority</small><span>${esc(i.priority)}</span></div><div class="fact"><small>Watching</small><span>${i.watchers.map(name).map(esc).join(', ') || 'Nobody yet'}</span></div></div>
    <div class="section-title"><h2>Conversation</h2><small>${i.comments.length} comments</small></div>
    ${i.comments.length ? i.comments.map(c=>`<article class="comment"><div class="comment-head"><strong>${esc(name(c.author))}</strong><small>${esc(c.id)}</small></div><p>${esc(c.body)}</p></article>`).join('') : '<p class="empty">Add context, a reproduction, or the next step.</p>'}
    ${previewStep === null ? actionForm('comment',{body:commentDrafts.get(draftKey()) || ''},['issueId']) : '<p class="scope">Read-only history. Current availability explanations are disabled here. Return to live to act or continue your draft.</p>'}
    <details class="activity"><summary>Activity & explanations · ${events.length}</summary>${events.map(e=>`<div class="event-row"><span>${esc(name(e.actorId))} · ${esc(e.action)}</span><small>r${e.revision}</small>${whyButton(e.id)}</div>`).join('')}</details>`;
}
function ruleEditor(action:string) {
  const d = ruleDrafts.get(action) || core.model.actions[action];
  return `<form class="rule-row" data-rule="${action}"><h3>${esc(label(action))} <small>(${action})</small></h3><fieldset><legend>Allowed roles</legend>${['member','lead'].map(r=>`<label><input type="checkbox" name="allowedRoles" value="${r}" ${d.allowedRoles.includes(r)?'checked':''}>${r}</label>`).join('')}</fieldset><fieldset><legend>Notify through relationships</legend>${['opener','assignee','watchers'].map(p=>`<label><input type="checkbox" name="notify" value="${p}" ${d.notify.includes(p)?'checked':''}>${p}</label>`).join('')}</fieldset><div class="rule-impact" role="status">${ruleImpact(action,d)}</div><div><button>Apply ${action} rule</button></div></form>`;
}
function ruleImpact(action:unknown,patch:{allowedRoles:readonly unknown[];notify:readonly unknown[]}) {
  const diff=describeChange(core.model,action,{allowedRoles:patch.allowedRoles,notify:patch.notify});
  if (!diff.ok) return `<p>Cannot apply: ${esc(diff.reason)}</p>`;
  const changes=[...(diff.roleChanges || []).map(c=>`${c.after ? 'Added' : 'Removed'} role: ${c.role}`),...(diff.routes?.added || []).map(p=>`Added route: ${p}`),...(diff.routes?.removed || []).map(p=>`Removed route: ${p}`)];
  return `<strong>Preview · ${esc(action)} · against r${core.model.revision}</strong><p>${changes.length ? changes.map(esc).join('<br>') : diff.unchanged ? 'No declaration changes (no-op).' : 'Role/route ordering changed; no membership changes.'}</p><p class="scope">Exact declaration diff only. Roles govern future workspace/tool access; routes govern relationship-matched recipients (actor excluded, duplicates merged). Not full reachable behavior or changes to past inbox items.</p>`;
}
function renderDerivedChecks() {
  if (derivedJob) return '<p id="derived-output" role="status">Running declaration checks in an isolated worker…</p>';
  if (!derivedOutput) return '<p id="derived-output" role="status">Not run for this live workspace. Results clear when state or model changes.</p>';
  const counts={passed:0,failed:0,unknown:0,skipped:0};
  for (const c of derivedOutput.cases) counts[c.status]=(counts[c.status] || 0)+1;
  const cell=(value:unknown)=>esc(typeof value==='string' ? value : JSON.stringify(value) ?? '—');
  return `<div id="derived-output"><p role="status"><strong>${esc(derivedOutput.result)} · r${esc(derivedOutput.revision)}</strong> · ${derivedOutput.cases.length} cases · ${Object.entries(counts).map(([k,v])=>`${v} ${k}`).join(' · ')}</p><p class="scope">${esc(derivedOutput.scope)}</p><div class="check-table-wrap" tabindex="0" role="region" aria-label="Declaration check cases"><table><caption>Actual isolated dispatch cases</caption><thead><tr>${['Case','Action','Actor','Expected','Actual','Status / reason'].map(s=>`<th scope="col">${s}</th>`).join('')}</tr></thead><tbody>${derivedOutput.cases.map(c=>`<tr data-case="${esc(c.id)}"><td>${cell(c.id)}</td><td>${cell(c.action)}</td><td>${cell(c.actorId)}</td><td>${cell(c.expected)}</td><td>${cell(c.actual)}</td><td>${cell(c.status)}${c.reason ? `<br>${esc(c.reason)}` : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
}
function renderLab() {
  const tools=core.tools();
  return `<details class="lab" ${labOpen?'open':''}><summary>Development lab · declaration r${core.model.revision}</summary><p class="scope">Local development controls, not a production permission. Rule changes affect future actions; historical explanations retain their captured revision.</p><div class="lab-layout"><section><h2>Action rules</h2>${['comment','resolve'].map(ruleEditor).join('')}</section><section><h2>Generated tools</h2><p class="scope">Editable arguments enter the same dispatch as the workspace. Policy is enforced even when called directly.</p><div class="tool-fields"><label>Tool<select id="tool-name">${Object.keys(core.model.actions).map(a=>option(a,label(a),toolName)).join('')}</select></label><details><summary>Current descriptors · r${core.model.revision}</summary><pre id="tool-descriptors">${esc(JSON.stringify(tools,null,2))}</pre></details><form id="tool-form" class="tool-fields"><label>JSON arguments<textarea id="tool-args" class="mono" spellcheck="false">${esc(JSON.stringify(defaultArgs(toolName),null,2))}</textarea></label><div><button>Invoke tool</button></div></form><pre id="tool-output" role="status">${esc(toolOutput)}</pre></div><h2>State checks</h2><p class="scope">Executable invariants over this in-memory state only. Not a proof, browser security boundary, or distributed delivery guarantee.</p><button id="run-checks">Run current-state checks</button><pre id="check-output">${checkOutput ? esc(JSON.stringify(checkOutput,null,2)) : 'Not run in this session.'}</pre></section></div></details>`;
}
function defaultArgs(a:string) {
  const defaults:Record<string,Record<string,unknown>>={create:{title:'Keyboard focus is lost after saving',description:'Keep focus on the updated issue.',priority:'normal'},assign:{issueId:selected,assignee:core.state.users[1]?.id},comment:{issueId:selected,body:'Reproduced in the keyboard flow.'},resolve:{issueId:selected},reopen:{issueId:selected},watch:{issueId:selected}}; return defaults[a]??{};
}
function render() {
  const active=document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.selectionStart !== null && active.selectionEnd !== null
    ? {start: active.selectionStart, end: active.selectionEnd}
    : null;
  const focusIssue = active?.dataset?.['issue'];
  const focusId=active?.id;
  const focusRule=active?.closest<HTMLFormElement>('[data-rule]')?.dataset['rule'];
  const focusAction=active?.closest<HTMLFormElement>('form[data-action]')?.dataset['action'];
  const focusRun=active?.dataset?.['run'];
  const focusEditor=active?.dataset?.['editor'];
  const notices=view.state.notifications.filter(n=>n.recipient===actorId).slice().reverse();
  root.innerHTML=`<header><strong>Relay<span style="color:#83a9e7"> /</span></strong><span class="divider"></span><small>Product engineering</small><label>Working as<select id="actor" aria-label="Working as">${view.state.users.map(u=>option(u.id,`${u.name} · ${u.role}`,actorId)).join('')}</select></label></header>
    <main><div class="toolbar"><h1>Issues</h1><small>${view.state.issues.filter(i=>i.status==='open').length} open</small><span class="spacer"></span><button id="new-issue" class="primary" ${allowed('create')?'':'disabled'}>${esc(label('create'))}</button><button id="reset" ${previewStep !== null ? 'disabled' : ''}>Reset</button></div>
    <p class="scope actor-note">Local-only actor simulation · not login, authentication, or shared access.</p>
    <div class="feedback ${failed?'error':''}" role="status">${esc(feedback)}</div>
    <div class="workspace"><nav class="queue" aria-label="Issue queue"></nav><section class="detail" aria-label="Issue detail">${renderDetail()}</section>
    <aside class="inbox" aria-label="Recipient inbox"><h2>${previewStep !== null ? 'Historical inbox' : 'Inbox'} <small>${notices.length}</small></h2><small>For ${esc(name(actorId))} · ${previewStep !== null ? 'captured' : 'live'} related updates</small><div class="notices">${notices.map(n=>`<article class="notice"><strong>${esc(view.state.issues.find(i=>i.id===n.issueId)?.title || n.issueId)}</strong><span>${esc(n.action)} · ${esc(n.issueId)}</span><br><small>Related through ${n.reasons.map(esc).join(' + ')}</small><br>${whyButton(n.eventId)}</article>`).join('') || '<p class="empty">Nothing for you yet.<br>Assignment, watching, and action rules determine what arrives here.</p>'}</div></aside></div>
    ${previewStep !== null ? '<p class="scope lab">Development tools are unavailable in read-only preview.</p>' : renderLab()}</main>`;
  if (previewStep === null) requiredElement('.lab', HTMLDetailsElement, root).insertAdjacentHTML('beforeend', `<section class="derived-checks"><h2>Declaration-derived checks</h2><p class="scope">Cases generated from the applied live declaration and workspace, executed in isolated runtimes. Not the current-state audit, historic Lean evidence, a proof, or exhaustive property testing. Unapplied checkbox drafts are not checked.</p><button id="run-derived-checks">Run declaration checks</button>${renderDerivedChecks()}</section>`);
  requiredElement('.toolbar', HTMLElement, root).insertAdjacentHTML('afterend', `<div class="local-controls"><p id="save-status" role="status">${esc(saveStatus)}</p><div class="workspace-actions"><button id="export-workspace">Export JSON</button><label class="import-label">Import JSON<input id="import-workspace" type="file" accept="application/json,.json" ${previewStep !== null ? 'disabled' : ''}></label>${storageBlocked ? '<button id="export-original">Export unreadable saved document</button>' : ''}</div><details id="history" ${historyOpen ? 'open' : ''}><summary>Workspace history · ${core.exportWorkspace().journal.length} steps</summary><div class="history-controls"><label>Preview step<input id="history-step" type="number" min="0" max="${core.exportWorkspace().journal.length}" value="${previewStep ?? core.exportWorkspace().journal.length}"></label><button id="preview">View read-only</button><button id="return-live" ${previewStep === null ? 'disabled' : ''}>Return to live</button></div><p class="scope">Local command reconstruction, not external delivery evidence.</p></details>${previewStep !== null ? `<p class="preview-banner" role="status">Read-only preview · step ${previewStep}. Live changes and drafts are untouched.</p>` : ''}</div>`);
  const queue = requiredElement('.queue', HTMLElement, root);
  const visible = view.state.issues.filter(i => (!unresolved || i.status !== 'resolved') && (!assigned || i.assignee === actorId) && `${i.id} ${i.title} ${i.description || ''}`.toLowerCase().includes(search.toLowerCase()));
  queue.innerHTML = `<div class="queue-head"><h2>Issues</h2><small>${visible.length} of ${view.state.issues.length}</small></div><div class="filters"><label>Search issues<input id="issue-search" type="search" value="${esc(search)}" placeholder="Title, ID, description"></label><label><input id="unresolved" type="checkbox" ${unresolved ? 'checked' : ''}>Unresolved</label><label><input id="assigned" type="checkbox" ${assigned ? 'checked' : ''}>Assigned to me</label></div>${visible.map(i=>`<button class="issue-row" data-issue="${esc(i.id)}" aria-current="${i.id===selected}"><div class="row-meta"><span class="status ${esc(i.status)}" aria-hidden="true"></span><span class="mono">${esc(i.id)}</span><span>${esc(i.status)}</span></div><strong>${esc(i.title)}</strong><div class="row-meta">${esc(name(i.assignee))} · ${esc(i.priority)}</div></button>`).join('') || '<p class="empty">No matching issues. Adjust your filters.</p>'}`;
  if (previewStep === null) {
    requiredElement('#tool-args', HTMLTextAreaElement, root).value = toolDrafts.get(toolName) ?? JSON.stringify(defaultArgs(toolName),null,2);
  }
  bind();
  root.querySelectorAll<HTMLFormElement>('form[data-action]').forEach(updateFormAvailability);
  if (previewStep === null) updateToolAvailability();
  if (!allowed('create') && previewStep === null) requiredElement('#new-issue', HTMLButtonElement, root).insertAdjacentHTML('afterend',unavailableButton('create'));
  root.querySelectorAll<HTMLButtonElement>('[data-unavailable]').forEach(b=>b.onclick=()=>showUnavailable(b.dataset['unavailable']));
  const target=(focusId && root.querySelector<HTMLElement>(`#${focusId}`)) || (focusRule && root.querySelector<HTMLElement>(`[data-rule="${focusRule}"] button`)) || (focusAction && root.querySelector<HTMLElement>(`form[data-action="${focusAction}"] textarea`)) || (focusRun && root.querySelector<HTMLElement>(`[data-run="${focusRun}"]`)) || (focusEditor && root.querySelector<HTMLElement>(`[data-editor="${focusEditor}"]`));
  const restored = target || (focusIssue && root.querySelector<HTMLElement>(`[data-issue="${focusIssue}"]`));
  if (restored) restored.focus({preventScroll:true});
  if (selection && (restored instanceof HTMLInputElement || restored instanceof HTMLTextAreaElement) && !['number','checkbox'].includes(restored.type)) {
    restored.setSelectionRange(selection.start, selection.end);
  }
}
function commit(action:unknown,args:unknown) {
  if (previewStep !== null) return {ok:false,reason:'Read-only preview; return to live first.'};
  const result=core.dispatch(action,args,actorId);
   if(result.ok) invalidateChecks();
  failed=!result.ok;
  feedback=result.ok ? `${label(action)} · applied locally as ${name(actorId)}. Declaration r${core.model.revision}.` : `Not applied: ${result.reason}`;
  if (result.ok) persist();
  if(result.ok && action==='create') selected=result.value?.id || result.event?.issueId || core.state.issues.at(-1)?.id;
  return result;
}
function showEditor(action:string|undefined) {
  if (previewStep !== null || action===undefined) return;
  modal.innerHTML=`<div class="dialog-head"><h2 id="modal-title">${esc(label(action))}</h2><button data-close aria-label="Close dialog">×</button></div>${actionForm(action,action==='assign'?{assignee:issue()?.assignee}:{},action==='create'?[]:['issueId'])}`;
  requiredElement('[data-close]', HTMLButtonElement, modal).onclick=()=>modal.close();
  const form=requiredElement('form', HTMLFormElement, modal);
  form.oninput=()=>updateFormAvailability(form);
  form.onchange=()=>updateFormAvailability(form);
  updateFormAvailability(form);
  form.onsubmit=e=>{e.preventDefault();const result=commit(action,formArgs(form));if(result.ok)modal.close();else {let p=modal.querySelector('.dialog-error');if(!p){p=document.createElement('p');p.className='dialog-error fail';modal.append(p)}p.textContent=result.reason ?? ''}render()};
  modal.showModal();
}
function showWhy(eventId:string|undefined) {
  const e=view.state.events.find(e=>e.id===eventId);
  const data=previewStep === null ? core.explain(eventId) : e;
  modal.innerHTML=`<div class="dialog-head"><h2 id="modal-title">Why this update?</h2><button data-close aria-label="Close dialog">×</button></div><div class="why-flow"><p><strong>${esc(name(e?.actorId))}</strong> invoked <strong>${esc(e?.action)}</strong> on ${esc(e?.issueId)}.</p><p>Captured declaration <strong>r${esc(e?.revision)}</strong> — not today's rule.</p><p>The captured policy allowed <strong>${esc(e?.actor?.role)}</strong>. Changed: ${e?.changes?.map(c=>esc(c.field)).join(', ') || 'none'}.</p></div><h3>Who received it, and through which relationship?</h3>${e?.recipients?.length ? e.recipients.map(r=>`<div class="notice"><strong>${esc(name(r.recipient))}</strong><span class="mono">${esc(e.issueId)} → ${r.reasons.map(esc).join(' + ')} → ${esc(r.recipient)}</span></div>`).join('') : '<p class="empty">No recipients matched the captured routing rule.</p>'}<p class="scope">The actor is excluded; overlapping paths produce one inbox item per recipient. These are event-time relationships, not a recalculation using today’s rule.</p><details><summary>Stored event JSON</summary><pre id="why-data">${esc(JSON.stringify(data,null,2))}</pre></details><p class="scope">Historical local execution record. No external delivery or authentication is asserted.</p>`;
  requiredElement('[data-close]', HTMLButtonElement, modal).onclick=()=>modal.close();modal.showModal();
}
function showUnavailable(action:string|undefined) {
  if (previewStep !== null) return;
  const e=availability(action,action==='create'?{}:{issueId:selected});
  modal.innerHTML=`<div class="dialog-head"><h2 id="modal-title">Why unavailable · ${esc(label(action))}</h2><button data-close aria-label="Close dialog">×</button></div>${availabilityDetails(e)}<p class="scope">Current pre-execution query · not a historical event or an execution guarantee.</p>`;
  requiredElement('[data-close]', HTMLButtonElement, modal).onclick=()=>modal.close();modal.showModal();
}
function updateToolAvailability() {
  const form=requiredElement('#tool-form', HTMLFormElement, root);
  let panel=form.querySelector('.availability');
  if(!panel){panel=document.createElement('div');panel.className='availability';form.append(panel)}
  try {const e=availability(toolName,decodeJsonValue(requiredElement('#tool-args', HTMLTextAreaElement, root).value));panel.innerHTML=`<strong>${e.available?'Available for current inputs':'Why unavailable'}</strong>${availabilityDetails(e)}`}
  catch {panel.textContent='Why unavailable: enter valid JSON arguments. No policy or precondition result is claimed.'}
}
function bind() {
  const actor = requiredElement('#actor', HTMLSelectElement, root);
  actor.onchange=()=>{actorId=actor.value;feedback=`Working as ${name(actorId)}. Actions and inbox updated.`;failed=false;render()};
  requiredElement('#new-issue', HTMLButtonElement, root).onclick=()=>showEditor('create');
  requiredElement('#reset', HTMLButtonElement, root).onclick=()=>{
    if (previewStep !== null) return;
    modal.innerHTML='<div class="dialog-head"><h2 id="modal-title">Reset local workspace?</h2><button data-close aria-label="Close dialog">×</button></div><p class="scope">Replace the saved document and current workspace with the two seeded issues. Export first to keep a copy. Unsent drafts will also be cleared.</p><button id="confirm-reset">Clear persisted workspace and reset</button>';
    requiredElement('[data-close]', HTMLButtonElement, modal).onclick=()=>modal.close();
    requiredElement('#confirm-reset', HTMLButtonElement, modal).onclick=()=>{
      if (previewStep !== null) return;
      const result=core.restoreWorkspace(createApp().exportWorkspace());
      if (!result.ok) return;
      storageBlocked=false; savedRaw=null; commentDrafts.clear(); toolDrafts.clear();ruleDrafts.clear();invalidateChecks();
      selected=core.state.issues[0]?.id; search='';unresolved=false;assigned=false;checkOutput=null;toolOutput='';
      persist();feedback='Workspace explicitly reset to seed.';failed=false;modal.close();render();
    };
    modal.showModal();
  };
  requiredElement('#export-workspace', HTMLButtonElement, root).onclick=()=>download(encodeJsonPretty(core.exportWorkspace(),LiveWorkspaceDocumentSchema),'relay-workspace.json');
  root.querySelector('#export-original')?.addEventListener('click',()=>{if(savedRaw !== null) download(savedRaw,'relay-unreadable-workspace.json')});
  const importInput = requiredElement('#import-workspace', HTMLInputElement, root);
  importInput.onchange=async ()=>{
    const file = importInput.files?.[0];
    if (previewStep !== null || !file) return;
    try {
      const doc=decodeStrictJson(LiveWorkspaceDocumentSchema,await file.text());
      if (previewStep !== null) throw new Error('Return to live before importing.');
      const result=core.restoreWorkspace(doc);
      if (!result.ok) throw new Error(result.reason);
      storageBlocked=false;savedRaw=null;selected=core.state.issues[0]?.id;invalidateChecks();ruleDrafts.clear();
      persist();feedback='Imported workspace after core validation.';failed=false;
    } catch(error) {feedback=`Import rejected; workspace unchanged: ${errorMessage(error)}`;failed=true}
    render();
  };
  const history = requiredElement('#history', HTMLDetailsElement, root);
  history.ontoggle=()=>{historyOpen=history.open};
  requiredElement('#preview', HTMLButtonElement, root).onclick=()=>{
    const n=Number(requiredElement('#history-step', HTMLInputElement, root).value);
    const result=core.previewWorkspace(n);
    if (!result.ok) {feedback=result.reason;failed=true;render();return}
    if (previewStep === null) liveSelected=selected;
    view=result;previewStep=n;historyOpen=true;invalidateChecks();
    if (!issue()) selected=view.state.issues[0]?.id;
    feedback='History preview is read-only. Return to live to make changes.';failed=false;render();
  };
  requiredElement('#return-live', HTMLButtonElement, root).onclick=()=>{view=core;previewStep=null;selected=liveSelected;feedback='Returned to live workspace.';render()};
  const searchInput = requiredElement('#issue-search', HTMLInputElement, root);
  searchInput.oninput=()=>{search=searchInput.value;render()};
  const unresolvedInput = requiredElement('#unresolved', HTMLInputElement, root);
  unresolvedInput.onchange=()=>{unresolved=unresolvedInput.checked;render()};
  const assignedInput = requiredElement('#assigned', HTMLInputElement, root);
  assignedInput.onchange=()=>{assigned=assignedInput.checked;render()};
  requiredElement('.queue', HTMLElement, root).onkeydown=e=>{
    if (!(e.target instanceof HTMLButtonElement) || !e.target.matches('[data-issue]') || !['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
    e.preventDefault();const rows=[...root.querySelectorAll<HTMLButtonElement>('[data-issue]')];const index=rows.indexOf(e.target);
    const next=e.key==='Home'?0:e.key==='End'?rows.length-1:Math.max(0,Math.min(rows.length-1,index+(e.key==='ArrowDown'?1:-1)));
    rows[next]?.focus();
  };
  root.querySelectorAll<HTMLButtonElement>('[data-issue]').forEach(b=>b.onclick=()=>{selected=b.dataset['issue'];render()});
  root.querySelectorAll<HTMLButtonElement>('[data-editor]').forEach(b=>b.onclick=()=>showEditor(b.dataset['editor']));
  root.querySelectorAll<HTMLButtonElement>('[data-run]').forEach(b=>b.onclick=()=>{commit(b.dataset['run'],{issueId:selected});render()});
  root.querySelectorAll<HTMLButtonElement>('[data-why]').forEach(b=>b.onclick=()=>showWhy(b.dataset['why']));
  root.querySelectorAll<HTMLFormElement>('form[data-action]').forEach(f=>{
    f.addEventListener('input',()=>updateFormAvailability(f));
    f.addEventListener('change',()=>updateFormAvailability(f));
    const body = f.querySelector<HTMLTextAreaElement>('textarea[name=body]');
    body?.addEventListener('input',()=>commentDrafts.set(draftKey(),body.value));
    f.onsubmit=e=>{e.preventDefault();const result=commit(f.dataset['action'],{...Object.fromEntries(new FormData(f)),issueId:selected});if(result.ok && f.dataset['action']==='comment')commentDrafts.delete(draftKey());render()};
  });
  if (previewStep !== null) return;
  const lab = requiredElement('.lab', HTMLDetailsElement, root);
  lab.ontoggle=()=>{labOpen=lab.open};
  root.querySelectorAll<HTMLFormElement>('[data-rule]').forEach(f=>{
    const patch=()=>{const data=new FormData(f);return {allowedRoles:data.getAll('allowedRoles'),notify:data.getAll('notify')}};
    f.onchange=()=>{ruleDrafts.set(f.dataset['rule'],patch());requiredElement('.rule-impact', HTMLElement, f).innerHTML=ruleImpact(f.dataset['rule'],patch())};
    f.onsubmit=e=>{e.preventDefault();if(previewStep!==null)return;const result=core.setRule(f.dataset['rule'],patch());if(result.ok){invalidateChecks();ruleDrafts.delete(f.dataset['rule']);persist()}failed=!result.ok;feedback=result.ok?`${f.dataset['rule']} rule updated to r${core.model.revision}. Future actions use this declaration; past records are unchanged.`:result.reason;labOpen=true;render()};
  });
   const toolArgs = requiredElement('#tool-args', HTMLTextAreaElement, root);
   const toolSelect = requiredElement('#tool-name', HTMLSelectElement, root);
   toolArgs.oninput=()=>{toolDrafts.set(toolName,toolArgs.value);updateToolAvailability()};
   toolSelect.onchange=()=>{toolName=toolSelect.value;toolArgs.value=toolDrafts.get(toolName) ?? JSON.stringify(defaultArgs(toolName),null,2);updateToolAvailability()};
  requiredElement('#tool-form', HTMLFormElement, root).onsubmit=e=>{e.preventDefault();try{const args=decodeJsonValue(requiredElement('#tool-args', HTMLTextAreaElement, root).value);toolOutput=JSON.stringify(commit(toolName,args),null,2)}catch(error){failed=true;feedback='Invalid JSON: '+errorMessage(error);toolOutput=feedback}labOpen=true;render()};
  requiredElement('#run-checks', HTMLButtonElement, root).onclick=()=>{checkOutput=core.check();labOpen=true;render()};
   requiredElement('#run-derived-checks', HTMLButtonElement, root).disabled=!!derivedJob;
   requiredElement('#run-derived-checks', HTMLButtonElement, root).onclick=startDerived;
   if (derivedJob) {
     requiredElement('#run-derived-checks', HTMLButtonElement, root).insertAdjacentHTML('afterend','<button id="cancel-derived-checks">Cancel declaration checks</button>');
     requiredElement('#cancel-derived-checks', HTMLButtonElement, root).onclick=()=>{stopDerived();derivedOutput=derivedUnknown('Cancelled; no completed result.');render()};
   }
}
function download(text:string,filename:string) {
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=filename;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
render();
// Inspectable for browser assertions, never an alternative execution path.
type LiveWorkspace = {core: typeof core; readonly selected: string | undefined; showWhy: typeof showWhy};
declare global {
  interface Window {
    liveWorkspace: LiveWorkspace;
  }
}
window.liveWorkspace = {core, get selected(){return selected}, showWhy};
