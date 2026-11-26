import { readFileSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSource, SourceError } from "./frontend.ts";

// A closed, relative, data-only import graph. No JavaScript loader/eval fallback.
type ModuleKind = "domain" | "data" | "view";

type SourceModule = {
  filename: string;
  source: string;
  body: string;
  imports: string[];
  uses: string[];
  id?: string;
  kind?: ModuleKind;
  reachable: Set<string>;
  offset: number;
  line: number;
};

const isKind = (value: string): value is ModuleKind =>
  value === "domain" || value === "data" || value === "view";

export function loadSource(path: string | URL) {
  const modules: SourceModule[] = [];
  const active = new Set<string>();
  const done = new Map<string, SourceModule>();
  const ids = new Map<string, string>();

  function visit(input: string): SourceModule {
    const filename = realpathSync(input);

    if (active.has(filename)) {
      throw Error(`Import cycle at ${filename}`);
    }

    const prior = done.get(filename);

    if (prior) {
      return prior;
    }

    active.add(filename);

    const source = readFileSync(filename, "utf8");
    const imports: string[] = [];
    const uses: string[] = [];

    let module: { id: string; kind: ModuleKind } | undefined;

    const body = source
      .split("\n")
      .map((line, i) => {
        function fail(message: string): never {
          throw new SourceError(filename, { line: i + 1, column: 1 }, message);
        }

        if (/^module\b/.test(line)) {
          const [, id, kind] =
            /^module "([^"\n]+)" (domain|data|view)\s*$/.exec(line) ?? [];

          if (!id || !kind || !isKind(kind) || module) {
            fail('Expected one module "ID" domain|data|view header.');
          }

          module = { id, kind };

          return " ".repeat(line.length);
        }

        if (/^import\b/.test(line)) {
          const input = /^import "([^"\n]+\.domain)"\s*$/.exec(line)?.[1];

          if (!input || (!input.startsWith("./") && !input.startsWith("../"))) {
            fail("Imports must be explicit relative .domain paths.");
          }

          const target = realpathSync(resolve(dirname(filename), input));

          if (imports.includes(target)) {
            fail("Duplicate import.");
          }

          imports.push(target);

          return " ".repeat(line.length);
        }

        if (/^use\b/.test(line)) {
          const id = /^use "([^"\n]+)"\s*$/.exec(line)?.[1];

          if (!id || uses.includes(id)) {
            fail("Invalid or duplicate use.");
          }

          uses.push(id);

          return " ".repeat(line.length);
        }

        return line;
      })
      .join("\n");

    if ((imports.length || uses.length) && !module) {
      throw Error(`${filename}: imports/use require a module header.`);
    }

    const header = module;

    if (header) {
      if (ids.has(header.id)) {
        throw Error(`Duplicate module ID '${header.id}'.`);
      }

      ids.set(header.id, filename);
    }

    const dependencies = imports.map(visit);

    const reachable = new Set(
      dependencies.flatMap((d) => [...(d.id ? [d.id] : []), ...d.reachable])
    );

    for (const id of uses) {
      if (!reachable.has(id)) {
        throw Error(`${filename}: missing imported module '${id}'.`);
      }

      if (!dependencies.some((d) => d.id === id && d.kind === "domain")) {
        throw Error(
          `${filename}: use '${id}' must name a directly imported domain module.`
        );
      }
    }

    if (header && header.kind !== "domain" && !uses.length) {
      throw Error(
        `${filename}: data/view module must explicitly use its imported domain.`
      );
    }

    const item: SourceModule = {
      filename,
      source,
      body,
      imports,
      uses,
      ...header,
      reachable,
      offset: 0,
      line: 0,
    };

    active.delete(filename);
    done.set(filename, item);
    modules.push(item);

    return item;
  }

  const entry = visit(
    path instanceof URL ? fileURLToPath(path) : resolve(path)
  );

  let combined = "";

  for (const item of modules) {
    item.offset = combined.length;
    item.line = combined.split("\n").length;
    combined += item.body + "\n";
  }

  const locate = (line: number, offset?: number) => {
    const item = modules.findLast((m) =>
      offset === undefined ? m.line <= line : m.offset <= offset
    );

    if (!item) {
      throw Error(`Source location outside module graph: ${line}`);
    }

    return item;
  };

  let parsed: ReturnType<typeof parseSource>;

  try {
    parsed = parseSource(combined, {
      filename: entry.filename,
      allowMissingApplication: entry.kind === "domain" || entry.kind === "data",
    });
  } catch (e) {
    if (e instanceof SourceError) {
      const item = locate(e.line);
      throw Object.assign(
        new SourceError(
          item.filename,
          { line: e.line - item.line + 1, column: e.column },
          e.message.replace(/^.*?:\d+:\d+: /, "")
        ),
        { ruleId: e.ruleId }
      );
    }

    throw e;
  }

  for (const span of Object.values(parsed.sourceMap)) {
    const item = locate(span.start.line, span.start.offset);
    span.filename = item.filename;

    for (const point of [span.start, span.end]) {
      point.offset -= item.offset;
      point.line -= item.line - 1;
    }
  }

  for (const section of parsed.sections) {
    const item = locate(section.line);
    section.filename = item.filename;
    section.line -= item.line - 1;

    const allowed = {
      domain: ["domain", "resource", "relationships", "relationship", "action"],
      data: ["initial"],
      view: ["application"],
    };

    if (
      item.kind &&
      (typeof section.kind !== "string" ||
        !allowed[item.kind].includes(section.kind))
    ) {
      throw Error(
        `${item.filename}: ${section.kind} is not allowed in a ${item.kind} module.`
      );
    }
  }

  for (const locations of Object.values(parsed.inputLocations)) {
    for (const point of Object.values(locations)) {
      const item = locate(point.line);
      point.filename = item.filename;
      point.line -= item.line - 1;
    }
  }

  return {
    ...parsed,
    modules: modules.map(({ reachable, body, ...item }) => item),
    entry: entry.filename,
  };
}
