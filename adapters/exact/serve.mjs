// Isolated experimental adapter host. Never changes the shared server's guards.
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createApplicationServer} from '../../application/server.mjs';
import {loadSource} from '../../syntax/load.mjs';

export async function startGateway(declaration,{root,directory,port=0}){
  await mkdir(directory,{recursive:true});
  const backend=await createApplicationServer(declaration,{directory});
  const server=createServer(async(req,res)=>{
    try{
      if(req.headers.host!==host||req.headers.origin&&req.headers.origin!==url||req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site'])){res.writeHead(403);res.end('Unexpected host or origin');return;}
      const path=new URL(req.url,url).pathname;
      if(path.startsWith('/api/')){
        // Pinned Exact can replay an unanswered POST on a reused connection.
        res.setHeader('connection','close');
        if(path==='/api/events'){res.writeHead(404);res.end();return;}
        let bytes=0;const chunks=[];for await(const c of req){bytes+=c.length;if(bytes>16384)throw Error('Request too large');chunks.push(c);}
        const r=await fetch(backend.url+path,{method:req.method,headers:{'content-type':'application/json'},...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
        res.writeHead(r.status,{'content-type':'application/json','cache-control':'no-store'});res.end(await r.text());return;
      }
      const file=resolve(root,path==='/'?'index.html':'.'+path);
      if(!file.startsWith(resolve(root)+'/'))throw Error('Invalid path');
      const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm'};
      const data=await readFile(file);res.writeHead(200,{'content-type':types[extname(file)]??'application/octet-stream'});res.end(data);
    }catch(e){if(!res.headersSent)res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));}
  });
  try{
    await once(server.listen(port,'127.0.0.1'),'listening');
  }catch(e){await backend.close();throw e;}
  const host=`127.0.0.1:${server.address().port}`,url=`http://${host}`;
  return {url,backendUrl:backend.url,async close(){
    const stopped=new Promise((yes,no)=>server.close(e=>e?no(e):yes()));
    server.closeAllConnections();
    try{await stopped;}finally{await backend.close();}
  }};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [model='leave/model.mjs',root='artifacts/exact-app/dist',port='4186',directory='/tmp/opencode/exact-http-data']=process.argv.slice(2);
  const declaration=model.endsWith('.domain')?loadSource(resolve(model)).declaration:(await import(pathToFileURL(resolve(model)))).default;
  const gateway=await startGateway(declaration,{root,directory,port:Number(port)});
  console.log(`Exact adapter ${gateway.url}; shared backend ${gateway.backendUrl}; data ${directory}`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void gateway.close();});
}
