import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  makeDurableStore,
  initializeDurableState,
  durableState,
  durableExecute,
  durableApprove,
  durableResume,
  durablePending,
  closeDurableStore,
} from "../adapters/effect/durable.ts";
import { Effect } from "../adapters/effect/index.ts";
import {
  decodeJson,
  decodeStrictJson,
  decodeJsonValue,
  encodeJson,
  DurableInvocationSchema,
  DurableOutcomeSchema,
  ApplicationPreviewRequestSchema,
  ApplicationExecuteRequestSchema,
  ApplicationReconcileRequestSchema,
  ApplicationGrantRequestSchema,
  ApplicationResumeRequestSchema,
} from "../adapters/effect/json.ts";
import { browserBundle } from "../browser-build.ts";
import { errorMessage, httpErrorStatus } from "../errors.ts";
import type { InvocationInput, State } from "../semantic/v2/types.ts";
import { deriveApplication, buildInvocation, inputDefaults } from "./derive.ts";

const run = Effect.runSync;
const operationId = () => `application-${randomUUID()}`;

const fail = (message: string, status = 400) =>
  Object.assign(new Error(message), { httpStatus: status });

interface Result {
  status: "prepared" | "pending" | "committed" | "rejected" | "approved";
}

const unwrap = (r: Result | { status: "duplicate"; result: Result }): Result =>
  r.status === "duplicate" ? r.result : r;

const browserFiles = Object.fromEntries(
  Object.entries({
    "/": "index.html",
    "/index.html": "index.html",
    "/style.css": "style.css",
  }).map(([path, file]) => [path, new URL(file, import.meta.url)])
);

const applicationBundle = browserBundle(new URL("browser.ts", import.meta.url));

export function resultMessage(r: { status: string; code?: string }) {
  if (r.status === "committed") {
    return "Saved. Your records are up to date.";
  }

  if (r.status === "prepared") {
    return "Automatically approved";
  }

  if (r.status === "pending") {
    return "Approval needed. No changes have been made.";
  }

  const messages = new Map([
    [
      "stale",
      "Things changed after this request was sent. No changes were made. Please send a new request.",
    ],
    [
      "precondition",
      "This request does not meet the requirements. Check the available balance and inputs.",
    ],
    ["denied", "You do not have permission for this action."],
    ["missing-record", "This person does not have the required record."],
    [
      "unauthorized-approval",
      "Only a named approver can approve this request.",
    ],
    ["consumed", "This request has already been completed."],
  ]);

  return (
    (r.code === undefined ? undefined : messages.get(r.code)) ??
    `Could not complete this request (${r.code ?? r.status}). No changes were made.`
  );
}

