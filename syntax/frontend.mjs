// Experimental closed text frontend. Module resolution lives in load.mjs.
import {deriveApplication,loadingModes} from '../application/derive.mjs';
import {createInterpreter,validateState} from '../semantic/v2/core.mjs';

export class SourceError extends SyntaxError {
  constructor(filename, token, message) {
    super(`${filename}:${token.line}:${token.column}: ${message}`);
    this.filename=filename;this.line=token.line;this.column=token.column;
  }
}

export function tokenize(source, filename='<source>') {
  const out=[];let i=0,line=1,column=1;
  const push=(kind,value,start,l,c)=>out.push({kind,value,start,end:i,line:l,column:c});
  while(i<source.length){
    const start=i,l=line,c=column,ch=source[i];
    if(ch===' '||ch==='\t'||ch==='\r'){i++;column++;continue;}
    if(ch==='#'){while(i<source.length&&source[i]!=='\n'){i++;column++;}continue;}
    if(ch==='\n'){i++;push('newline','\n',start,l,c);line++;column=1;continue;}
    if(ch==='"'){
      i++;column++;let value='',closed=false;
      while(i<source.length&&source[i]!=='\n'){
        let v=source[i++];column++;
        if(v==='"'){closed=true;break;}
        if(v==='\\'){
          const escape=source[i++];column++;
          const escapes={'n':'\n','r':'\r','t':'\t','"':'"','\\':'\\'};
          if(!Object.hasOwn(escapes,escape))throw new SourceError(filename,{line:l,column:c},'Unsupported string escape.');
          v=escapes[escape];
        }
        value+=v;
      }
      if(!closed)throw new SourceError(filename,{line:l,column:c},'Unterminated string.');
      push('string',value,start,l,c);continue;
    }
    const word=/^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i));
    if(word){i+=word[0].length;column+=word[0].length;push('word',word[0],start,l,c);continue;}
    const number=/^\d+/.exec(source.slice(i));
    if(number){i+=number[0].length;column+=number[0].length;push('number',Number(number[0]),start,l,c);continue;}
    const op=/^(<=|>=|==|!=|[.()+*\-<>=])/.exec(source.slice(i));
    if(op){i+=op[0].length;column+=op[0].length;push('symbol',op[0],start,l,c);continue;}
    throw new SourceError(filename,{line,column},`Unexpected character ${JSON.stringify(ch)}.`);
  }
  out.push({kind:'newline',value:'\n',start:i,end:i,line,column});
  out.push({kind:'eof',value:'<eof>',start:i,end:i,line,column});return out;
}

