import {mkdir, writeFile} from 'node:fs/promises';
import {bundleBrowser} from '../../browser-build.ts';

const bundle = await bundleBrowser(new URL('./browser.ts', import.meta.url));
await mkdir(new URL('./dist/', import.meta.url), {recursive: true});
await writeFile(new URL('./dist/app.js', import.meta.url), bundle);
