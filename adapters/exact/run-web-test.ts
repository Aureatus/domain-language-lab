import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
const directory=await mkdtemp('/tmp/opencode/exact-ui-');
const server=spawn(process.execPath,['adapters/exact/serve.ts','leave/model.ts',process.env.EXACT_DIST??'/tmp/opencode/exact-generated/dist','4186',directory],{stdio:['ignore','pipe','inherit']});
try{
  await new Promise<void>((yes,no)=>{server.once('exit',code=>no(Error(`Server exited ${code}`)));server.stdout.on('data',data=>{process.stdout.write(data);if(String(data).includes('Exact adapter'))yes();});});
  const result=spawn(process.execPath,['adapters/exact/web-test.ts'],{stdio:'inherit'});
  const code=await new Promise(resolve=>result.once('exit',resolve));
  if(code!==0)throw Error(`Exact UI test exited ${code}`);
}finally{server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
