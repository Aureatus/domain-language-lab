import {createInterpreter,validateState,jsonSnapshot} from '../semantic/v2/core.ts';
import {ownValue} from '../semantic/core.ts';
import type {Action, FieldSchema, Invocation, Model, State, Value} from '../semantic/v2/types.ts';
import {adapters} from './inputs.ts';
import {loadingModes} from './loading.ts';
export {loadingModes};
type FieldReference = {resource:string; key:string; field:string};
export type ApplicationField = {name:string; schema:FieldSchema; label:string; widget:string; hidden:boolean;
  binding?:{source:'actor'|'operation-id'|'clock'|'constant'; value?:Value};
  reference?:{resource:string; labelField?:string}; default?:Value|FieldReference};
export type ApplicationAction = {id:string; label:string; description:string; fields:ApplicationField[];
  adapters:{name:keyof typeof adapters; mapping:Parameters<(typeof adapters)['utc-weekday-range/v1']['validate']>[0]}[];
  policies:Action['policies']; preconditions:Action['preconditions']};
type ApplicationView = {kind:'list'|'summary'; resource:string; label:string; loading?:typeof loadingModes[number]; key?:string; ownerField?:string;
  columns:{field:string; label:string; format?:'date'|'text'}[]};
export type ApplicationContract = {format:string; title:string; eyebrow:string; subtitle:string; scope:string; loading?:typeof loadingModes[number];
  actors:{id:string; label:string; name?:string}[]; actions:Record<string,ApplicationAction>; views:ApplicationView[];
  resources:Model['resources']; relationships:Model['relationships']};

