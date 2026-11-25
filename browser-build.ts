import {fileURLToPath} from 'node:url';
import {build} from 'vite-plus';

export async function bundleBrowser(entry: URL, define: Record<string, string> = {}): Promise<string> {
  const result = await build({
    configFile: false,
    define,
    logLevel: 'error',
    publicDir: false,
    build: {
      write: false,
      lib: {entry: fileURLToPath(entry), formats: ['es']},
      minify: true,
      rolldownOptions: {output: {codeSplitting: false}},
    },
  });
  if (!Array.isArray(result) || result.length !== 1 || result[0].output.length !== 1)
    throw Error(`Expected a single browser bundle for ${entry.pathname}`);
  const [chunk] = result[0].output;
  if (chunk.type !== 'chunk') throw Error(`Expected a JavaScript bundle for ${entry.pathname}`);
  return chunk.code;
}

export function browserBundle(entry: URL): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => pending ??= bundleBrowser(entry).catch(error => {
    pending = undefined;
    throw error;
  });
}
