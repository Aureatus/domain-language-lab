import {errorMessage} from '../errors.ts';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseSource,SourceError} from './frontend.ts';
import {loadSource} from './load.ts';
import {encodeJsonPretty} from '../adapters/effect/json.ts';

// Advisories are deliberately narrower than validation. No safety/proof claims.
type Diagnostic={filename:string;line:number;column:number;severity:'error'|'warning';ruleId:string;message:string};
type Parsed=ReturnType<typeof parseSource>;
export function lintSource(source:string,{filename='<source>',parsed:provided}:{filename?:string;parsed?:Parsed}={}){
  const diagnostics:Diagnostic[]=[];
  const report=(ruleId:string,severity:Diagnostic['severity'],line:number,column:number,message:string)=>diagnostics.push({filename,line,column,severity,ruleId,message});
  let parsed:Parsed;
  try{parsed=provided??parseSource(source,{filename});}catch(error){
    if(error instanceof SourceError)report(error.ruleId??'domain/invalid-source','error',error.line,error.column,error.message.replace(`${filename}:${error.line}:${error.column}: `,''));
    else report('domain/invalid-source','error',1,1,error instanceof Error?error.message:String(error));
    return diagnostics;
  }
  source.split('\n').forEach((line,i)=>{
    const trailing=/[\t ]+(?=\r?$)/.exec(line);
    if(trailing)report('style/trailing-whitespace','warning',i+1,trailing.index+1,'Remove trailing whitespace (advisory; no automatic repair).');
    const indent=/^[ \t]*\t/.exec(line);
    if(indent)report('style/tab-indentation','warning',i+1,line.indexOf('\t')+1,'Use spaces for indentation; tab display widths vary.');
  });
  for(const [id,action] of Object.entries(parsed.declaration.domain.actions)){
    const span=parsed.sourceMap[id];
    if(!span)throw Error(`Missing source span for '${id}'.`);
    if(provided&&span.filename!==filename)continue;
    const used=new Set<string|number>();
    const visit=(value:unknown)=>{
      if(!value||typeof value!=='object')return;
      if('op' in value&&value.op==='input'&&'name' in value&&typeof value.name==='string')used.add(value.name);
      for(const child of Object.values(value))visit(child);
    };
    visit(action);
    // Adapter mappings consume input names outside core expressions. Hidden host
    // bindings are intentional interface contracts, not unused user inputs.
    const metadata=parsed.declaration.application?.actions[id];
    for(const adapter of metadata?.adapters??[])for(const name of Object.values(adapter.mapping))used.add(name);
    for(const [name,field] of Object.entries(metadata?.fields??{}))if(field.binding)used.add(name);
    for(const name of Object.keys(action.inputs))if(!used.has(name)){
      const token=parsed.inputLocations[id]?.[name];
      report('usage/unused-input','warning',token?.line??span.start.line,token?.column??span.start.column,`Input '${name}' has no core expression, host binding or adapter reference; review whether it is intended.`);
    }
  }
  return diagnostics.sort((a,b)=>a.line-b.line||a.column-b.column||a.ruleId.localeCompare(b.ruleId));
}

export function lintCLI(args:string[]){
  const json=args.includes('--json'),strict=args.includes('--strict');
  const paths=args.filter(x=>!x.startsWith('--'));
  const [path]=paths;
  let diagnostics:Diagnostic[]=[];
  if(!path||paths.length!==1||args.some(x=>x.startsWith('--')&&!['--json','--strict'].includes(x))){
    diagnostics=[{filename:paths[0]??'<cli>',line:1,column:1,severity:'error',ruleId:'cli/usage',message:'Usage: syntax:lint -- PATH [--json] [--strict]'}];
  }else try{
    const parsed=loadSource(path);
    diagnostics=parsed.modules.flatMap(m=>lintSource(m.source,{filename:m.filename,parsed}));
  }
  catch(error){diagnostics=[{filename:path,line:1,column:1,severity:'error',ruleId:'io/read-source',message:errorMessage(error)}];}
  const errors=diagnostics.filter(d=>d.severity==='error').length,warnings=diagnostics.length-errors;
  if(json)console.log(encodeJsonPretty({diagnostics,errors,warnings}));
  else {
    for(const d of diagnostics)console.log(`${d.filename}:${d.line}:${d.column}: ${d.severity} ${d.ruleId}: ${d.message}`);
    console.log(`${errors} errors, ${warnings} advisory warnings. Not a proof of business correctness.`);
  }
  return errors||strict&&warnings?1:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=lintCLI(process.argv.slice(2));
