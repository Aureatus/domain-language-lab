// Isolated experimental adapter host. Never changes the shared server's guards.
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {createApplicationServer} from '../../application/server.mjs';
import {loadSource} from '../../syntax/load.mjs';
const [model='leave/model.mjs',root='artifacts/exact-app/dist',port='4186',directory='/tmp/opencode/exact-http-data']=process.argv.slice(2);
await mkdir(directory,{recursive:true});
const declaration=model.endsWith('.domain')?loadSource(resolve(model)).declaration:(await import(new URL(resolve(model),'file://'))).default;
const backend=await createApplicationServer(declaration,{directory});
const origin=`http://127.0.0.1:${port}`;
const server=createServer(async(req,res)=>{
  try{
    if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site'])){res.writeHead(403);res.end('Unexpected host or origin');return;}
    const path=new URL(req.url,origin).pathname;
    if(path.startsWith('/api/')){
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
server.listen(Number(port),'127.0.0.1',()=>console.log(`Exact adapter ${origin}; shared backend ${backend.url}; data ${directory}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{server.closeAllConnections();server.close();await backend.close();process.exit();});
