// Executable authored-source accounting, not an estimate of saved work.
// Usage: node application/count.mjs APP_DIR ENTRY [LAUNCHER] [--report OUTPUT]
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,relative,dirname,sep} from 'node:path';
const argv=process.argv.slice(2),reportIndex=argv.indexOf('--report');
const reportPath=reportIndex<0?null:argv.splice(reportIndex,2)[1];
const [directory,...entries]=argv;
if(!directory||!entries.length)throw Error('Usage: count.mjs APP_DIR ENTRY [LAUNCHER] [--report OUTPUT]');
const root=resolve(directory),authored=new Map(),external=new Set();
async function visit(path){
  if(authored.has(path))return;
  const source=await readFile(path,'utf8'),rel=relative(root,path);
  authored.set(path,{path:relative(process.cwd(),path),lines:source.split('\n').length-(source.endsWith('\n')?1:0),nonblankLines:source.split('\n').filter(l=>l.trim()).length,bytes:Buffer.byteLength(source)});
  if(path.endsWith('.domain')){
    const {loadSource}=await import('../syntax/load.mjs');
    for(const module of loadSource(path).modules)if(module.filename!==path)await visit(module.filename);
    return;
  }
  // Explicit closed frontend loading convention; count the actual text too.
  for(const match of source.matchAll(/loadSource\(new URL\(['"]([^'"]+\.domain)['"],import\.meta\.url\)\)/g)){
    await visit(resolve(dirname(path),match[1]));
  }
  if(source.includes('loadSource(')&&!source.match(/loadSource\(new URL\(['"][^'"]+\.domain['"],import\.meta\.url\)\)/))throw Error(`Unsupported source loading syntax in ${rel}; cannot safely count.`);
  // This report supports the repository's explicit static ESM `from` imports.
  // Dynamic or side-effect imports fail rather than silently undercounting.
  if(/\bimport\s*\(|\bimport\s*['"]/.test(source))throw Error(`Unsupported import syntax in ${rel}; extend accounting before claiming a count.`);
  for(const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)){
    if(!match[1].startsWith('.')){external.add(match[1]);continue;}
    const target=resolve(dirname(path),match[1]);
    if(target.startsWith(root+sep))await visit(target);else external.add(relative(process.cwd(),target));
  }
}
for(const entry of entries)await visit(resolve(root,entry));
const files=[...authored.values()].sort((a,b)=>a.path.localeCompare(b.path));
const excluded=(await readdir(root,{withFileTypes:true})).filter(e=>!authored.has(resolve(root,e.name))).map(e=>({path:relative(process.cwd(),resolve(root,e.name)),reason:e.isDirectory()?'demo assets/tooling (not entry import closure)':'test/demo/evidence tooling (not entry import closure)'}));
const report={scope:'Per-application static ESM import closure plus explicit loadSource(new URL(...)) and recursively resolved relative .domain imports; all selected view entries counted. Framework, tests, demo tooling and media excluded. No baseline/savings claim.',directory:root,entries,files,total:{files:files.length,lines:files.reduce((n,f)=>n+f.lines,0),nonblankLines:files.reduce((n,f)=>n+f.nonblankLines,0),bytes:files.reduce((n,f)=>n+f.bytes,0)},externalImports:[...external].sort(),excluded};
if(reportPath)await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