export async function createApplicationServer(
  declaration: unknown,
  {
    directory,
    port = 0,
    database = "application.sqlite",
    staticFiles = browserFiles,
  }: {
    directory?: string;
    port?: number;
    database?: string;
    staticFiles?: Record<string, URL>;
  } = {}
) {
  const derived = deriveApplication(declaration);
  const { model, contract, runtime } = derived;

  const contractId = createHash("sha256")
    .update(encodeJson({ model, contract }))
    .digest("hex");

  if (directory === undefined) {
    throw new TypeError("Application storage directory required.");
  }

  await mkdir(directory, { recursive: true });

  const db = run(
    makeDurableStore(resolve(directory, database), { busyTimeout: 250 })
  );

  let closed = false;
  const streams = new Set<ServerResponse>();

  try {
    if (
      db.prepare("SELECT value FROM durable_meta WHERE key=?").get("format")
    ) {
      run(durableState(runtime, db));
    } else {
      run(initializeDurableState(runtime, db, derived.initialState));
    }

    // The invocation journal owns the outcome. Keep just the pre-elaboration
    // arguments and contract binding beside it: adapters can fill omitted inputs.
    db.exec(`CREATE TABLE IF NOT EXISTS application_submissions (
      invocation_id TEXT PRIMARY KEY REFERENCES durable_invocations(id),
      contract_id TEXT NOT NULL, args_json TEXT NOT NULL
    )`);

    const submissionKey = (id: string) =>
      `submission-${createHash("sha256").update(encodeJson(id)).digest("hex")}`;

    const storedSubmission =
      db.prepare(`SELECT i.command_json,i.outcome_json,s.contract_id,s.args_json
      FROM application_submissions s JOIN durable_invocations i ON i.id=s.invocation_id
      WHERE s.invocation_id=?`);

    function lookup(
      key: string,
      body: { actor: string; action?: string; args?: unknown },
      execute: boolean
    ) {
      const row = storedSubmission.get(key);

      if (!row) {
        return null;
      }

      const invocation = decodeJson(
        DurableInvocationSchema,
        row["command_json"]
      );

      if (invocation.actor !== body.actor) {
        throw fail("This submission belongs to another person.", 403);
      }

      if (
        row["contract_id"] !== contractId ||
        (execute &&
          (invocation.action !== body.action ||
            !isDeepStrictEqual(
              decodeJsonValue(row["args_json"]),
              decodeJsonValue(encodeJson(body.args))
            )))
      ) {
        throw fail(
          "Submission ID already bound to another command or contract.",
          409
        );
      }

      return {
        invocation,
        result: decodeJson(DurableOutcomeSchema, row["outcome_json"]),
      };
    }

    const state = () => run(durableState(runtime, db));

    function preview(
      actor: string,
      action: string,
      args: unknown,
      current: State
    ) {
      const invocation = buildInvocation(contract, {
        actor,
        action,
        args,
        id: operationId(),
        clock: Date.now(),
      });

      const result = runtime.prepare(current, invocation);

      return { invocation, result };
    }

    function snapshot() {
      // Each adapter projection opens its own read transaction. A different
      // writer process can commit between them; never label a mixed snapshot
      // with the newer ledger version.
      const version = () => {
        const value = db
          .prepare(
            "SELECT (SELECT count(*) FROM durable_invocations) + (SELECT count(*) FROM durable_operations) AS version"
          )
          .get()?.["version"];

        if (typeof value !== "number") {
          throw new TypeError("Missing snapshot version.");
        }

        return value;
      };

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const snapshotVersion = version();
        const value = readSnapshot(snapshotVersion);

        if (version() === snapshotVersion) {
          return value;
        }
      }

      throw fail(
        "Records changed during refresh. Reconnect to see the current snapshot.",
        503
      );
    }

    function readSnapshot(snapshotVersion: number) {
      const current = state();

      const pending = db
        .prepare("SELECT invocation_id FROM durable_pending ORDER BY rowid")
        .all()
        .map((row) => {
          const id = row["invocation_id"];

          if (typeof id !== "string") {
            throw new TypeError("Invalid pending invocation ID.");
          }

          const p = run(durablePending(runtime, db, id));

          if (!p) {
            throw new Error("Pending invocation disappeared.");
          }

          return {
            id: p.invocationId,
            status: p.status,
            invocation: p.request.invocation,
            requirements: p.request.requirements,
            grants: p.grants,
            stale:
              p.status === "pending" &&
              !isDeepStrictEqual(p.request.prestate, current),
          };
        });

      // Availability is only an interpreter-derived display hint. Every submit is
      // independently validated/authorized against fresh durable state.
      const defaults: Record<
        string,
        Record<string, ReturnType<typeof inputDefaults>>
      > = {};

      const availability: Record<string, Record<string, boolean>> = {};

      for (const actor of contract.actors) {
        const inputs: Record<string, ReturnType<typeof inputDefaults>> = {};
        const available: Record<string, boolean> = {};

        defaults[actor.id] = inputs;
        availability[actor.id] = available;

        for (const action of Object.keys(contract.actions)) {
          const args = inputDefaults(contract, action, current, actor.id);
          inputs[action] = args;

          try {
            const { result } = preview(actor.id, action, args, current);
            available[action] =
              result.status !== "rejected" ||
              !["denied", "missing-record"].includes(result.code);
          } catch {
            available[action] = true;
          }
        }
      }

      return {
        contractId,
        snapshotVersion,
        state: current,
        pending,
        defaults,
        availability,
      };
    }

    const evidence = (
      invocation: InvocationInput,
      result: {
        status: string;
        code?: string;
        requirements?: unknown;
        events?: unknown;
      },
      phase: string
    ) => {
      const action = model.actions[invocation.action];

      if (!action) {
        throw new Error("Missing evidence action declaration.");
      }

      const { policies, preconditions, updates, inserts, deletes } = action;

      return {
        format: "application-evidence/v1",
        phase,
        invocation,
        policies,
        preconditions,
        group: { updates, inserts, deletes },
        outcome: {
          status: result.status,
          code: result.code ?? null,
          requirements: result.requirements ?? [],
          events: result.events ?? [],
        },
        method:
          "Actual interpreter/durable result and declared AST; not a parser trace or ordered guard evaluation.",
      };
    };

    const publish = () => {
      const event = `event: update\ndata: ${encodeJson(snapshot())}\n\n`;

      for (const res of streams) {
        if (!res.write(event)) {
          res.destroy();
        }
      }
    };

    const portOf = (): number => {
      const address = server.address();

      if (!address || typeof address === "string") {
        throw new Error("Expected a listening TCP server.");
      }

      return address.port;
    };

    const server = createServer(async (req, res) => {
      const json = (status: number, value: unknown) => {
        res.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(encodeJson(value));
      };

      try {
        if (
          !req.headers.host ||
          ![`127.0.0.1:${portOf()}`, `localhost:${portOf()}`].includes(
            req.headers.host
          )
        ) {
          throw fail("Unexpected host.", 403);
        }

        if (
          req.headers.origin &&
          req.headers.origin !== `http://${req.headers.host}`
        ) {
          throw fail("Cross-origin requests are not supported.", 403);
        }

        if (
          req.headers["sec-fetch-site"] &&
          !["same-origin", "none"].includes(req.headers["sec-fetch-site"])
        ) {
          throw fail("Cross-site requests are not supported.", 403);
        }

        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

        if (req.method === "GET" && url.pathname === "/api/contract") {
          return json(200, { contractId, contract });
        }

        if (req.method === "GET" && url.pathname === "/api/snapshot") {
          return json(200, snapshot());
        }

        if (req.method === "GET" && url.pathname === "/api/events") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          streams.add(res);
          res.write(`event: update\ndata: ${encodeJson(snapshot())}\n\n`);
          res.on("close", () => streams.delete(res));

          return;
        }

        if (
          req.method === "POST" &&
          [
            "/api/actions/preview",
            "/api/actions/execute",
            "/api/actions/reconcile",
            "/api/approvals/grant",
            "/api/approvals/resume",
          ].includes(url.pathname)
        ) {
          if (
            req.headers["content-type"]?.split(";")[0] !== "application/json"
          ) {
            throw fail("Expected JSON.", 415);
          }

          let bytes = 0;
          const chunks: Buffer[] = [];

          for await (const chunk of req) {
            bytes += chunk.length;

            if (bytes > 16_384) {
              throw fail("Request too large.", 413);
            }

            chunks.push(chunk);
          }

          const kind = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);

          let body: {
            actor: string;
            action?: string;
            args?: unknown;
            submissionId?: string;
            expectedContractId?: string;
            requestId?: string;
            policyId?: string;
          };

          let result: { status: string } | undefined;

          let invocation: InvocationInput | undefined;
          let key: string | undefined;
          let replayed = false;

          const input = Buffer.concat(chunks).toString();

          try {
            switch (kind) {
              case "preview": {
                body = decodeStrictJson(ApplicationPreviewRequestSchema, input);
                break;
              }

              case "execute": {
                body = decodeStrictJson(ApplicationExecuteRequestSchema, input);
                break;
              }

              case "reconcile": {
                body = decodeStrictJson(
                  ApplicationReconcileRequestSchema,
                  input
                );
                break;
              }

              case "grant": {
                body = decodeStrictJson(ApplicationGrantRequestSchema, input);
                break;
              }

              case "resume": {
                body = decodeStrictJson(ApplicationResumeRequestSchema, input);
                break;
              }

              default: {
                throw new Error("Unknown operation.");
              }
            }
          } catch (error) {
            throw fail(errorMessage(error) || "Invalid JSON.");
          }

          try {
            if (!contract.actors.some((a) => a.id === body.actor)) {
              throw new Error("Choose a known person.");
            }

            if (body.submissionId !== undefined) {
              key = submissionKey(body.submissionId);
            }
          } catch (error) {
            throw fail(errorMessage(error));
          }

          if (
            Object.hasOwn(body, "expectedContractId") &&
            body.expectedContractId !== contractId
          ) {
            throw fail(
              "Application contract changed. Reload before continuing.",
              409
            );
          }

          if (key) {
            const stored = lookup(key, body, kind === "execute");

            if (stored) {
              ({ invocation, result } = stored);
              replayed = true;
            } else if (kind === "reconcile") {
              return json(200, {
                status: "not-found",
                contractId,
                submissionId: body.submissionId,
              });
            }
          }

          if (kind === "execute" || kind === "preview") {
            if (!replayed) {
              try {
                if (body.action === undefined) {
                  throw new Error("Missing action.");
                }

                invocation = buildInvocation(contract, {
                  ...body,
                  action: body.action,
                  args: body.args,
                  id: key ?? operationId(),
                  clock: Date.now(),
                });
              } catch (error) {
                if (key) {
                  return json(400, {
                    error: errorMessage(error),
                    disposition: "not-submitted",
                    contractId,
                    submissionId: body.submissionId,
                  });
                }

                throw fail(errorMessage(error));
              }

              if (kind === "preview") {
                result = runtime.prepare(state(), invocation);
              } else {
                const outcome = run(
                  durableExecute(
                    runtime,
                    db,
                    invocation,
                    key
                      ? {
                          beforeCommit: () => {
                            db.prepare(
                              "INSERT INTO application_submissions(invocation_id,contract_id,args_json) VALUES(?,?,?)"
                            ).run(key, contractId, encodeJson(body.args));
                          },
                        }
                      : undefined
                  )
                );

                // Another process may have won after our lookup, with a different
                // host clock. Compare the client command, never retry with a new ID.
                if (
                  key &&
                  (outcome.status === "duplicate" ||
                    (outcome.status === "rejected" &&
                      outcome.code === "invocation-conflict"))
                ) {
                  const stored = lookup(key, body, true);

                  if (!stored) {
                    throw fail("Submission ID unavailable.", 409);
                  }

                  ({ invocation, result } = stored);
                  replayed = true;
                } else {
                  result = unwrap(outcome);
                }
              }
            }
          } else if (kind === "grant") {
            if (body.requestId === undefined || body.policyId === undefined) {
              throw fail("Missing request or policy.");
            }

            result = unwrap(
              run(
                durableApprove(
                  runtime,
                  db,
                  {
                    id: operationId(),
                    invocationId: body.requestId,
                    policyId: body.policyId,
                  },
                  { authenticatedApprover: body.actor }
                )
              )
            );
            invocation = run(durablePending(runtime, db, body.requestId))
              ?.request.invocation;
          } else if (kind === "resume") {
            if (body.requestId === undefined) {
              throw fail("Missing request.");
            }

            const pending = run(durablePending(runtime, db, body.requestId));

            if (!pending) {
              throw fail("Request not found.", 404);
            }

            // No arbitrary caller can trigger a previously granted invocation.
            const eligible =
              pending.request.invocation.actor === body.actor ||
              pending.request.requirements.some((r) =>
                r.approvers.includes(body.actor)
              );

            if (!eligible) {
              throw fail(
                "Only the requester or a named approver can complete this request.",
                403
              );
            }

            result = unwrap(
              run(
                durableResume(runtime, db, {
                  id: operationId(),
                  invocationId: body.requestId,
                  clock: Date.now(),
                })
              )
            );
            ({ invocation } = pending.request);
          }

          if (kind !== "preview" && !replayed) {
            publish();
          }

          if (!result) {
            throw new Error("Missing operation result.");
          }

          const code =
            "code" in result && typeof result.code === "string"
              ? result.code
              : undefined;

          const request = "request" in result ? result.request : undefined;

          const requirements =
            request && typeof request === "object" && "requirements" in request
              ? request.requirements
              : undefined;

          const projection = {
            status: result.status,
            ...(code === undefined ? {} : { code }),
            requirements,
            events: "events" in result ? result.events : undefined,
          };

          return json(200, {
            submissionId: body.submissionId,
            status: result.status,
            code,
            message:
              kind === "grant" && result.status === "approved"
                ? "Approval saved. Complete the request separately."
                : resultMessage(projection),
            args: invocation?.args,
            requirements,
            evidence: invocation
              ? evidence(
                  invocation,
                  projection,
                  kind === "reconcile" ? "execute" : kind
                )
              : undefined,
            snapshot: kind === "preview" ? undefined : snapshot(),
            contractId,
          });
        }

        if (
          req.method === "GET" &&
          staticFiles === browserFiles &&
          url.pathname === "/app.js"
        ) {
          const script = await applicationBundle();
          res.writeHead(200, {
            "content-type": "text/javascript",
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
          });

          return res.end(script);
        }

        const file = Object.hasOwn(staticFiles, url.pathname)
          ? staticFiles[url.pathname]
          : undefined;

        if (req.method !== "GET" || !file) {
          throw fail("Not found.", 404);
        }

        const data = await readFile(file);
        res.writeHead(200, {
          "content-type": file.pathname.endsWith(".html")
            ? "text/html; charset=utf-8"
            : file.pathname.endsWith(".css")
              ? "text/css"
              : "text/javascript",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        });
        res.end(data);
      } catch (error) {
        const status = httpErrorStatus(error);

        if (res.headersSent) {
          res.destroy();
        } else {
          json(status ?? 500, {
            error: status
              ? errorMessage(error)
              : "Storage failed. The operation may have been recorded; reconnect before retrying.",
          });
        }
      }
    });

    await new Promise<void>((resolveDone, rejectDone) => {
      server.once("error", rejectDone);
      server.listen(port, "127.0.0.1", resolveDone);
    });

    return {
      url: `http://127.0.0.1:${portOf()}`,
      async close() {
        if (closed) {
          return;
        }

        closed = true;

        for (const res of streams) {
          res.end();
        }

        streams.clear();
        await new Promise<void>((resolveDone, rejectDone) => {
          server.close((e) => (e ? rejectDone(e) : resolveDone()));
          server.closeAllConnections();
        });
        run(closeDurableStore(db));
      },
    };
  } catch (error) {
    run(closeDurableStore(db));
    throw error;
  }
}
