import type {ApprovalRequest,FieldSchema,Grant,RecordSnapshot,State,Value} from '../semantic/v2/types.ts';

function $(id:string) {
  const element=document.getElementById(id);
  if(!element)throw Error(`Missing workspace element: ${id}`);
  return element;
}
function control<T extends HTMLElement>(id:string,kind:new()=>T):T {
  const element=$(id);
  if(!(element instanceof kind))throw Error(`Unexpected workspace control: ${id}`);
  return element;
}
const profileInput=control('profile',HTMLSelectElement),actorInput=control('actor',HTMLSelectElement);
const actionInput=control('action',HTMLSelectElement),clockInput=control('clock',HTMLInputElement);
const resumeClock=control('resume-clock',HTMLInputElement),toolInput=control('tool-json',HTMLTextAreaElement);
const executeJSON=control('execute-json',HTMLButtonElement);
type Snapshot = {
  state:State;profile:'v1'|'v2';sequence:number;scope:unknown;
  tools:{name:string;inputs:Record<string,FieldSchema>}[];
  pending?:{status:'pending'|'consumed';invocationId:string;request:ApprovalRequest;grants:Grant[];resumeId:string|null}[];
  events?:{sequence:number;eventId:string;event:{type?:string;kind?:string}}[];
};
const entities:Record<string,string>={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const esc = (value:unknown) => String(value ?? '').replace(/[&<>"']/g, c => entities[c]);
const json = value => JSON.stringify(value, null, 2);
let snapshot:Snapshot|undefined, stream:EventSource|undefined, generation = 0, requestSerial = 0, busy = false;
const drafts = new Map<string,{fields:Record<string,string>;clock:string;tool:string}>();
const context = () => ({profile: profileInput.value, actor: actorInput.value});
const key = () => `${profileInput.value}/${actorInput.value}/${actionInput.value}`;
const id = () => `cmd-${crypto.randomUUID()}`;
const inputs=()=>document.querySelectorAll<HTMLInputElement>('input[data-input]');
function saveDraft() {
  if(actionInput.value)drafts.set(key(),{fields:Object.fromEntries([...inputs()].flatMap(el=>el.dataset['input']===undefined?[]:[[el.dataset['input'],el.value]])),clock:clockInput.value,tool:toolInput.value});
}
function invocation() {
  const args:Record<string,Value> = {};
  for (const el of inputs()) {
    const name=el.dataset['input'];
    if(name!==undefined)args[name] = el.dataset['type'] === 'integer' ? Number(el.value) : el.dataset['type'] === 'ids' ? el.value.split(',').map(s => s.trim()).filter(Boolean) : el.value;
  }
  return {id: id(), action: actionInput.value, actor: actorInput.value, clock: Number(clockInput.value), args};
}
function syncJSON() { toolInput.value = json(invocation()); saveDraft(); }
function buildForm() {
  const tool = snapshot?.tools.find(t => t.name === actionInput.value); if (!tool) return;
  const draft = drafts.get(key());
  const defaults:Record<string,string|number> = {stockId:'camera',slotId:actorInput.value === 'bob' ? 'slotB' : 'slotA',reservationId:`res-${actorInput.value}-${Date.now().toString(36)}`,quantity:2,expiresAt:200};
  $('fields').innerHTML = Object.entries(tool.inputs).map(([name, spec]) => `<label>${esc(name)}<input id="input-${esc(name)}" data-input="${esc(name)}" data-type="${esc(spec.type)}" type="${spec.type === 'integer' ? 'number' : 'text'}" ${spec.type === 'integer' ? `step="1" min="${spec.min ?? 0}"` : ''} required value="${esc(draft?.fields[name] ?? defaults[name] ?? '')}"></label>`).join('');
  clockInput.value = draft?.clock ?? '100';
  $('contract').textContent = json(tool);
  if (draft?.tool) toolInput.value = draft.tool; else syncJSON();
}
function table(records:Readonly<Record<string,RecordSnapshot>>|undefined, fields:string[]) {
  const entries = Object.entries(records ?? {});
  if (!entries.length) return '<p class="muted">No reservation records. Reserve creates a caller-chosen ID in v2.</p>';
  return `<table><thead><tr><th scope="col">ID</th>${fields.map(f => `<th scope="col">${esc(f)}</th>`).join('')}<th scope="col">Version</th></tr></thead><tbody>${entries.map(([recordId, r]) => `<tr data-record="${esc(recordId)}"><th scope="row"><code>${esc(recordId)}</code></th>${fields.map(f => `<td data-field="${esc(f)}">${esc(Array.isArray(r.values[f]) ? r.values[f].join(', ') : r.values[f])}</td>`).join('')}<td>${r.version}</td></tr>`).join('')}</tbody></table>`;
}
function preserve(container:HTMLElement, html:string) {
  const active = document.activeElement; const focusKey = active instanceof HTMLElement&&container.contains(active) ? active.dataset['focus'] : null;
  const open = new Set([...container.querySelectorAll<HTMLDetailsElement>('details[open]')].map(el => el.dataset['detail']));
  container.innerHTML = html;
  for (const el of container.querySelectorAll('details')) if (open.has(el.dataset['detail'])) el.open = true;
  if (focusKey) [...container.querySelectorAll<HTMLElement>('[data-focus]')].find(el => el.dataset['focus'] === focusKey)?.focus({preventScroll:true});
}
function render(snapshot:Snapshot) {
  const {state, profile, pending = [], events = []} = snapshot;
  $('revision').textContent = `${profile} · revision ${state.revision} · sequence ${snapshot.sequence}`;
  $('profile-note').textContent = profile === 'v1' ? 'v1 updates preallocated owner-bound slots. Terminal slots are not new records and cannot be deleted.' : 'v2 inserts caller-chosen reservation IDs. Quantity 3+ requires the stock operator’s policy-derived approval.';
  $('reservation-heading').textContent = profile === 'v1' ? 'Preallocated reservation slots' : 'Inserted reservation records';
  $('stock').innerHTML = table(state.records['stock'], ['capacity','available','operator']);
  $('reservations').innerHTML = table(state.records['reservation'], ['owner','quantity','status','expiresAt']);
  for (const [element,label] of [[$('stock'),'Stock table'],[$('reservations'),'Reservations table']] as const) { element.tabIndex=0; element.setAttribute('role','region'); element.setAttribute('aria-label',label); }
  $('scope').textContent = typeof snapshot.scope === 'string' ? snapshot.scope : json(snapshot.scope);
  const actor = actorInput.value;
  const inbox = pending.filter(p => p.status !== 'consumed' && p.request.requirements.some(r => r.approvers.includes(actor) && !p.grants.some(g => g.policyId === r.policyId)));
  $('inbox-summary').textContent = profile === 'v1' ? 'v1 has no approval-required policy.' : `${inbox.length} awaiting ${actor} · ${pending.filter(p => p.status !== 'consumed').length} open durable requests`;
  preserve($('pending'), pending.length ? pending.map(p => {
    const inv = p.request.invocation;
    return `<article class="approval" data-pending="${esc(p.invocationId)}"><strong>${esc(inv.args['reservationId'])} · ${esc(p.status)}</strong><p><code>${esc(p.invocationId)}</code><br>${esc(inv.actor)} requests ${esc(inv.args['quantity'])} · expires ${esc(inv.args['expiresAt'])}</p>${p.request.requirements.map(r => {
      const grant = p.grants.find(g => g.policyId === r.policyId);
      return `<div><code>${esc(r.policyId)}</code> → ${esc(r.approvers.join(', '))}${grant ? ` · granted by ${esc(grant.approver)}` : ''}${p.status !== 'consumed' && !grant && r.approvers.includes(actor) ? `<br><button data-focus="grant-${esc(p.invocationId)}-${esc(r.policyId)}" data-grant="${esc(p.invocationId)}" data-policy="${esc(r.policyId)}">Grant approval</button>` : ''}</div>`;
    }).join('')}<button data-focus="resume-${esc(p.invocationId)}" data-resume="${esc(p.invocationId)}">${p.status === 'consumed' ? 'Try resume again (consumed)' : 'Resume request'}</button><details data-detail="request-${esc(p.invocationId)}"><summary>Request Why</summary><pre>${esc(json({invocation:inv,requirements:p.request.requirements,capturedRevision:p.request.prestate.revision,grants:p.grants,resumeId:p.resumeId}))}</pre></details></article>`;
  }).join('') : '<p class="muted">No approval requests. Pending actions do not change stock or publish committed facts.</p>');
  preserve($('history'), events.length ? [...events].reverse().map(e => `<details data-detail="${esc(e.eventId)}"><summary>#${esc(e.sequence)} · ${esc(e.event.type ?? e.event.kind ?? e.eventId)}</summary><pre>${esc(json(e.event))}</pre></details>`).join('') : '<p class="muted">No committed events yet.</p>');
}
async function refresh(gen = generation) {
  const serial = ++requestSerial; const {profile,actor} = context();
  try {
    const response = await fetch(`/api/snapshot?${new URLSearchParams({profile,actor})}`);
    const value = await response.json(); if (!response.ok) throw Error(value.error);
    if (gen !== generation || serial !== requestSerial) return;
    const first = !snapshot; const current:Snapshot=value;snapshot=current;
    if (first) { actionInput.innerHTML = current.tools.map(t => `<option>${esc(t.name)}</option>`).join(''); buildForm(); }
    render(current); $('notice').textContent = ''; $('action-form').inert = false; executeJSON.disabled = false;
    if (stream?.readyState === EventSource.OPEN) $('connection').textContent = 'Connected · snapshot current';
  } catch (error) { if (gen === generation && serial === requestSerial) { $('notice').textContent = `Snapshot unavailable: ${error.message}. Reconnect to retry.`; $('connection').textContent = 'Reconnecting · snapshot unavailable'; } }
}
function connect() {
  stream?.close(); const gen = ++generation; snapshot = undefined;
  $('connection').textContent = 'Connecting / resynchronizing…'; $('action-form').inert = true; executeJSON.disabled = true;
  refresh(gen);
  stream = new EventSource(`/api/events?${new URLSearchParams(context())}`);
  stream.onopen = () => { if(gen === generation) $('connection').textContent = 'Connected · snapshot resync'; };
  stream.onerror = () => { if(gen === generation) $('connection').textContent = 'Reconnecting · waiting for server'; };
  stream.addEventListener('change', event => { if (gen !== generation) return; try { $('relationship').textContent = json(JSON.parse(event.data)); } catch { $('relationship').textContent = event.data; } refresh(gen); });
}
const help = {stale:'The captured state changed. Submit a fresh action; old grants cannot authorize a new request.',consumed:'This request already resumed. Inspect durable history; use a new invocation for new work.',precondition:'Check capacity, lifecycle status and expiry. At expiry, resume is no longer valid.',denied:'This simulated actor is not permitted by the declared policy.',approval:'Required grants are missing. Switch to an approver listed in Request Why.'};
async function command(endpoint, body) {
  if (busy) return; busy = true; const gen = generation;
  try {
    const response = await fetch(`/api/${endpoint}`, {method:'POST',headers:{'Content-Type':'application/json'},body:json(body)});
    const value = await response.json(); if (!response.ok) throw Error(value.error);
    if (gen !== generation) return;
    const outcome = value.status === 'duplicate' ? value.result : value;
    $('result').dataset['status'] = outcome.status;
    $('result').innerHTML = `<strong>${esc(value.status)}${outcome.code ? ` · ${esc(outcome.code)}` : ''}</strong><p>${esc(outcome.reason ?? (outcome.status === 'pending' ? 'Awaiting approval. Stock has not changed.' : 'Server result received.'))} ${esc(help[outcome.code] ?? '')}</p><details><summary>Exact server result</summary><pre>${esc(json(value))}</pre></details>`;
    await refresh(gen);
  } catch(error) { if(gen === generation) { $('result').dataset['status']='error'; $('result').textContent=`Command not confirmed: ${error.message}. Check connection and history before retrying.`; } }
  finally { busy = false; }
}
$('action-form').addEventListener('submit', event => { event.preventDefault(); const inv = invocation(); toolInput.value = json(inv); saveDraft(); command('execute',{profile:context().profile,invocation:inv}); });
$('fields').addEventListener('input',syncJSON); clockInput.addEventListener('input',syncJSON); toolInput.addEventListener('input',saveDraft);
actionInput.addEventListener('change', buildForm);
for (const name of ['profile','actor']) $(name).addEventListener('change', () => { $('result').replaceChildren(); connect(); });
$('reconnect').addEventListener('click', () => {saveDraft(); connect();});
executeJSON.addEventListener('click', () => {try {command('execute',{profile:context().profile,invocation:JSON.parse(toolInput.value)});}catch(error){$('result').dataset['status']='error';$('result').textContent=`Invalid JSON: ${error.message}`;}});
$('pending').addEventListener('click', event => {const button = event.target instanceof Element?event.target.closest('button'):null; if (!button) return; const {profile,actor} = context(); if(button.dataset['grant']) command('approve',{profile,actor,command:{id:id(),invocationId:button.dataset['grant'],policyId:button.dataset['policy']}}); else if(button.dataset['resume']) { if(!resumeClock.reportValidity()) return; command('resume',{profile,command:{id:id(),invocationId:button.dataset['resume'],clock:Number(resumeClock.value)}}); }});
connect();
