import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";

import { bundleBrowser } from "../browser-build.ts";

const root = new URL("../", import.meta.url);

const paths = [
  "semantic/core.ts",
  "semantic/primitives.ts",
  "inventory/model.ts",
  "inventory/declarations.ts",
  "inventory/oracle.ts",
  "inventory/host.ts",
  "inventory/app.ts",
];

const sources = await Promise.all(
  paths.map(async (p) => [
    p,
    createHash("sha256")
      .update(await readFile(new URL(p, root), "utf8"))
      .digest("hex"),
  ])
);

const bundle = await bundleBrowser(new URL("./app.ts", import.meta.url));

const template = await readFile(
  new URL("inventory/template.html", root),
  "utf8"
);

await mkdir(new URL("artifacts/", root), { recursive: true });

await writeFile(
  new URL("artifacts/inventory.html", root),
  template.replace("/* BUNDLE */", () =>
    bundle.replace(/<\/script/gi, "<\\/script")
  )
);

await writeFile(
  new URL("artifacts/inventory-build.json", root),
  JSON.stringify(
    { format: "inventory-build/v1", sources: Object.fromEntries(sources) },
    null,
    2
  )
);

console.log("Built artifacts/inventory.html from shared interpreter source");
