import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import pin from './pin.json' with {type:'json'};
import {loadingPlan,lifecycleGuard} from '../../application/loading.ts';
import type {ApplicationAction,ApplicationContract,ApplicationField} from '../../application/derive.ts';
const q=JSON.stringify;
function placeholder({index,strategy,label}){
  const name=q(`Loading ${label}…`),id=q(`loading:${index}:${strategy}`);
  switch(strategy){
    case 'text':return `text ${name} role="status" testId=${id}`;
    case 'icon':return `progress width=24 height=24 aria-label=${name} testId=${id}`;
    case 'skeleton':return `column role="status" aria-label=${name} testId=${id} gap=6\n              box width="45%" height=16 border-radius=4 background-color="-exact-fill"\n              box width="75%" height=12 border-radius=4 background-color="-exact-fill"`;
    case 'wait':return null;
    default:throw Error(`Unsupported loading strategy: ${strategy}`);
  }
}
type Envelope = {contract:ApplicationContract; contractId:string};
type Marker = {semanticId:string; marker?:string; generated?:{file:string;line:number}; contractPointer?:string};
type Form = {k:string;actor:ApplicationContract['actors'][number];a:ApplicationAction;fields:ApplicationField[];shape:string};
export function generate(envelope: Envelope,{api='http://127.0.0.1:4186'}={}){
  const {contract:c,contractId}=envelope;
  if(c.format!=='derived-application/v1'||!contractId)throw Error('Unsupported derived contract.');
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(api))throw Error('This experimental adapter requires a loopback HTTP backend.');
  for(const v of c.views)if(!['summary','list'].includes(v.kind)||v.columns.some(x=>!['text','date',undefined].includes(x.format)))throw Error('Unsupported view.');
  const lines:string[]=[],maps:Marker[]=[];const emit=(s:string,id?:string)=>{if(id){const marker=`// mapping-${maps.length}`;maps.push({semanticId:id,marker});const indent=s.match(/^ */)?.[0]??'';lines.push(indent+marker);}lines.push(s);};
  const plan=loadingPlan(c),guard=phase=>lifecycleGuard(phase,{pending:'pending(screen)',failed:'failed(screen)',owned:'screen.owner == actor'});
  emit(`// Generated; edit the domain/application declarations, never this file.
shape Row
  id: string
  title: string
  detail: string
shape Grant
  id: string
  label: string
  eligible: bool
shape Pending
  id: string
  title: string
  detail: string
  grants: Grant[]
  complete: bool
shape Screen
  owner: string
  rows: Row[]
  inbox: Pending[]
shape Reply
  ok: bool
  message: string
shape Submission
  phase: string
  message: string
component App
  state actor = ${q(c.actors[0].id)}
  state noticeOwner = ""
  resource screen = loadScreen(actor) as shape Screen else empty()
  mutation changed as shape Reply refreshes screen
  derive busy = pending(changed)__SUBMISSION_BUSY__
  derive notice = match changed { case some(r) => r.message, case none => "" }
  task polling mount
    every(4000, reload)
  action reload
    refresh screen
  action choose(v: string)
    if not busy
      actor = v
  action grant(id: string, policy: string)
    if not busy
      noticeOwner = actor
      send changed = saveGrant(actor, id, policy)
  action resume(id: string)
    if not busy
      noticeOwner = actor
      send changed = completeRequest(actor, id)`);
  const sources:string[]=[],forms:Form[]=[];let n=0;
  for(const actor of c.actors)for(const a of Object.values(c.actions)){
    const k=`f${n++}`,fields=a.fields.filter(f=>!f.hidden);
    for(const f of fields)if(!['string','integer','boolean'].includes(f.schema.type)||!['text','date','number','checkbox','select'].includes(f.widget))throw Error(`Unsupported field ${a.id}.${f.name}`);
    emit(`  resource ${k} = loadForm${k}() as shape Form${k} else empty()`, `action:${a.id}`);
    emit(`  mutation ${k}submission as shape Submission refreshes screen
  derive ${k}phase = match ${k}submission { case some(r) => r.phase, case none => "editing" }
  derive ${k}locked = ${k}phase != "known" and ${k}phase != "editing"
  derive ${k}disabled = busy or ${k}locked
  derive ${k}message = match ${k}submission { case some(r) => r.message, case none => "" }`);
    fields.forEach((f,i)=>{emit(`  state ${k}d${i}: option<${f.schema.type==='boolean'?'bool':'string'}> = none`);emit(`  derive ${k}v${i} = match ${k}d${i} { case some(v) => v, case none => ${k}.v${i} }`);emit(`  action ${k}edit${i}(v: ${f.schema.type==='boolean'?'bool':'string'})\n    ${k}d${i} = some(v)`,`action:${a.id}/input:${f.name}`);});
    const args=fields.map((_,i)=>`${k}v${i}`).join(', ');
    emit(`  action ${k}preview\n    if not busy\n      noticeOwner = actor\n      send changed = preview${k}(${q(actor.id)}${args?', '+args:''})`);
    emit(`  action ${k}save\n    if not ${k}disabled\n      noticeOwner = ${q('submission:'+k)}${fields.map((_,i)=>`\n      ${k}d${i} = some(${k}v${i})`).join('')}\n      send ${k}submission = execute${k}(${args})`);
    for(const [op,phase] of [['check','unknown'],['retry','retryable']]){
      emit(`  action ${k}${op}\n    if not busy and ${k}phase == "${phase}"\n      noticeOwner = ${q('submission:'+k)}\n      send ${k}submission = ${op}${k}()`);
      sources.push(`  ${op}${k}:async ()=>driver${k}.run('${op}'),`);
    }
    const shape=`shape Form${k}\n  available: bool${fields.map((f,i)=>`\n  v${i}: ${f.schema.type==='boolean'?'bool':'string'}`).join('')}${fields.filter(f=>f.widget==='select').map(f=>`\n  options${fields.indexOf(f)}: Row[]`).join('')}`;
    forms.push({k,actor,a,fields,shape});
    const inputs=fields.map((_,i)=>`v${i}`),values=`{${fields.map((f,i)=>`${q(f.name)}:${f.schema.type==='integer'?`Number(v${i})`:`v${i}`}`).join(',')}}`;
    sources.push(`  preview${k}:async ([${['actor',...inputs]}])=>client.command('actions/preview',{actor,action:${q(a.id)},args:${values}}),`,
      `  execute${k}:async ([${inputs}])=>driver${k}.run('submit',${values}),`);
  }
  emit(`  view
    column height="100%"
      header padding=16
        text ${q(c.title)} role="heading" aria-level=1
      scroll flex=1 min-height=0
        column gap=16 padding=16
          text ${q(c.scope)} color="-exact-secondary-label"
          select value=actor change=choose disabled=busy aria-label="Local simulated identity" testId="actor"`);
  for(const a of c.actors)emit(`            option ${q(a.label)} value=${q(a.id)}`);
  emit(`          button press=reload disabled=busy testId="refresh"
            text "Refresh"`);
  // The HTTP resource is one atomic snapshot. Its pending state is real, even
  // for views choosing wait (which emit no placeholder at all).
  const indicators=plan.map(placeholder).filter(Boolean);
  if(indicators.length)emit(`          if ${guard('initial')}\n`+indicators.map(line=>`            ${line}`).join('\n'));
  emit(`          if ${guard('failed')}
            text "Could not load records for this identity. Try Refresh." role="alert" testId="screen-failed" color="-exact-system-red"
          if ${guard('stale')}
            text "Could not refresh. Retained records may be old. Try Refresh." role="alert" testId="screen-stale" color="-exact-system-red"
          if not busy and noticeOwner == actor and notice != ""
            text notice role="status" testId="notice"
          if screen.owner == actor
            for r in screen.rows key=r.id
              column gap=4
                text r.title role="heading" aria-level=2
                text r.detail testId=r.id`);
  for(const {k,actor,a,fields}of forms){
    emit(`          if actor == ${q(actor.id)} and (${k}.available or ${k}locked)
            column gap=8
              text ${q(a.label)} role="heading" aria-level=2`,`action:${a.id}`);
    emit(`              if not busy and noticeOwner == ${q('submission:'+k)} and ${k}message != ""
                text ${k}message role="status" testId="notice"`);
    fields.forEach((f,i)=>{
      emit(`              text ${q(f.label)}`);
      if(f.widget==='select')emit(`              select value=${k}v${i} change=${k}edit${i} disabled=${k}disabled aria-label=${q(f.label)} testId=${q(`${actor.id}:${a.id}:${f.name}`)}\n                for o in ${k}.options${i} key=o.id\n                  option o.title value=o.id`);
      else emit(`              input ${f.widget==='checkbox'?`type="checkbox" checked=${k}v${i} change=${k}edit${i}`:`value=${k}v${i} input=${k}edit${i} type=${q(f.widget==='number'?'text':f.widget)}${f.widget==='number'?' inputmode="decimal"':''}`} disabled=${k}disabled aria-label=${q(f.label)} testId=${q(`${actor.id}:${a.id}:${f.name}`)}`);
    });
    emit(`              button press=${k}preview disabled=${k}disabled testId=${q(`${actor.id}:${a.id}:preview`)}\n                text "Preview"\n              button press=${k}save disabled=${k}disabled buttonStyle="filled" testId=${q(`${actor.id}:${a.id}:execute`)}\n                text ${q(a.label)}`);
    for(const [op,phase,label] of [['check','unknown','Check submission'],['retry','retryable','Retry submission']])
      emit(`              if ${k}phase == "${phase}"\n                button press=${k}${op} disabled=busy testId=${q(`${actor.id}:${a.id}:${op}`)}\n                  text ${q(label)}`);
  }
  emit(`          text "Approval inbox" role="heading" aria-level=2
          if screen.owner == actor
            if screen.inbox.length == 0
              text "No pending requests for this identity."
            for p in screen.inbox key=p.id
              column gap=8
                text p.title
                text p.detail
                for g in p.grants key=g.id
                  text g.label
                  if g.eligible
                    button press=grant(p.id, g.id) disabled=busy testId=__GRANT__
                      text "Save approval"
                if p.complete
                  button press=resume(p.id) disabled=busy testId=__RESUME__
                    text "Complete request"`.replace('__GRANT__','`grant-${p.id}-${g.id}`').replace('__RESUME__','`resume-${p.id}`'));
  const contract= forms.map(f=>f.shape).join('\n')+'\n'+lines.join('\n')
    .replace('__SUBMISSION_BUSY__',forms.map(f=>` or pending(${f.k}submission)`).join(''))
    .replaceAll('as shape Submission refreshes screen','as shape Submission refreshes screen'+forms.map(f=>`, ${f.k}`).join(''))
    .replace('as shape Reply refreshes screen','as shape Reply refreshes screen'+forms.map(f=>`, ${f.k}`).join(''))
    .replace('  action reload\n    refresh screen','  action reload\n    refresh screen'+forms.map(f=>`\n    refresh ${f.k}`).join(''))+'\n';
  maps.forEach(m=>{m.generated={file:'app.contract',line:contract.split('\n').findIndex(l=>l.trim()===m.marker)+2};delete m.marker;const [action,input]=m.semanticId.split('/input:');m.contractPointer=`/contract/actions/${action.slice('action:'.length).replaceAll('~','~0').replaceAll('/','~1')}${input?'/fields/'+c.actions[action.slice('action:'.length)].fields.findIndex(f=>f.name===input):''}`;});
  const ts=`// Generated typed Exact data seam; no domain policy implementation.
import type {Answer, Sources} from './app.contract.d.ts';
import {createClient,submissionDriver} from './client.mjs';
import envelope from './contract.json';
export const API=${q(api)};
export const grants='net.fetch '+API;
const client=createClient(envelope,API);
${forms.map(({k,actor,a})=>`const driver${k}=submissionDriver(client,${q(actor.id)},${q(a.id)});`).join('\n')}
const sources: Sources={
  loadScreen:async ([actor])=>client.project(await client.snapshot(),actor),
${forms.map(({k,actor,a,fields})=>`  loadForm${k}:async ()=>{const s=await client.snapshot(),d=s.defaults[${q(actor.id)}][${q(a.id)}];return {available:s.availability[${q(actor.id)}][${q(a.id)}],${fields.map((f,i)=>`v${i}:${f.schema.type==='boolean'?`Boolean(d[${q(f.name)}])`:`String(d[${q(f.name)}]??'')`}${f.widget==='select'?`,options${i}:${f.reference?`Object.entries(s.state.records[${q(f.reference.resource)}] as Record<string,{values:Record<string,unknown>}>).map(([id,r])=>({id,title:String(${f.reference.labelField?`r.values[${q(f.reference.labelField)}]`:'id'}),detail:''}))`:`${q(f.schema.type==='string' ? f.schema.enum : undefined)}.map(id=>({id,title:id,detail:''}))`}`:''}`).join(',')}};},`).join('\n')}
  saveGrant:async ([actor,requestId,policyId])=>client.command('approvals/grant',{actor,requestId,policyId}),
  completeRequest:async ([actor,requestId])=>client.command('approvals/resume',{actor,requestId}),
${sources.join('\n')}
};
export const answer:Answer=(source,args,store,storage,native)=>sources[source](args,store,storage,native);
`;
  return {contract,ts,manifest:{format:'exact-adapter/v1',contractId,exact:pin,api,sourceMap:maps,views:c.views.map((v,i)=>({semanticId:`resource:${v.resource}`,contractPointer:`/contract/views/${i}`,projection:`view:${i}`}))},app:{name:c.title,app:{id:'research.derived.exact',name:c.title},host:{web:{},android:{}}}};
}
export async function writeAdapter(envelope: Envelope,out: string,options?: Parameters<typeof generate>[1]){
  const r=generate(envelope,options);
  await mkdir(out,{recursive:true});
  for(const [name,data] of Object.entries({'app.contract':r.contract,'app.ts':r.ts,'app.json':JSON.stringify(r.app,null,2),'adapter-manifest.json':JSON.stringify(r.manifest,null,2),'contract.json':JSON.stringify(envelope,null,2)}))
    await writeFile(resolve(out,name),data);
  for(const [name,src] of [['submission.mjs','../../application/submission.ts'],['client.mjs','./client.ts']]){
    const source=await readFile(new URL(src,import.meta.url),'utf8');
    await writeFile(resolve(out,name),stripTypeScriptTypes(source).replace("'./submission.ts'","'./submission.mjs'"));
  }
  await writeFile(resolve(out,'client.d.mts'),await readFile(new URL('./client.d.mts',import.meta.url)));
  return r;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const [url='http://127.0.0.1:4186',out='artifacts/exact-app']=process.argv.slice(2);const response=await fetch(`${url}/api/contract`);if(!response.ok)throw Error(`Contract HTTP ${response.status}`);await writeAdapter(await response.json(),out,{api:url});console.log(`Generated ${out}`);}
