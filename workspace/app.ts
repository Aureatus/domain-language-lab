import {decodeJson,decodeJsonObject,decodeJsonValue,encodeJson,WorkspaceChangeSchema} from '../adapters/effect/json.ts';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json = value => JSON.stringify(value, null, 2);
let snapshot, stream, generation = 0, requestSerial = 0, busy = false;
const drafts = new Map();
const context = () => ({profile: $('profile').value, actor: $('actor').value});
const key = () => `${$('profile').value}/${$('actor').value}/${$('action').value}`;
const id = () => `cmd-${crypto.randomUUID()}`;
function saveDraft() { if ($('action').value) drafts.set(key(), {fields: Object.fromEntries([...document.querySelectorAll('[data-input]')].map(el => [el.dataset.input, el.value])), clock: $('clock').value, tool: $('tool-json').value}); }
function invocation() {
  const args = {};
  for (const el of document.querySelectorAll('[data-input]')) args[el.dataset.input] = el.dataset.type === 'integer' ? Number(el.value) : el.dataset.type === 'ids' ? el.value.split(',').map(s => s.trim()).filter(Boolean) : el.value;
  return {id: id(), action: $('action').value, actor: $('actor').value, clock: Number($('clock').value), args};
}
function syncJSON() { $('tool-json').value = json(invocation()); saveDraft(); }
function buildForm() {
  const tool = snapshot.tools.find(t => t.name === $('action').value); if (!tool) return;
  const draft = drafts.get(key());
  const defaults = {stockId:'camera',slotId:$('actor').value === 'bob' ? 'slotB' : 'slotA',reservationId:`res-${$('actor').value}-${Date.now().toString(36)}`,quantity:2,expiresAt:200};
  $('fields').innerHTML = Object.entries(tool.inputs).map(([name, spec]) => `<label>${esc(name)}<input id="input-${esc(name)}" data-input="${esc(name)}" data-type="${esc(spec.type)}" type="${spec.type === 'integer' ? 'number' : 'text'}" ${spec.type === 'integer' ? `step="1" min="${spec.min ?? 0}"` : ''} required value="${esc(draft?.fields[name] ?? defaults[name] ?? '')}"></label>`).join('');
  $('clock').value = draft?.clock ?? 100;
  $('contract').textContent = json(tool);
  if (draft?.tool) $('tool-json').value = draft.tool; else syncJSON();
}
function table(records, fields) {
  const entries = Object.entries(records ?? {});
  if (!entries.length) return '<p class="muted">No reservation records. Reserve creates a caller-chosen ID in v2.</p>';
  return `<table><thead><tr><th scope="col">ID</th>${fields.map(f => `<th scope="col">${esc(f)}</th>`).join('')}<th scope="col">Version</th></tr></thead><tbody>${entries.map(([recordId, r]) => `<tr data-record="${esc(recordId)}"><th scope="row"><code>${esc(recordId)}</code></th>${fields.map(f => `<td data-field="${esc(f)}">${esc(Array.isArray(r.values[f]) ? r.values[f].join(', ') : r.values[f])}</td>`).join('')}<td>${r.version}</td></tr>`).join('')}</tbody></table>`;
}
function preserve(container, html) {
  const active = document.activeElement; const focusKey = container.contains(active) ? active.dataset.focus : null;
  const open = new Set([...container.querySelectorAll('details[open]')].map(el => el.dataset.detail));
  container.innerHTML = html;
  for (const el of container.querySelectorAll('details')) if (open.has(el.dataset.detail)) el.open = true;
  if (focusKey) [...container.querySelectorAll('[data-focus]')].find(el => el.dataset.focus === focusKey)?.focus({preventScroll:true});
}
function render() {
  const {state, profile, pending = [], events = []} = snapshot;
  $('revision').textContent = `${profile} · revision ${state.revision} · sequence ${snapshot.sequence}`;
  $('profile-note').textContent = profile === 'v1' ? 'v1 updates preallocated owner-bound slots. Terminal slots are not new records and cannot be deleted.' : 'v2 inserts caller-chosen reservation IDs. Quantity 3+ requires the stock operator’s policy-derived approval.';
  $('reservation-heading').textContent = profile === 'v1' ? 'Preallocated reservation slots' : 'Inserted reservation records';
  $('stock').innerHTML = table(state.records.stock, ['capacity','available','operator']);
  $('reservations').innerHTML = table(state.records.reservation, ['owner','quantity','status','expiresAt']);
  for (const [element,label] of [[$('stock'),'Stock table'],[$('reservations'),'Reservations table']]) { element.tabIndex=0; element.setAttribute('role','region'); element.setAttribute('aria-label',label); }
  $('scope').textContent = typeof snapshot.scope === 'string' ? snapshot.scope : json(snapshot.scope);
  const actor = $('actor').value;
  const inbox = pending.filter(p => p.status !== 'consumed' && p.request.requirements.some(r => r.approvers.includes(actor) && !p.grants.some(g => g.policyId === r.policyId)));
  $('inbox-summary').textContent = profile === 'v1' ? 'v1 has no approval-required policy.' : `${inbox.length} awaiting ${actor} · ${pending.filter(p => p.status !== 'consumed').length} open durable requests`;
  preserve($('pending'), pending.length ? pending.map(p => {
    const inv = p.request.invocation;
    return `<article class="approval" data-pending="${esc(p.invocationId)}"><strong>${esc(inv.args.reservationId)} · ${esc(p.status)}</strong><p><code>${esc(p.invocationId)}</code><br>${esc(inv.actor)} requests ${esc(inv.args.quantity)} · expires ${esc(inv.args.expiresAt)}</p>${p.request.requirements.map(r => {
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
    const value = decodeJsonObject(await response.text()); if (!response.ok) throw Error(value.error);
    if (gen !== generation || serial !== requestSerial) return;
    const first = !snapshot; snapshot = value;
    if (first) { $('action').innerHTML = snapshot.tools.map(t => `<option>${esc(t.name)}</option>`).join(''); buildForm(); }
    render(); $('notice').textContent = ''; $('action-form').inert = false; $('execute-json').disabled = false;
    if (stream?.readyState === EventSource.OPEN) $('connection').textContent = 'Connected · snapshot current';
  } catch (error) { if (gen === generation && serial === requestSerial) { $('notice').textContent = `Snapshot unavailable: ${error.message}. Reconnect to retry.`; $('connection').textContent = 'Reconnecting · snapshot unavailable'; } }
}
function connect() {
  stream?.close(); const gen = ++generation; snapshot = undefined;
  $('connection').textContent = 'Connecting / resynchronizing…'; $('action-form').inert = true; $('execute-json').disabled = true;
  refresh(gen);
  stream = new EventSource(`/api/events?${new URLSearchParams(context())}`);
  stream.onopen = () => { if(gen === generation) $('connection').textContent = 'Connected · snapshot resync'; };
  stream.onerror = () => { if(gen === generation) $('connection').textContent = 'Reconnecting · waiting for server'; };
  stream.addEventListener('change', event => { if (gen !== generation) return; try { $('relationship').textContent = json(decodeJson(WorkspaceChangeSchema,event.data)); } catch { $('relationship').textContent = event.data; } refresh(gen); });
}
const help = {stale:'The captured state changed. Submit a fresh action; old grants cannot authorize a new request.',consumed:'This request already resumed. Inspect durable history; use a new invocation for new work.',precondition:'Check capacity, lifecycle status and expiry. At expiry, resume is no longer valid.',denied:'This simulated actor is not permitted by the declared policy.',approval:'Required grants are missing. Switch to an approver listed in Request Why.'};
async function command(endpoint, body) {
  if (busy) return; busy = true; const gen = generation;
  try {
    const response = await fetch(`/api/${endpoint}`, {method:'POST',headers:{'Content-Type':'application/json'},body:encodeJson(body)});
    const value = decodeJsonObject(await response.text()); if (!response.ok) throw Error(value.error);
    if (gen !== generation) return;
    const outcome = value.status === 'duplicate' ? value.result : value;
    $('result').dataset.status = outcome.status;
    $('result').innerHTML = `<strong>${esc(value.status)}${outcome.code ? ` · ${esc(outcome.code)}` : ''}</strong><p>${esc(outcome.reason ?? (outcome.status === 'pending' ? 'Awaiting approval. Stock has not changed.' : 'Server result received.'))} ${esc(help[outcome.code] ?? '')}</p><details><summary>Exact server result</summary><pre>${esc(json(value))}</pre></details>`;
    await refresh(gen);
  } catch(error) { if(gen === generation) { $('result').dataset.status='error'; $('result').textContent=`Command not confirmed: ${error.message}. Check connection and history before retrying.`; } }
  finally { busy = false; }
}
$('action-form').addEventListener('submit', event => { event.preventDefault(); const inv = invocation(); $('tool-json').value = json(inv); saveDraft(); command('execute',{profile:context().profile,invocation:inv}); });
$('fields').addEventListener('input',syncJSON); $('clock').addEventListener('input',syncJSON); $('tool-json').addEventListener('input',saveDraft);
$('action').addEventListener('change', buildForm);
for (const name of ['profile','actor']) $(name).addEventListener('change', () => { $('result').replaceChildren(); connect(); });
$('reconnect').addEventListener('click', () => {saveDraft(); connect();});
$('execute-json').addEventListener('click', () => {try {command('execute',{profile:context().profile,invocation:decodeJsonValue($('tool-json').value)});}catch(error){$('result').dataset.status='error';$('result').textContent=`Invalid JSON: ${error.message}`;}});
$('pending').addEventListener('click', event => {const button = event.target.closest('button'); if (!button) return; const {profile,actor} = context(); if(button.dataset.grant) command('approve',{profile,actor,command:{id:id(),invocationId:button.dataset.grant,policyId:button.dataset.policy}}); else if(button.dataset.resume) { if(!$('resume-clock').reportValidity()) return; command('resume',{profile,command:{id:id(),invocationId:button.dataset.resume,clock:Number($('resume-clock').value)}}); }});
connect();
