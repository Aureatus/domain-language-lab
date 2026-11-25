import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {bundleBrowser} from '../browser-build.ts';

const worker = await bundleBrowser(new URL('./worker.ts', import.meta.url));
const bundle = await bundleBrowser(new URL('./app.ts', import.meta.url), {__liveWorkerSource: JSON.stringify(worker)});
const template = await readFile(new URL('./template.html', import.meta.url), 'utf8');
await mkdir(new URL('../artifacts/', import.meta.url), {recursive: true});
await writeFile(new URL('../artifacts/live-issues.html', import.meta.url), template.replace('/* BUNDLE */', () => bundle.replace(/<\/script/gi, '<\\/script')));
console.log('Built artifacts/live-issues.html · inline core + derive + UI · no precomputed traces');
