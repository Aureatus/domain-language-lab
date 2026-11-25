import {createInterpreter,validateState,jsonSnapshot} from '../semantic/v2/core.ts';
import {adapters} from './inputs.ts';
import {loadingModes} from './loading.ts';
export {loadingModes};

const title=s=>s.replace(/[._-]/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase());
export function exact(value,keys,required=[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(value,k)))throw Error(`Unsupported or missing configuration members (allowed: ${keys.join(', ')}).`);
}
const text=s=>{if(typeof s!=='string'||!s.length)throw Error('Expected nonempty text.');return s;};
function validateLoading(config){if(Object.hasOwn(config,'loading')&&!loadingModes.includes(config.loading))throw Error(`Expected loading mode: ${loadingModes.join(', ')}.`);}
function objectMap(value){if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected a configuration object.');}
function conforms(schema,value){
  return schema.type==='string'?typeof value==='string'&&(!schema.enum||schema.enum.includes(value)):schema.type==='integer'?Number.isSafeInteger(value)&&(!Object.hasOwn(schema,'min')||value>=schema.min)&&(!Object.hasOwn(schema,'max')||value<=schema.max):schema.type==='boolean'?typeof value==='boolean':Array.isArray(value)&&value.every(v=>typeof v==='string');
}
function fieldRef(model,ref){
  exact(ref,['resource','key','field'],['resource','key','field']);
  text(ref.resource);text(ref.field);
  if(!model.resources[ref.resource]?.fields[ref.field])throw Error('Unknown resource/field reference.');
  text(ref.key);
}
export function deriveApplication(declaration) {
  exact(declaration,['domain','initialState','application'],['domain','initialState','application']);
  const {domain,initialState,application}=declaration;
  const runtime=createInterpreter(domain),model=runtime.model,state=validateState(model,initialState),meta=jsonSnapshot(application);
  exact(meta,['version','title','eyebrow','subtitle','scope','loading','actors','actions','views'],['version','title','actors']);
  validateLoading(meta);
  if(meta.version!=='model-application/v1')throw Error('Unsupported application version.');
  text(meta.title);if(meta.eyebrow!==undefined)text(meta.eyebrow);if(meta.subtitle!==undefined)text(meta.subtitle);if(meta.scope!==undefined)text(meta.scope);
  if(Object.hasOwn(meta,'actions'))objectMap(meta.actions);
  if(!Array.isArray(meta.actors)||!meta.actors.length)throw Error('Declare local simulation actors.');
  const actorIds=new Set();for(const a of meta.actors){exact(a,['id','label','name'],['id','label']);text(a.id);text(a.label);if(a.name!==undefined)text(a.name);if(actorIds.has(a.id))throw Error('Duplicate actor.');actorIds.add(a.id);}
  for(const name of Object.keys(meta.actions??{})){if(!Object.hasOwn(model.actions,name))throw Error(`Unknown action ${name}`);objectMap(meta.actions[name]);}
  const actions=Object.fromEntries(Object.entries(model.actions).map(([id,a])=>{
    const config=meta.actions?.[id]??{};
    exact(config,['label','description','fields','adapters']);
    if(Object.hasOwn(config,'fields'))objectMap(config.fields);
    if(config.label!==undefined)text(config.label);if(config.description!==undefined)text(config.description);
    for(const name of Object.keys(config.fields??{})){if(!Object.hasOwn(a.inputs,name))throw Error(`Unknown action input ${name}`);objectMap(config.fields[name]);}
    const mappings=Object.hasOwn(config,'adapters')?config.adapters:[];if(!Array.isArray(mappings))throw Error('Expected adapters array.');
    const computed=new Set(),dateInputs=new Set();
    for(const item of mappings){exact(item,['name','mapping'],['name','mapping']);if(!adapters[item.name])throw Error(`Unsupported adapter ${item.name}`);adapters[item.name].validate(item.mapping,a.inputs);if(computed.has(item.mapping.output))throw Error('Conflicting adapter output.');computed.add(item.mapping.output);dateInputs.add(item.mapping.start);dateInputs.add(item.mapping.end);}
    const fields=Object.entries(a.inputs).map(([name,schema])=>{
      const f=config.fields?.[name]??{};
      exact(f,['label','default','binding','reference','widget']);
      if(Object.hasOwn(f,'binding'))objectMap(f.binding);
      if(Object.hasOwn(f,'reference'))objectMap(f.reference);
      if(f.label!==undefined)text(f.label);
      if(f.binding){exact(f.binding,['source','value'],['source']);if(!['actor','operation-id','clock','constant'].includes(f.binding.source))throw Error('Unsupported input binding.');if(f.binding.source==='constant'&&!Object.hasOwn(f.binding,'value'))throw Error('Missing constant.');if(f.binding.source!=='constant'&&Object.hasOwn(f.binding,'value'))throw Error('Unexpected binding value.');}
      if(f.default&&typeof f.default==='object'){fieldRef(model,f.default);if(f.default.key!=='$actor'&&!state.records[f.default.resource]?.[f.default.key])throw Error('Unknown default record.');}
      if(Object.hasOwn(f,'default')){
        const values=f.default&&typeof f.default==='object'?Object.entries(state.records[f.default.resource]).filter(([id])=>f.default.key==='$actor'?actorIds.has(id):id===f.default.key).map(([,r])=>r.values[f.default.field]):[f.default];
        if(!values.length||values.some(v=>!conforms(schema,v)))throw Error('Default/schema mismatch.');
      }
      if(f.binding){const values=f.binding.source==='actor'?[...actorIds]:f.binding.source==='constant'?[f.binding.value]:f.binding.source==='clock'?[0]:['operation-example'];if(values.some(v=>!conforms(schema,v)))throw Error('Binding/schema mismatch.');}
      let reference=f.reference;
      if(!reference){const b=a.bindings.find(b=>b.key.op==='input'&&b.key.name===name);if(b)reference={resource:b.resource};}
      if(reference){exact(reference,['resource','labelField'],['resource']);text(reference.resource);if(Object.hasOwn(reference,'labelField'))text(reference.labelField);if(schema.type!=='string'||!Object.hasOwn(model.resources,reference.resource)||(reference.labelField&&!Object.hasOwn(model.resources[reference.resource].fields,reference.labelField)))throw Error('Unknown or incompatible input reference.');}
      if(schema.type==='ids'&&!f.binding)throw Error('Visible ids inputs are not supported by this renderer.');
      const widget=f.widget??(dateInputs.has(name)?'date':schema.enum||reference?'select':schema.type==='integer'?'number':schema.type==='boolean'?'checkbox':'text');
      if(!['date','select','number','checkbox','text'].includes(widget))throw Error('Unsupported field widget.');
      if((widget==='date'&&schema.type!=='string')||(widget==='number'&&schema.type!=='integer')||(widget==='checkbox'&&schema.type!=='boolean')||(widget==='select'&&!schema.enum&&!reference))throw Error('Widget/schema mismatch.');
      if(!f.binding&&((schema.type==='boolean'&&widget!=='checkbox')||(schema.type==='integer'&&widget!=='number')))throw Error('Unsupported schema/widget override.');
      if((schema.enum||reference)&&widget!=='select')throw Error('Enums and references require select widgets.');
      if(computed.has(name)&&f.binding)throw Error('Computed input cannot also have binding.');
      if((f.binding||computed.has(name))&&Object.hasOwn(f,'default'))throw Error('Hidden bound/computed inputs cannot have client defaults.');
      return {name,schema,label:f.label??title(name),widget,hidden:!!f.binding||computed.has(name),...(f.binding?{binding:f.binding}:{}),...(reference?{reference}:{}),...(f.default!==undefined?{default:f.default}:{})};
    });
    return [id,{id,label:config.label??title(id),description:config.description??'',fields,adapters:mappings,policies:a.policies,preconditions:a.preconditions}];
  }));
  const views=Object.hasOwn(meta,'views')?meta.views:Object.keys(model.resources).map(resource=>({kind:'list',resource}));
  if(!Array.isArray(views))throw Error('Expected views array.');
  const resolvedViews=views.map(v=>{
    exact(v,['kind','resource','label','loading','columns','key','fields','ownerField'],['kind','resource']);
    validateLoading(v);
    text(v.resource);if(!Object.hasOwn(model.resources,v.resource)||!['list','summary'].includes(v.kind))throw Error('Unsupported view.');
    if(v.label!==undefined)text(v.label);
    if(v.key!==undefined){text(v.key);if(v.key!=='$actor'&&!state.records[v.resource]?.[v.key])throw Error('Unknown view record.');}
    if(Object.hasOwn(v,'ownerField')){text(v.ownerField);if(!Object.hasOwn(model.resources[v.resource].fields,v.ownerField))throw Error('Unknown owner field.');}
    if(v.fields&&v.columns)throw Error('Use fields or columns, not both.');
    const columns=Object.hasOwn(v,'columns')?v.columns:Object.hasOwn(v,'fields')?v.fields:Object.keys(model.resources[v.resource].fields).map(field=>({field}));
    if(!Array.isArray(columns))throw Error('Expected columns array.');
    for(const c of columns){exact(c,['field','label','format'],['field']);text(c.field);if(!Object.hasOwn(model.resources[v.resource].fields,c.field))throw Error('Unknown view field.');if(c.label!==undefined)text(c.label);if(c.format!==undefined&&!['date','text'].includes(c.format))throw Error('Unsupported column format.');if(c.format==='date'&&model.resources[v.resource].fields[c.field].type!=='string')throw Error('Date column requires string schema.');}
    return {...v,label:v.label??title(v.resource),columns:columns.map(c=>({...c,label:c.label??title(c.field)}))};
  });
  const contract=jsonSnapshot({format:'derived-application/v1',title:meta.title,eyebrow:meta.eyebrow??'',subtitle:meta.subtitle??'',scope:meta.scope??'Local identity simulation',...(Object.hasOwn(meta,'loading')?{loading:meta.loading}:{}),actors:meta.actors,actions,views:resolvedViews,resources:model.resources,relationships:model.relationships});
  return {model,runtime,initialState:state,contract};
}
export function inputDefaults(contract,actionId,state,actor){
  const args={};for(const f of contract.actions[actionId].fields){
    if(f.default!==undefined)args[f.name]=typeof f.default==='object'?state.records[f.default.resource]?.[f.default.key==='$actor'?actor:f.default.key]?.values[f.default.field]:f.default;
    else if(!f.hidden)args[f.name]=f.schema.enum?.[0]??(f.reference?Object.keys(state.records[f.reference.resource])[0]:f.schema.type==='integer'?f.schema.min??0:f.schema.type==='boolean'?false:'');
  }return args;
}
export function buildInvocation(contract,{action,actor,args,id,clock}) {
  if(typeof action!=='string'||!Object.hasOwn(contract.actions,action))throw Error('Unknown action.');
  const declaration=contract.actions[action];
  if(!contract.actors.some(a=>a.id===actor))throw Error('Choose a known person.');
  exact(args,declaration.fields.filter(f=>!f.binding).map(f=>f.name));
  const inputs={...args};
  for(const f of declaration.fields)if(f.binding)inputs[f.name]=({actor, 'operation-id':id,clock,constant:f.binding.value})[f.binding.source];
  for(const adapter of declaration.adapters)adapters[adapter.name].apply(inputs,adapter.mapping);
  return {id,actor,clock,action,args:inputs};
}
