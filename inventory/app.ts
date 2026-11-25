import {errorMessage} from '../errors.ts';
import {createHost,competition,replay} from './host.ts';
import {invocation} from './model.ts';
let host=createHost(), sequence=0, selected=-1;
function $<T extends HTMLElement>(id: string, constructor: new () => T): T;
function $(id: string): HTMLElement;
function $(id: string, constructor: new () => HTMLElement = HTMLElement) {
  const element=document.getElementById(id);
  if(!(element instanceof constructor)) throw Error(`Missing inventory control: ${id}`);
  return element;
}
const escapes: Record<string, string>={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const escape=value=>String(value).replace(/[&<>"']/g,c=>escapes[c]??c);
type Step = ReturnType<typeof createHost>['steps'][number];
const isMutant = (operation: Step['operation'])=>operation.type==='commit'&&operation.mutant;
function render() {
  $('replay-result').textContent='';
  const state=selected<0?host.state:stateAt(selected);
  const {available, capacity}=state.records['stock']['camera'].values;
  if(typeof available!=='number'||typeof capacity!=='number') throw Error('Inventory stock counts must be numbers');
  $('available').textContent=String(available);
  $('revision').textContent=`Snapshot r${state.revision} · ${selected<0?'latest':'history / read only'}`;
  $('allocation').innerHTML=Array.from({length:capacity},(_,i)=>`<span class="unit ${i<available?'free':'held'}">${i<available?'AVAILABLE':'HELD'}</span>`).join('');
  $('reservations').innerHTML=Object.entries(state.records['reservation']).map(([key,{version,values:r}])=>`<tr><th>${key}</th><td>${escape(r['owner'])}</td><td><span class="status ${r['status']}">${r['status']}</span></td><td>${r['quantity']}</td><td>${r['expiresAt']||'—'}</td><td>v${version}</td></tr>`).join('');
  const oracle=selected<0?host.oracle:host.steps[selected].observation.oracle;
  $('health').className=oracle.ok?'health':'health failed';
  $('health').textContent=oracle.ok?'Conservation holds · accepted ledger agrees':`INVARIANT FAILURE · ${oracle.failures.join(' · ')}`;
  $('steps').innerHTML=host.steps.map(({operation:o,observation:r},i)=>`<button class="step ${selected===i?'selected':''}" data-step="${i}"><span>${i+1}. ${escape(o.type)} ${escape(o.type==='execute'?o.invocation.action.split('.')[1]:o.token)}${isMutant(o)?' · MUTANT':''}</span><strong class="${r.status==='rejected'?'rejected':''}">${escape(r.code??r.status)}</strong></button>`).join('')||'<p class="muted">No operations yet. Reserve stock or run a competing schedule.</p>';
  const item=host.steps[selected<0?host.steps.length-1:selected];
  $('explanation').textContent=item?explain(item):'Five cameras. Three existing reservation slots. All updates run through semantic-core/v1; no application action mutates domain records.';
  $('events').textContent=JSON.stringify(item?.observation.events??[],null,2);
  $('evidence').textContent=item?JSON.stringify(item,null,2):'Select a schedule step to inspect its exact invocation and observation.';
  $('live').hidden=selected<0;
  $('actions', HTMLFieldSetElement).disabled=selected>=0;
  $('mutant-label').hidden=!host.steps.some(s=>isMutant(s.operation));
}
function stateAt(index) {
  const bundle=host.export(), h=createHost(bundle.model,bundle.initial);
  for(const {operation} of host.steps.slice(0,index+1)) h.step(operation);
  return h.state;
}
function explain({operation:o,observation:r}: Step) {
  if(r.code==='stale') return 'Stale preparation rejected. Another grouped update changed the full snapshot. No writes or events published. Retry must prepare against the latest state.';
  if(r.code==='precondition') return `Precondition failed: ${r.reason}. The entire group was rejected; stock and slot are unchanged.`;
  if(r.code==='denied') return 'Ownership policy denied this action. Reserve/cancel require the slot owner; expiration requires the warehouse operator. No writes or events published.';
  if(r.status==='prepared') return 'Prepared against the current immutable snapshot. Nothing has been published. A later commit must revalidate against the latest host state.';
  if(isMutant(o)&&r.status==='committed') return 'DELIBERATELY BROKEN HOST: commit received the old snapshot, not the latest state. Publishing this valid branch overwrites another accepted reservation. The ledger oracle checks accepted promises independently of the final state.';
  if(r.status==='committed') return `Committed one atomic group at revision ${r.revision}. Every assignment read the same prestate. Change facts below are siblings, not a causal sequence. Recipients come from poststate relationships.`;
  return `${r.status}: ${r.reason??''}`;
}
$('command').addEventListener('submit',event=>{
  event.preventDefault(); selected=-1;
  const kind=$('kind', HTMLSelectElement).value;
  host.step({type:'execute',invocation:invocation(`manual${++sequence}`,kind,$('slot', HTMLSelectElement).value,$('actor', HTMLSelectElement).value,Number($('clock', HTMLInputElement).value),Number($('quantity', HTMLInputElement).value),Number($('expiry', HTMLInputElement).value))});render();
});
$('correct').onclick=()=>{host=competition(false);selected=-1;render();};
$('broken').onclick=()=>{host=competition(true);selected=-1;render();};
$('reset').onclick=()=>{host=createHost();selected=-1;render();};
$('live').onclick=()=>{selected=-1;render();};
$('steps').onclick=event=>{const button=event.target instanceof Element && event.target.closest<HTMLButtonElement>('[data-step]');if(button){selected=Number(button.dataset['step']);render();}};
$('replay').onclick=()=>{try {host=replay(JSON.parse(JSON.stringify(host.export())));selected=-1;render();$('replay-result').textContent='Exact replay matched every observation, event and final record.';}catch(error){$('replay-result').textContent=errorMessage(error);}};
$('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(host.export(),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='inventory-replay.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
const importInput=$('import', HTMLInputElement);
importInput.onchange=async()=>{try {const file=importInput.files?.[0];if(!file)return;host=replay(JSON.parse(await file.text()));selected=-1;render();$('replay-result').textContent='Imported replay verified.';}catch(error){$('replay-result').textContent=`Import rejected: ${errorMessage(error)}`;}};
render();
declare global {
  interface Window {
    inventoryApp: {readonly host: ReturnType<typeof createHost>};
  }
}
window.inventoryApp={get host(){return host;}};
