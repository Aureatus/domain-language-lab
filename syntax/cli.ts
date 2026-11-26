import {resolve} from 'node:path';
import {loadSource} from './load.ts';
const [command,path]=process.argv.slice(2);
if((command!=='check'&&command!=='serve')||!path)throw Error('Usage: node syntax/cli.ts check|serve SOURCE.domain');
const {declaration,sourceMap}=loadSource(resolve(path));
if(command==='check')console.log(`Valid ${declaration.domain.id}: ${Object.keys(sourceMap).length} source mappings; semantic-core/v2 + model-application/v1.`);
else {
  if(!declaration.application)throw Error('Missing application block.');
  const {createApplicationServer}=await import('../application/server.ts');
  const server=await createApplicationServer(declaration,{directory:resolve(process.env['APPLICATION_DIR']??'artifacts/syntax-data'),port:Number(process.env['PORT']??4174)});
  console.log(`${declaration.application.title}: ${server.url}`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close().catch(console.error));
}
