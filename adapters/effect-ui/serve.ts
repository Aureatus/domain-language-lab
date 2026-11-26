import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createApplicationServer } from "../../application/server.ts";
import declaration from "../../leave/model.ts";

export async function start({ port = 0, model = declaration } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "effect-ui-spike-"));

  try {
    const app = await createApplicationServer(model, {
      directory,
      port,
      staticFiles: {
        "/": new URL("./index.html", import.meta.url),
        "/app.js": new URL("./dist/app.js", import.meta.url),
        "/style.css": new URL("./style.css", import.meta.url),
      },
    });

    return {
      url: app.url,
      async close() {
        try {
          await app.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const app = await start({ port: Number(process.env["PORT"] ?? 4187) });
  console.log(`Effect UI spike: ${app.url}`);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void app.close();
    });
  }
}