const title=(s:string)=>s.replace(/[._-]/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase());
export function exact(value:unknown,keys:readonly string[],required:readonly string[]=[]):asserts value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(value,k)))throw Error(`Unsupported or missing configuration members (allowed: ${keys.join(', ')}).`);
}
const text=(s:unknown)=>{if(typeof s!=='string'||!s.length)throw Error('Expected nonempty text.');return s;};
const optionalText=(s:unknown)=>s===undefined?undefined:text(s);
const array=(value:unknown,message:string):readonly unknown[]=>{if(!Array.isArray(value))throw Error(message);return value;};
function validateLoading(config:Record<string,unknown>){
  if(!Object.hasOwn(config,'loading'))return undefined;
  const loading=config['loading'];
  if(typeof loading!=='string'||!loadingModes.includes(loading))throw Error(`Expected loading mode: ${loadingModes.join(', ')}.`);
  return loading;
}
function objectMap(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected a configuration object.');return Object.fromEntries(Object.entries(value));}
function isValue(value:unknown):value is Value {
  return typeof value==='string'||typeof value==='boolean'||typeof value==='number'||Array.isArray(value)&&value.every(v=>typeof v==='string');
}
function conforms(schema:FieldSchema,value:unknown){
  return schema.type==='string'?typeof value==='string'&&(!schema.enum||schema.enum.includes(value)):schema.type==='integer'?typeof value==='number'&&Number.isSafeInteger(value)&&(schema.min===undefined||value>=schema.min)&&(schema.max===undefined||value<=schema.max):schema.type==='boolean'?typeof value==='boolean':Array.isArray(value)&&value.every(v=>typeof v==='string');
}
function fieldRef(model:Model,ref:unknown):FieldReference {
  exact(ref,['resource','key','field'],['resource','key','field']);
  const resource=text(ref['resource']),field=text(ref['field']);
  if(!model.resources[resource]?.fields[field])throw Error('Unknown resource/field reference.');
  return {...ref,resource,field,key:text(ref['key'])};
}
export function deriveApplication(declaration:unknown) {
  exact(declaration,['domain','initialState','application'],['domain','initialState','application']);
  const {domain,initialState,application}=declaration;
  const runtime=createInterpreter(domain),model=runtime.model,state=validateState(model,initialState),meta=jsonSnapshot(application);
  exact(meta,['version','title','eyebrow','subtitle','scope','loading','actors','actions','views'],['version','title','actors']);
  const loading=validateLoading(meta);
  if(meta['version']!=='model-application/v1')throw Error('Unsupported application version.');
  const {title:heading,eyebrow,subtitle,scope}=meta;
  const configs=Object.hasOwn(meta,'actions')?objectMap(meta['actions']):{};
  const actorIds=new Set<string>();
  const actors=array(meta['actors'],'Declare local simulation actors.').map(a=>{
    exact(a,['id','label','name'],['id','label']);
    const id=text(a['id']),label=text(a['label']),name=optionalText(a['name']);
    if(actorIds.has(id))throw Error('Duplicate actor.');
    actorIds.add(id);return {...a,id,label,...(name===undefined?{}:{name})};
  });
  if(!actors.length)throw Error('Declare local simulation actors.');
  for(const [name,config] of Object.entries(configs)){if(!Object.hasOwn(model.actions,name))throw Error(`Unknown action ${name}`);objectMap(config);}
  const actions=Object.fromEntries(Object.entries(model.actions).map(([id,a]): [string,ApplicationAction]=>{
    const config=ownValue(configs,id)??{};
    exact(config,['label','description','fields','adapters']);
    const label=optionalText(config['label'])??title(id),description=optionalText(config['description'])??'';
    const fieldConfigs=Object.hasOwn(config,'fields')?objectMap(config['fields']):{};
    for(const [name,fieldConfig] of Object.entries(fieldConfigs)){if(!Object.hasOwn(a.inputs,name))throw Error(`Unknown action input ${name}`);objectMap(fieldConfig);}
    const computed=new Set<string>(),dateInputs=new Set<string>();
    const mappings:ApplicationAction['adapters']=(Object.hasOwn(config,'adapters')?array(config['adapters'],'Expected adapters array.'):[]).map(item=>{
      exact(item,['name','mapping'],['name','mapping']);
      const name=item['name'],raw=item['mapping'];
      if(name!=='utc-weekday-range/v1')throw Error(`Unsupported adapter ${name}`);
      exact(raw,['start','end','output'],['start','end','output']);
      const mapping={...raw,start:text(raw['start']),end:text(raw['end']),output:text(raw['output'])};
      adapters[name].validate(mapping,a.inputs);
      if(computed.has(mapping.output))throw Error('Conflicting adapter output.');
      computed.add(mapping.output);dateInputs.add(mapping.start);dateInputs.add(mapping.end);
      return {...item,name,mapping};
    });
    const fields=Object.entries(a.inputs).map(([name,schema]):ApplicationField=>{
      const f=ownValue(fieldConfigs,name)??{};
      exact(f,['label','default','binding','reference','widget']);
      const fieldLabel=optionalText(f['label'])??title(name);
      let binding:ApplicationField['binding'],reference:ApplicationField['reference'],defaultValue:ApplicationField['default'];
      if(Object.hasOwn(f,'binding')){
        const raw=f['binding'];exact(raw,['source','value'],['source']);
        const source=raw['source'];
        if(source==='constant'){
          if(!Object.hasOwn(raw,'value'))throw Error('Missing constant.');
          if(!isValue(raw['value']))throw Error('Binding/schema mismatch.');
          binding={...raw,source,value:raw['value']};
        }else{
          if(source!=='actor'&&source!=='operation-id'&&source!=='clock')throw Error('Unsupported input binding.');
          if(Object.hasOwn(raw,'value'))throw Error('Unexpected binding value.');
          binding={...raw,source};
        }
      }
      if(Object.hasOwn(f,'default')){
        const raw=f['default'];
        let values:unknown[];
        if(raw&&typeof raw==='object'){
          const ref=fieldRef(model,raw);
          if(ref.key!=='$actor'&&!state.records[ref.resource]?.[ref.key])throw Error('Unknown default record.');
          values=Object.entries(state.records[ref.resource]??{}).filter(([key])=>ref.key==='$actor'?actorIds.has(key):key===ref.key).map(([,r])=>r.values[ref.field]);
          defaultValue=ref;
        }else{
          if(!isValue(raw))throw Error('Default/schema mismatch.');
          values=[raw];defaultValue=raw;
        }
        if(!values.length||values.some(v=>!conforms(schema,v)))throw Error('Default/schema mismatch.');
      }
      if(binding){const values=binding.source==='actor'?[...actorIds]:binding.source==='constant'?[binding.value]:binding.source==='clock'?[0]:['operation-example'];if(values.some(v=>!conforms(schema,v)))throw Error('Binding/schema mismatch.');}
      if(Object.hasOwn(f,'reference')){
        const raw=f['reference'];exact(raw,['resource','labelField'],['resource']);
        reference={...raw,resource:text(raw['resource']),...(Object.hasOwn(raw,'labelField')?{labelField:text(raw['labelField'])}:{})};
      }
      if(!reference){const b=a.bindings.find(b=>b.key.op==='input'&&b.key.name===name);if(b)reference={resource:b.resource};}
      if(reference){const resource=Object.hasOwn(model.resources,reference.resource)?model.resources[reference.resource]:undefined;if(schema.type!=='string'||!resource||(reference.labelField&&!Object.hasOwn(resource.fields,reference.labelField)))throw Error('Unknown or incompatible input reference.');}
      if(schema.type==='ids'&&!binding)throw Error('Visible ids inputs are not supported by this renderer.');
      const choices=schema.type==='string'?schema.enum:undefined;
      const widget=f['widget']??(dateInputs.has(name)?'date':choices||reference?'select':schema.type==='integer'?'number':schema.type==='boolean'?'checkbox':'text');
      if(widget!=='date'&&widget!=='select'&&widget!=='number'&&widget!=='checkbox'&&widget!=='text')throw Error('Unsupported field widget.');
      if((widget==='date'&&schema.type!=='string')||(widget==='number'&&schema.type!=='integer')||(widget==='checkbox'&&schema.type!=='boolean')||(widget==='select'&&!choices&&!reference))throw Error('Widget/schema mismatch.');
      if(!binding&&((schema.type==='boolean'&&widget!=='checkbox')||(schema.type==='integer'&&widget!=='number')))throw Error('Unsupported schema/widget override.');
      if((choices||reference)&&widget!=='select')throw Error('Enums and references require select widgets.');
      if(computed.has(name)&&binding)throw Error('Computed input cannot also have binding.');
      if((binding||computed.has(name))&&Object.hasOwn(f,'default'))throw Error('Hidden bound/computed inputs cannot have client defaults.');
      return {name,schema,label:fieldLabel,widget,hidden:!!binding||computed.has(name),...(binding?{binding}:{}),...(reference?{reference}:{}),...(defaultValue!==undefined?{default:defaultValue}:{})};
    });
    return [id,{id,label,description,fields,adapters:mappings,policies:a.policies,preconditions:a.preconditions}];
  }));
  const views=Object.hasOwn(meta,'views')?array(meta['views'],'Expected views array.'):Object.keys(model.resources).map(resource=>({kind:'list',resource}));
  const resolvedViews=views.map((v):ApplicationView=>{
    exact(v,['kind','resource','label','loading','columns','key','fields','ownerField'],['kind','resource']);
    const viewLoading=validateLoading(v),resourceId=text(v['resource']),kind=v['kind'];
    const resource=Object.hasOwn(model.resources,resourceId)?model.resources[resourceId]:undefined;
    if(!resource||(kind!=='list'&&kind!=='summary'))throw Error('Unsupported view.');
    const label=optionalText(v['label'])??title(resourceId),key=optionalText(v['key']);
    if(key!==undefined&&key!=='$actor'&&!state.records[resourceId]?.[key])throw Error('Unknown view record.');
    const ownerField=Object.hasOwn(v,'ownerField')?text(v['ownerField']):undefined;
    if(ownerField&&!Object.hasOwn(resource.fields,ownerField))throw Error('Unknown owner field.');
    if(v['fields']&&v['columns'])throw Error('Use fields or columns, not both.');
    const raw=Object.hasOwn(v,'columns')?v['columns']:Object.hasOwn(v,'fields')?v['fields']:Object.keys(resource.fields).map(field=>({field}));
    const columns:ApplicationView['columns']=array(raw,'Expected columns array.').map(c=>{
      exact(c,['field','label','format'],['field']);const field=text(c['field']);
      const spec=Object.hasOwn(resource.fields,field)?resource.fields[field]:undefined;
      if(!spec)throw Error('Unknown view field.');
      const format=c['format'];
      if(format!==undefined&&format!=='date'&&format!=='text')throw Error('Unsupported column format.');
      if(format==='date'&&spec.type!=='string')throw Error('Date column requires string schema.');
      return {...c,field,label:optionalText(c['label'])??title(field),...(format===undefined?{}:{format})};
    });
    return {...v,kind,resource:resourceId,label,columns,...(key===undefined?{}:{key}),...(ownerField===undefined?{}:{ownerField}),...(viewLoading===undefined?{}:{loading:viewLoading})};
  });
  const contract:ApplicationContract=jsonSnapshot({format:'derived-application/v1',title:text(heading),eyebrow:optionalText(eyebrow)??'',subtitle:optionalText(subtitle)??'',scope:optionalText(scope)??'Local identity simulation',...(loading===undefined?{}:{loading}),actors,actions,views:resolvedViews,resources:model.resources,relationships:model.relationships});
  return {model,runtime,initialState:state,contract};
}
function referenceDefault(value:Value|FieldReference):value is FieldReference {
  return typeof value==='object'&&'resource' in value;
}
export function inputDefaults(contract:ApplicationContract,actionId:string,state:State,actor:string){
  const action=Object.hasOwn(contract.actions,actionId)?contract.actions[actionId]:undefined;
  if(!action)throw Error('Unknown action.');
  const args:Record<string,Value|undefined>={};for(const f of action.fields){
    if(f.default!==undefined)args[f.name]=referenceDefault(f.default)?state.records[f.default.resource]?.[f.default.key==='$actor'?actor:f.default.key]?.values[f.default.field]:f.default;
    else if(!f.hidden)args[f.name]=(f.schema.type==='string'?f.schema.enum?.[0]:undefined)??(f.reference?Object.keys(state.records[f.reference.resource]??{})[0]:f.schema.type==='integer'?f.schema.min??0:f.schema.type==='boolean'?false:'');
  }return args;
}
export function buildInvocation(contract:ApplicationContract,{action,actor,args,id,clock}:{action:string;actor:string;args:unknown;id:string;clock:number}):Invocation {
  const declaration=typeof action==='string'&&Object.hasOwn(contract.actions,action)?contract.actions[action]:undefined;
  if(!declaration)throw Error('Unknown action.');
  if(!contract.actors.some(a=>a.id===actor))throw Error('Choose a known person.');
  exact(args,declaration.fields.filter(f=>!f.binding).map(f=>f.name));
  const inputs={...args};
  for(const f of declaration.fields)if(f.binding)inputs[f.name]=({actor, 'operation-id':id,clock,constant:f.binding.value})[f.binding.source];
  for(const adapter of declaration.adapters)adapters[adapter.name].apply(inputs,adapter.mapping);
  const values:Record<string,Value>={};
  for(const [key,value] of Object.entries(inputs)){
    if(!isValue(value))throw Error(`Invalid input: ${key}`);
    values[key]=value;
  }
  return {id,actor,clock,action,args:values};
}