export function parseSource(source,{filename='<source>',allowMissingApplication=false}={}) {
  const tokens=tokenize(source,filename);let pos=0,last=tokens[0];
  const sourceMap=Object.create(null),inputLocations=Object.create(null),ids=new Set(),bindings=new Map(),sections=[];let inputs={};
  const domain={format:'semantic-core/v2',id:'',resources:{},relationships:[],actions:{}};
  const initialState={revision:0,records:{}};
  let application,identity;const selectors=new Map(),references=new Map(),bindingOrigins=[];
  const peek=()=>tokens[pos];
  const is=v=>peek().value===v&&peek().kind!=='string';
  const take=()=>last=tokens[pos++];
  const fail=(message,t=peek())=>{throw new SourceError(filename,t,message);};
  const expect=v=>{if(!is(v))fail(`Expected '${v}', found ${JSON.stringify(peek().value)}.`);return take();};
  const accept=v=>is(v)?take():null;
  const name=()=>{if(!['word','string'].includes(peek().kind))fail('Expected a name or quoted semantic ID.');return take().value;};
  const text=()=>{if(peek().kind!=='string')fail('Expected quoted text.');return take().value;};
  const number=()=>{if(peek().kind!=='number'||!Number.isSafeInteger(peek().value))fail('Expected a safe integer.');return take().value;};
  const nl=()=>{expect('\n');while(is('\n'))take();};
  const unique=(object,key,value)=>{if(Object.hasOwn(object,key))fail(`Duplicate declaration '${key}'.`,last);Object.defineProperty(object,key,{value,enumerable:true,writable:true,configurable:true});return value;};
  const mark=(id,start)=>{
    if(ids.has(id))fail(`Duplicate semantic ID '${id}'.`,start);ids.add(id);
    sourceMap[id]={filename,start:{offset:start.start,line:start.line,column:start.column},end:{offset:last.end,line:last.line,column:last.column+last.end-last.start}};
    return id;
  };
  const annotation=()=>{expect('id');return name();};
  function binding(alias,t){
    if(bindings.has(alias))return bindings.get(alias);
    const candidates=[...(references.get(alias)??[]),...(selectors.has(alias)?[selectors.get(alias)]:[])];
    if(candidates.length!==1)fail(`${candidates.length?'Ambiguous':'Unknown'} reference '${alias}'.`,t);
    const candidate=candidates[0],id=`${identity}.${alias}`;
    mark(id,candidate.token);const b={id,resource:candidate.resource};bindings.set(alias,b);
    bindingOrigins.push({id,alias,identity,resource:b.resource,kind:candidate.key.op==='input'?'typed-reference':'singleton-selector',key:structuredClone(candidate.key)});
    currentAction.bindings.push({...b,key:candidate.key});return b;
  }
  let currentAction;
  function block(body){nl();while(!(is('end')&&tokens[pos+1]?.kind==='newline')){if(peek().kind==='eof')fail("Unclosed block: expected 'end'.");body();}take();}
  function schema(allowReference=false){
    if(accept('like')){
      const resource=name();expect('.');const field=name();
      const fields=Object.hasOwn(domain.resources,resource)?domain.resources[resource].fields:{};
      const original=Object.hasOwn(fields,field)?fields[field]:undefined;
      if(!original)fail(`Unknown schema source '${resource}.${field}'.`,last);
      return structuredClone(original);
    }
    if(is('\n')){
      const s={};block(()=>{
        const t=take(),key=t.value;
        if(key==='type')unique(s,key,name());
        else if(key==='min'||key==='max')unique(s,key,number());
        else if(key==='enum'){const values=[];while(peek().kind==='string')values.push(text());if(!values.length)fail('Expected at least one enum value.');unique(s,key,values);}
        else fail('Expected type, min, max or enum.',t);
        nl();
      });
      if(!s.type)fail('Expanded schema requires type.');
      if(!['string','integer','boolean'].includes(s.type))fail(`Unsupported schema '${s.type}'.`);
      return s;
    }
    if(accept('reference')){
      if(!allowReference)fail('Typed resource references are supported on action inputs only.',last);
      const token=last,resource=name();if(!Object.hasOwn(domain.resources,resource))fail(`Unknown resource '${resource}'.`,token);
      expect('as');const alias=name();
      if(references.has(alias)||selectors.has(alias)||bindings.has(alias))fail(`Ambiguous reference '${alias}'.`,token);
      const candidates=references.get(alias)??[];candidates.push({resource,token,key:{op:'input',name:currentInput}});references.set(alias,candidates);
      return {type:'string'};
    }
    const type=name();if(!['string','integer','boolean'].includes(type))fail(`Unsupported schema '${type}'.`,last);
    const s={type};if(accept('min'))s.min=number();if(accept('max'))s.max=number();
    if(accept('enum')){s.enum=[];while(peek().kind==='string')s.enum.push(text());if(!s.enum.length)fail('Expected at least one enum value.');}
    return s;
  }
  function scalar(){
    if(peek().kind==='string')return text();if(accept('-'))return -number();if(peek().kind==='number')return number();
    if(accept('true'))return true;if(accept('false'))return false;fail('Expected a literal value.');
  }
  const operators={or:[1,'or'],and:[2,'and'],'==':[3,'eq'],'!=':[3,'neq'],'<':[4,'lt'],'<=':[4,'le'],'>':[4,'gt'],'>=':[4,'ge'],'+':[5,'add'],'-':[5,'sub']};
  function expression(min=0){
    let left;
    if(accept('not'))left={op:'not',value:expression(3)};
    else if(accept('(')){left=expression();expect(')');}
    else if(peek().kind==='string'||peek().kind==='number'||is('true')||is('false')||is('-'))left={op:'literal',value:scalar()};
    else {
      const t=peek(),n=name();
      if(accept('.')){
        const f=name();
        if(n==='input'){if(!Object.hasOwn(inputs,f))fail(`Unknown input '${f}'.`,t);left={op:'input',name:f};}
        else {const b=binding(n,t);if(!domain.resources[b.resource]?.fields[f])fail(`Unknown binding/field '${n}.${f}'.`,t);left={op:'field',binding:b.id,field:f};}
      } else if(n==='actor'||n==='clock')left={op:n};
      else if(Object.hasOwn(inputs,n))left={op:'input',name:n};
      else fail(`Unknown expression name '${n}'.`,t);
    }
    while(peek().kind!=='string'&&Object.hasOwn(operators,peek().value)&&operators[peek().value][0]>=min){
      const [precedence,op]=operators[take().value],right=expression(precedence+1);
      // v2 has le/lt/eq/not, not ge/gt/neq. Canonicalize surface operators.
      left=op==='ge'?{op:'le',left:right,right:left}:op==='gt'?{op:'lt',left:right,right:left}:op==='neq'?{op:'not',value:{op:'eq',left,right}}:{op,left,right};
    }
    return left;
  }
  let currentInput;
  function action(){
    const start=expect('action'),id=name();mark(id,start);
    const a=unique(domain.actions,id,{inputs:{},bindings:[],preconditions:[],policies:[],updates:[],inserts:[],deletes:[],observe:[]});
    currentAction=a;identity=accept('identity')?name():id;
    inputs=a.inputs;inputLocations[id]=Object.create(null);bindings.clear();references.clear();const observed=new Map();let sawUpdate=false;
    function row(group){
      const t=peek();
      if(group==='changes'&&!is('update')&&!is('create'))fail('Expected update or create in changes.');
      if(group==='policies'&&!['allow','deny','approve'].some(is))fail('Expected allow, deny or approve in policies.');
      if(group==='inputs'||(!group&&accept('input'))){const nt=peek(),n=name();currentInput=n;unique(inputs,n,schema(true));inputLocations[id][n]={line:nt.line,column:nt.column};nl();}
      else if(group==='bindings'||(!group&&accept('bind'))){
        const alias=name();expect('from');const resource=name();expect('key');const key=expression();const bid=is('id')?annotation():`${id}.${alias}`;
        if(observed.has(alias)||bindings.has(alias)||references.has(alias)||selectors.has(alias))fail(`Duplicate binding alias '${alias}'.`,t);
        if(!Object.hasOwn(domain.resources,resource))fail(`Unknown resource '${resource}'.`,t);
        mark(bid,t);bindings.set(alias,{id:bid,resource});observed.set(alias,bid);a.bindings.push({id:bid,resource,key});nl();
      } else if(group==='preconditions'||group==='requires'||(!group&&accept('require'))){if(group)accept('require');const when=expression(),pid=annotation();mark(pid,t);a.preconditions.push({id:pid,when});nl();}
      else if(group==='policies'&&(is('allow')||is('deny'))){const effect=take().value;expect('when');const when=expression(),pid=annotation();mark(pid,t);a.policies.push({id:pid,effect,when});nl();}
      else if(!group&&accept('policy')){
        const pid=name(),effect=name();if(!['allow','deny'].includes(effect))fail('Policy effect must be allow or deny.');
        expect('when');const when=expression();mark(pid,t);a.policies.push({id:pid,effect,when});nl();
      } else if((!group||group==='policies')&&accept('approve')){
        expect('by');const approvers=expression();expect('when');const when=expression(),pid=annotation();mark(pid,t);a.policies.push({id:pid,effect:'approval-required',when,approvers});nl();
      } else if((!group||group==='changes')&&accept('update')){
        if(sawUpdate)fail('Duplicate update block.',t);sawUpdate=true;
        block(()=>{const u=expect('set'),alias=name();expect('.');const field=name();expect('=');const value=expression(),uid=annotation();const b=binding(alias,u);if(!domain.resources[b.resource]?.fields[field])fail(`Unknown update target '${alias}.${field}'.`,u);mark(uid,u);a.updates.push({id:uid,target:b.id,field,value});nl();});nl();
      } else if((!group||group==='changes')&&accept('create')){
        const resource=name();if(!Object.hasOwn(domain.resources,resource))fail(`Unknown resource '${resource}'.`,t);
        expect('key');const key=expression(),iid=annotation();expect('as');const alias=name();
        if(observed.has(alias)||bindings.has(alias)||references.has(alias)||selectors.has(alias))fail(`Duplicate observation alias '${alias}'.`,t);observed.set(alias,iid);
        const values={};block(()=>{const n=name();expect('=');unique(values,n,expression());nl();});mark(iid,t);a.inserts.push({id:iid,resource,key,values});nl();
      } else if(group==='observations'||(!group&&accept('observe'))){
        const alias=name();expect('through');const relationship=name();
        a.observe.push({binding:observed.get(alias)??binding(alias,t).id,relationship});nl();
      } else if(!group&&['inputs','bindings','preconditions','requires','policies','changes','observations'].some(is)){
        const group=take().value;block(()=>row(group));nl();
      } else fail('Expected input, bind, require, policy, approve, update, create or observe.');
    }
    block(()=>row());sourceMap[id].end={offset:last.end,line:last.line,column:last.column+3};nl();
  }
  function presentation(){
    const loading=target=>{expect('loading');if(!loadingModes.some(is))fail(`Expected loading mode: ${loadingModes.join(', ')}.`);unique(target,'loading',take().value);nl();};
    const t=expect('application');if(application)fail('Duplicate application.',t);
    application={version:'model-application/v1',actors:[],actions:{},views:[]};const actorIds=new Set();
    block(()=>{
      if(['title','eyebrow','subtitle','scope'].some(is)){const k=take().value;unique(application,k,text());nl();}
      else if(is('loading'))loading(application);
      else if(accept('actor')){const id=name();if(actorIds.has(id))fail(`Duplicate actor '${id}'.`);actorIds.add(id);expect('label');const label=text();const a={id,label};if(accept('name'))a.name=text();application.actors.push(a);nl();}
      else if(accept('present')){
        const id=name(),p=unique(application.actions,id,{fields:{}});
        block(()=>{
          if(is('label')||is('description')){const k=take().value;unique(p,k,text());nl();}
          else if(accept('field')){
            const n=name(),f=unique(p.fields,n,{});
            block(()=>{
              if(is('label')||is('widget')){const k=take().value;unique(f,k,k==='label'?text():name());nl();}
              else if(accept('bind')){const source=name();unique(f,'binding',{source,...(source==='constant'?{value:scalar()}:{})});nl();}
              else if(accept('default')){
                let value;if(accept('from')){const resource=name();expect('key');const key=text();expect('field');value={resource,key,field:name()};}else value=scalar();
                unique(f,'default',value);nl();
              } else fail('Expected label, widget, bind or default.');
            });nl();
          } else if(accept('adapter')){
            const name=text(),mapping={};
            block(()=>{const k=take().value;if(!['start','end','output'].includes(k))fail('Unknown adapter mapping.',last);unique(mapping,k,take().value);nl();});
            (p.adapters??=[]).push({name,mapping});nl();
          } else fail('Expected label, description, field or adapter.');
        });nl();
      } else if(accept('view')){
        const kind=name(),resource=name(),v={kind,resource};if(accept('key'))v.key=text();expect('label');v.label=text();const fields=[],seen=new Set();
        block(()=>{if(is('loading'))return loading(v);expect('field');const field=name(),f={field};if(seen.has(field))fail(`Duplicate view field '${field}'.`,last);seen.add(field);if(accept('label'))f.label=text();if(accept('format'))f.format=name();fields.push(f);nl();});
        v[kind==='summary'?'fields':'columns']=fields;application.views.push(v);nl();
      } else fail('Expected application text, loading, actor, present or view.');
    });nl();
  }
  while(is('\n'))take();const root=expect('domain');domain.id=name();mark(domain.id,root);nl();
  sections.push({kind:'domain',name:domain.id,line:root.line});
  while(peek().kind!=='eof'){
    const t=peek();
    const section={kind:t.value,name:['resource','relationship','action'].includes(t.value)?tokens[pos+1].value:t.value,line:t.line};
    if(accept('resource')){
      const id=name(),r=unique(domain.resources,id,{fields:{}});mark(id,t);initialState.records[id]={};
      if(accept('singleton')){expect('key');const key=text();selectors.set(id,{resource:id,key:{op:'literal',value:key},token:t});}
      const field=()=>{const f=name();unique(r.fields,f,schema());nl();};
      block(()=>{if(accept('fields')){block(field);nl();}else{expect('field');field();}});sourceMap[id].end={offset:last.end,line:last.line,column:last.column+3};nl();
    } else if(accept('relationships')){
      block(()=>{const start=peek(),resource=name();expect('.');const field=name(),id=is('id')?annotation():`${resource}.${field}`;mark(id,start);domain.relationships.push({id,resource,field});nl();});nl();
    } else if(accept('relationship')){
      const id=name();expect('from');const resource=name();expect('.');const field=name();mark(id,t);domain.relationships.push({id,resource,field});nl();
    } else if(is('action'))action();
    else if(accept('initial')){
      if(Object.hasOwn(sourceMap,'$initial'))fail('Duplicate initial block.',t);expect('revision');initialState.revision=number();
      block(()=>{expect('records');const resource=name();if(!Object.hasOwn(domain.resources,resource))fail(`Unknown resource '${resource}'.`);
        const records=initialState.records[resource];if(Object.hasOwn(sourceMap,`$records.${resource}`))fail(`Duplicate records '${resource}'.`);mark(`$records.${resource}`,last);
        block(()=>{const rt=expect('record'),key=name();expect('version');const version=number(),values={};block(()=>{const f=name();expect('=');unique(values,f,scalar());nl();});unique(records,key,{version,values});mark(`$record.${resource}.${key}`,rt);nl();});nl();
      });mark('$initial',t);nl();
    } else if(is('application'))presentation();
    else fail('Expected resource, relationship, action, initial or application.');
    sections.push(section);
  }
  if(!application&&!allowMissingApplication)fail('Missing application block.');
  const declaration={domain,initialState,application};
  try{if(application)deriveApplication(declaration);else{createInterpreter(domain);validateState(domain,initialState);}}catch(error){
    // Core type/shape validation remains authoritative. A source context is
    // supplied even where the core diagnostic has no structured semantic path.
    const diagnostic=new SourceError(filename,root,`Model/application validation: ${error.message}`);
    diagnostic.ruleId='domain/model-validation';throw diagnostic;
  }
  return {declaration,sourceMap,sections,inputLocations,bindingOrigins};
}
