import { readFile, writeFile, mkdir } from 'node:fs/promises';
const core = await readFile(new URL('./core.mjs',import.meta.url),'utf8');
const derive = await readFile(new URL('./derive.mjs',import.meta.url),'utf8');
const app = await readFile(new URL('./app.mjs',import.meta.url),'utf8');
const template = await readFile(new URL('./template.html',import.meta.url),'utf8');
// Browser-only modules, isolated to retain module-local names and import aliases.
if (/^import\s/m.test(core)) throw new Error('Core imports require an explicit bundler update');
const stripExports = text => text.replace(/^export\s+(?=(?:function|const|let|class)\s)/gm,'');
const coreImport = /^import\s+\{\s*createApp(?:\s+as\s+(\w+))?\s*(?:,\s*forkApp(?:\s+as\s+(\w+))?\s*)?\}\s+from ['"]\.\/core\.mjs['"];\s*/m;
if (!coreImport.test(derive)) throw new Error('Expected derive core import');
const deriveBody=derive.replace(coreImport,(_,createAlias,forkAlias)=>`const ${createAlias || 'createApp'} = __liveCore.createApp;\nconst ${forkAlias || 'forkApp'} = __liveCore.forkApp;\n`);
const appBody=app.replace(/^import\s+\{ createApp \}\s+from '\.\/core\.mjs';\s*/m,'const { createApp } = __liveCore;\n').replace(/^import\s+\{ describeChange \}\s+from '\.\/derive\.mjs';\s*/m,'const { describeChange } = __liveDerive;\n');
const shared = `const __liveCore = (()=>{\n${stripExports(core)}\nreturn {createApp,forkApp};\n})();\nconst __liveDerive = (()=>{\n${stripExports(deriveBody)}\nreturn {describeChange,runDerivedChecks};\n})();\n`;
const worker = `${shared}\nself.onmessage = ({data}) => {try { self.postMessage({id:data.id,report:__liveDerive.runDerivedChecks(data.workspace)}); } catch (error) { self.postMessage({id:data.id,error:String(error.message ?? error)}); }};`;
const bundled = `${shared}\nconst __liveWorkerSource = ${JSON.stringify(worker)};\n${appBody}`;
if (/^\s*(?:import|export)\s/m.test(bundled)) throw new Error('Unsupported module syntax');
await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
await writeFile(new URL('../artifacts/live-issues.html',import.meta.url),template.replace('/* BUNDLE */',()=>bundled.replace(/<\/script/gi,'<\\/script')));
console.log('Built artifacts/live-issues.html · inline core + derive + UI · no precomputed traces');
