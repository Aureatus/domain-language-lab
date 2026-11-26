import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  decodeJsonObject,
  encodeJson,
  encodeJsonPretty,
} from "../adapters/effect/json.ts";
import { errorMessage } from "../errors.ts";
import { loadSource } from "../syntax/load.ts";
import { createApplicationClient, inboxFor } from "./client.ts";
import type { ApplicationReceipt } from "./client.ts";
import { deriveApplication } from "./derive.ts";
import type { ApplicationContract } from "./derive.ts";
import { isNotSubmittedError } from "./submission.ts";

const usage = `Usage: pnpm run application:cli COMMAND [ID] --url http://127.0.0.1:4174 [options]
Commands: list [RESOURCE], inspect [ACTION], preview ACTION, execute ACTION,
          reconcile SUBMISSION --actor ID, inbox, grant REQUEST --policy POLICY, resume REQUEST
          execute accepts --submission-id ID for repeatable delivery
Options: --actor ID (required for preview/execute/grant/resume), --args JSON, --json
         --view SOURCE.domain (optional local presentation; exact domain check)
inspect ACTION prints generated schemas, hidden bindings and adapters. Submit only
visible arguments; server supplies actor/operation IDs and named computed inputs.
Local actor simulation is not authentication. No automatic retry of writes.`;

type CLIOptions = Partial<
  Record<"url" | "actor" | "args" | "policy" | "view" | "submission-id", string>
> & { json?: boolean; help?: boolean };

export async function runCLI(argv: string[], { stdout = console.log } = {}) {
  const options: CLIOptions = {};
  const positionals: string[] = [];

  const args = argv.values();

  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const { value } = args.next();

      if (
        (key !== "url" &&
          key !== "actor" &&
          key !== "args" &&
          key !== "policy" &&
          key !== "view" &&
          key !== "submission-id") ||
        !value ||
        value.startsWith("--")
      ) {
        throw new Error(`Unknown or missing option ${arg}.\n${usage}`);
      }

      if (Object.hasOwn(options, key)) {
        throw new Error(`Duplicate option ${arg}.`);
      }

      options[key] = value;
    } else {
      positionals.push(arg);
    }
  }

  if (options.help || !positionals.length) {
    stdout(usage);

    return;
  }

  const [command, id, ...extra] = positionals;

  if (
    !command ||
    extra.length ||
    ![
      "list",
      "inspect",
      "preview",
      "execute",
      "reconcile",
      "inbox",
      "grant",
      "resume",
    ].includes(command)
  ) {
    throw new Error(usage);
  }

  if (
    ["preview", "execute", "reconcile", "grant", "resume"].includes(command) &&
    (!options.actor || !id)
  ) {
    throw new Error(
      `${command} requires an ID and explicit --actor.\n${usage}`
    );
  }

  if (options["submission-id"] && command !== "execute") {
    throw new Error("--submission-id applies only to execute.");
  }

  if (command === "grant" && !options.policy) {
    throw new Error("grant requires --policy POLICY.");
  }

  const client = createApplicationClient(
    options.url ?? process.env["APPLICATION_URL"] ?? "http://127.0.0.1:4174"
  );

  const { contract, contractId } = await client.contract();

  let result: unknown;
  let presentation: ApplicationContract | undefined;
  let receipt: ApplicationReceipt | undefined;
  let formattedList: string | undefined;

  if (options.view) {
    const loaded = loadSource(options.view);

    if (loaded.modules.at(-1)?.kind !== "view") {
      throw new Error("--view must select a view module entry.");
    }

    const derived = deriveApplication(loaded.declaration);

    const expected = createHash("sha256")
      .update(encodeJson({ model: derived.model, contract }))
      .digest("hex");

    if (expected !== contractId) {
      throw new Error(
        "Local view domain differs from the backend. No command was sent."
      );
    }

    presentation = derived.contract;
  }

  if (command === "list") {
    if (id) {
      if (!Object.hasOwn(contract.resources, id)) {
        throw new Error(`Unknown resource '${id}'.`);
      }

      result = (await client.snapshot()).state.records[id];
    } else {
      const entries = Object.entries(contract.actions).map(([key2, a]) => ({
        id: key2,
        label: presentation?.actions[key2]?.label ?? a.label,
        arguments: a.fields
          .filter((f) => !f.hidden)
          .map((f) => ({ name: f.name, schema: f.schema })),
      }));

      result = entries;
      formattedList = entries
        .map(
          (a) =>
            `${a.id} — ${a.label}\n  arguments: ${a.arguments.map((f) => `${f.name}: ${f.schema.type}`).join(", ") || "(none)"}\n  inspect: inspect ${a.id}`
        )
        .join("\n");
    }
  } else if (command === "inspect") {
    if (id && !Object.hasOwn(contract.actions, id)) {
      throw new Error(`Unknown action '${id}'.`);
    }

    result = id ? contract.actions[id] : contract;
  } else if (command === "inbox") {
    result = inboxFor(await client.snapshot(), options.actor);
  } else {
    const { actor } = options;

    if (!actor || !id) {
      throw new Error(
        `${command} requires an ID and explicit --actor.\n${usage}`
      );
    }

    if (command === "preview" || command === "execute") {
      if (!Object.hasOwn(contract.actions, id)) {
        throw new Error(`Unknown action '${id}'. Use list or inspect.`);
      }

      let innerArgs;

      try {
        innerArgs = decodeJsonObject(options.args ?? "{}");
      } catch {
        throw new Error("--args must be a JSON object.");
      }

      if (command === "preview") {
        receipt = await client.preview({ actor, action: id, args: innerArgs });
      } else {
        const submissionId = options["submission-id"] ?? randomUUID();

        try {
          receipt = {
            ...(await client.execute({
              actor,
              action: id,
              args: innerArgs,
              submissionId,
            })),
            submissionId,
          };
        } catch (error) {
          if (isNotSubmittedError(error)) {
            throw error;
          }

          throw new Error(
            `${errorMessage(error)} Check submission ${submissionId} with reconcile before retrying.`,
            { cause: error }
          );
        }
      }
    } else if (command === "reconcile") {
      receipt = await client.reconcile({ actor, submissionId: id });
    } else if (command === "grant") {
      if (!options.policy) {
        throw new Error("grant requires --policy POLICY.");
      }

      receipt = await client.grant({
        actor,
        requestId: id,
        policyId: options.policy,
      });
    } else {
      receipt = await client.resume({ actor, requestId: id });
    }

    result = receipt;
  }

  if (options.json) {
    stdout(encodeJson(result));
  } else if (receipt?.message) {
    stdout(
      `${receipt.message}\nStatus: ${receipt.status}${receipt.code ? ` (${receipt.code})` : ""}${receipt.submissionId ? `\nSubmission: ${receipt.submissionId}` : ""}${receipt.snapshot ? `\nRevision: ${receipt.snapshot.state.revision}` : ""}`
    );
  } else if (formattedList === undefined) {
    stdout(encodeJsonPretty(result));
  } else {
    stdout(formattedList);
  }

  return result;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await runCLI(process.argv.slice(2));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
