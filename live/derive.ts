import { errorMessage } from "../errors.ts";
import { createApp, forkApp } from "./core.ts";
import type { LiveModel, Rule } from "./core.ts";

type Case = {
  id: string;
  action: string | null;
  actorId: string | null;
  expected: Observation | { reconstructed: boolean } | { completed: boolean };
  actual: Observation | null;
  status: "passed" | "failed" | "unknown";
  reason?: string;
};

type WitnessArgs = Record<string, string | number | boolean | null | undefined>;

type Variant = { name: string; args: WitnessArgs | unknown[]; valid?: boolean };

type App = ReturnType<typeof createApp>;

type State = App["state"];

type Issue = State["issues"][number];

type Relationships = Pick<Issue, "id" | "opener" | "assignee" | "watchers">;

type Route = {
  recipient: string;
  reasons: string[];
  paths: { from: string; relationship: string; to: string }[];
};

type Observation = {
  ok: boolean;
  unchanged?: boolean;
  reason?: string;
  recipients?: Route[];
  notifications?: {
    id: string;
    eventId: string;
    issueId: string;
    recipient: string;
    action: string;
    reasons: string[];
  }[];
};

// Deliberately independent of core.check(), core's validator and routing helper.
const derivationCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const derivationEqual = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const derivationObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const derivationScope =
  "Finite generated declaration checks in private reconstructed runtimes; current roles, schema rejection, valid-state witnesses and event-time relationship routes. Not exhaustive; no external delivery or authentication tested.";

export function describeChange(
  model: LiveModel,
  action: unknown,
  patch: unknown
) {
  const rule =
    typeof action === "string" && Object.hasOwn(model.actions, action)
      ? model.actions[action]
      : undefined;

  if (!rule) {
    return { ok: false, reason: `Unknown action: ${action}` };
  }

  if (
    !derivationObject(patch) ||
    !Object.keys(patch).length ||
    Object.keys(patch).some((key) => !["allowedRoles", "notify"].includes(key))
  ) {
    return {
      ok: false,
      reason: "Patch must contain only allowedRoles and/or notify",
    };
  }

  for (const [key, values] of Object.entries(patch)) {
    const allowed =
      key === "allowedRoles"
        ? ["lead", "member"]
        : ["opener", "assignee", "watchers"];

    if (
      !Array.isArray(values) ||
      Array.from(values).some((value) => !allowed.includes(value)) ||
      new Set(values).size !== values.length
    ) {
      return { ok: false, reason: `Invalid ${key}` };
    }
  }

  const roles = Array.isArray(patch["allowedRoles"])
    ? patch["allowedRoles"].filter((v): v is string => typeof v === "string")
    : rule.allowedRoles;

  const notify = Array.isArray(patch["notify"])
    ? patch["notify"].filter((v): v is string => typeof v === "string")
    : rule.notify;

  const roleChanges = ["lead", "member"]
    .filter((role) => rule.allowedRoles.includes(role) !== roles.includes(role))
    .map((role) => ({
      role,
      before: rule.allowedRoles.includes(role),
      after: roles.includes(role),
    }));

  const routes = {
    added: notify.filter((path) => !rule.notify.includes(path)),
    removed: rule.notify.filter((path) => !notify.includes(path)),
  };

  return {
    ok: true,
    action,
    revision: model.revision,
    roleChanges,
    routes,
    unchanged:
      derivationEqual(rule.allowedRoles, roles) &&
      derivationEqual(rule.notify, notify),
    scope:
      "Exact declaration differences only; array order changes count as changes. No reachable-behavior prediction or changes to historical notifications.",
  };
}

function derivedArgs(
  rule: Rule,
  state: State,
  issue: Issue | undefined
): WitnessArgs {
  const args: WitnessArgs = {};

  for (const [key, field] of Object.entries(rule.inputs.properties)) {
    if (field.reference === "issues") {
      args[key] = issue?.id;
    } else if (field.reference === "users") {
      args[key] =
        state.users.find((user) => user.id !== issue?.assignee)?.id ?? null;
    } else if (field.enum) {
      args[key] = field.enum[0];
    } else if (field.type === "string") {
      args[key] = "Generated witness";
    } else {
      throw Error(`Unsupported witness schema: ${key}`);
    }
  }

  return args;
}

function derivedRoutes(
  issue: Relationships,
  paths: string[],
  actorId: string
): Route[] {
  // Group by user first, then sort by first supporting declaration path. This
  // oracle does not read event.relationshipSnapshot or event.recipients.
  const ids = [
    ...new Set<string | null>([
      issue.opener,
      issue.assignee,
      ...issue.watchers,
    ]),
  ].filter((id): id is string => Boolean(id && id !== actorId));

  return ids
    .map((recipient) => {
      const reasons = paths.filter((path) =>
        path === "watchers"
          ? issue.watchers.includes(recipient)
          : (path === "opener" || path === "assignee") &&
            issue[path] === recipient
      );

      return {
        recipient,
        reasons,
        paths: reasons.map((relationship) => ({
          from: issue.id,
          relationship,
          to: recipient,
        })),
      };
    })
    .filter((row) => row.reasons.length)
    .sort((a, b) => {
      const pathOrder =
        paths.findIndex((path) => path === a.reasons[0]) -
        paths.findIndex((path) => path === b.reasons[0]);

      return (
        pathOrder ||
        (a.reasons[0] === "watchers"
          ? issue.watchers.indexOf(a.recipient) -
            issue.watchers.indexOf(b.recipient)
          : 0)
      );
    });
}

function derivedRelationship(
  state: State,
  action: string,
  args: Variant["args"],
  actorId: string
): Relationships {
  if (action === "create") {
    return {
      id: `i${state.issues.length + 1}`,
      opener: actorId,
      assignee: null,
      watchers: [],
    };
  }

  if (Array.isArray(args)) {
    throw Error("Expected witness arguments");
  }

  const matched = state.issues.find((item) => item.id === args["issueId"]);

  if (!matched) {
    throw Error("Expected witness issue");
  }

  const issue = derivationCopy(matched);

  if (action === "assign") {
    const assignee = args["assignee"];

    if (assignee !== null && typeof assignee !== "string") {
      throw Error("Expected witness assignee");
    }

    issue.assignee = assignee;
  }

  if (action === "watch") {
    issue.watchers = issue.watchers.includes(actorId)
      ? issue.watchers.filter((id) => id !== actorId)
      : [...issue.watchers, actorId];
  }

  return issue;
}

function derivedInvalidInputs(rule: Rule, args: WitnessArgs): Variant[] {
  const variants: Variant[] = [
    { name: "object-type", args: [] },
    { name: "extra-property", args: { ...args, __unexpected: true } },
  ];

  for (const key of rule.inputs.required) {
    const missing = { ...args };
    delete missing[key];
    variants.push({ name: `missing-${key}`, args: missing });
  }

  for (const [key, field] of Object.entries(rule.inputs.properties)) {
    variants.push({ name: `type-${key}`, args: { ...args, [key]: 42 } });

    if (field.minLength) {
      variants.push({
        name: `blank-${key}`,
        args: { ...args, [key]: " ".repeat(field.minLength) },
      });
    }

    if (field.maxLength) {
      variants.push({
        name: `length-${key}`,
        args: { ...args, [key]: "x".repeat(field.maxLength + 1) },
      });
    }

    if (field.enum) {
      variants.push({
        name: `enum-${key}`,
        args: { ...args, [key]: "__invalid_enum" },
      });
    }

    if (field.reference) {
      variants.push({
        name: `reference-${key}`,
        args: { ...args, [key]: "__unknown_reference" },
      });
    }
  }

  return variants;
}

function derivedPrepare(
  app: App,
  action: string
):
  | { ok: true; issue: Issue | undefined }
  | { ok: false; reason: string; issue?: undefined } {
  const ready = () =>
    app.state.issues.find((issue) =>
      action === "resolve"
        ? issue.status === "open"
        : action === "reopen"
          ? issue.status === "resolved"
          : true
    );

  if (action === "create" || ready()) {
    return { ok: true, issue: ready() };
  }

  const setupActions = action === "reopen" ? ["resolve"] : ["reopen", "create"];
  const errors: string[] = [];

  for (const setup of setupActions) {
    const rule = app.model.actions[setup];

    if (!rule) {
      errors.push(`${setup}: no setup rule`);
      continue;
    }

    const actor = app.state.users.find((user) =>
      rule.allowedRoles.includes(user.role)
    );

    if (!actor) {
      errors.push(`${setup}: no authorized setup actor`);
      continue;
    }

    const result = app.dispatch(
      setup,
      derivedArgs(rule, app.state, app.state.issues[0]),
      actor.id
    );

    if (!result.ok) {
      errors.push(`${setup}: ${result.reason}`);
      continue;
    }

    if (ready()) {
      return { ok: true, issue: ready() };
    }

    errors.push(`${setup}: did not establish precondition`);
  }

  return { ok: false, reason: `Setup unavailable: ${errors.join("; ")}` };
}

export function runDerivedChecks(workspace: unknown) {
  const cases: Case[] = [];
  let source: ReturnType<typeof createApp>;

  const add = (
    id: string,
    action: string | null,
    actorId: string | null,
    expected: Case["expected"],
    actual: Case["actual"],
    status: Case["status"],
    reason?: string
  ) => {
    cases.push({
      id,
      action,
      actorId,
      expected,
      actual,
      status,
      ...(reason ? { reason } : {}),
    });
  };

  try {
    const document =
      derivationObject(workspace) &&
      typeof workspace["exportWorkspace"] === "function"
        ? workspace["exportWorkspace"]()
        : workspace;

    source = createApp({ workspace: document, clock: () => 0 });
  } catch (error) {
    add(
      "workspace-reconstruction",
      null,
      null,
      { reconstructed: true },
      null,
      "unknown",
      String(errorMessage(error) ?? error)
    );

    return { result: "unknown", revision: null, cases, scope: derivationScope };
  }

  const revision = source.model.revision;

  const resourceBound = (reason: string) =>
    /history limit|too large|too complex/.test(reason);

  const entryPoints: readonly ("invokeTool" | "dispatch")[] = [
    "invokeTool",
    "dispatch",
  ];

  for (const [action, rule] of Object.entries(source.model.actions)) {
    if (
      !source.state.users.some((actor) =>
        rule.allowedRoles.includes(actor.role)
      )
    ) {
      add(
        `${action}:positive-coverage`,
        action,
        null,
        { ok: true },
        null,
        "unknown",
        "No authorized actor under the current declaration; no positive witness executed."
      );
    }

    for (const actor of source.state.users) {
      const allowed = rule.allowedRoles.includes(actor.role);

      // Reconstruct once, then fork runtime-owned frozen snapshots. Each entry
      // point has isolated setup; successful trials fork the prepared baseline.
      for (const entryPoint of entryPoints) {
        const prefix = `${action}:${actor.id}:${entryPoint}`;
        const app = forkApp(source, { clock: () => 0 });

        const setup: ReturnType<typeof derivedPrepare> = allowed
          ? derivedPrepare(app, action)
          : { ok: true, issue: app.state.issues[0] };

        if (!setup.ok) {
          add(
            `${prefix}:policy`,
            action,
            actor.id,
            { ok: true },
            null,
            "unknown",
            setup.reason
          );
        }

        const args = derivedArgs(
          rule,
          app.state,
          setup.issue ?? app.state.issues[0]
        );

        const variants: Variant[] = [
          ...(setup.ok ? [{ name: "policy", args, valid: true }] : []),
          ...(allowed ? derivedInvalidInputs(rule, args) : []),
        ];

        let trial = forkApp(app, { clock: () => 0 });
        let reset = false;

        for (const variant of variants) {
          // Rejected cases may reuse an exactly unchanged private runtime. A
          // successful or unexpectedly mutating invocation forces a fresh fork.
          if (reset) {
            trial = forkApp(app, { clock: () => 0 });
          }

          const beforeState = trial.state;
          const beforeModel = trial.model;
          // State/model are deeply frozen runtime-owned data: identical roots
          // prove identical contents. The detached public journal has no identity
          // contract, so compare its exact serialization (not the huge state).
          const before = JSON.stringify(trial.exportWorkspace());
          const ok = allowed && variant.valid === true;

          const expected: Observation = {
            ok,
            ...(!ok
              ? { unchanged: true }
              : {
                  recipients: derivedRoutes(
                    derivedRelationship(
                      trial.state,
                      action,
                      variant.args,
                      actor.id
                    ),
                    rule.notify,
                    actor.id
                  ),
                }),
          };

          const result = trial[entryPoint](action, variant.args, actor.id);

          const unchanged =
            trial.state === beforeState &&
            trial.model === beforeModel &&
            before === JSON.stringify(trial.exportWorkspace());

          reset = !unchanged;

          const actual: Observation = {
            ok: result.ok,
            ...(!result.ok
              ? { unchanged, reason: result.reason }
              : { recipients: result.event.recipients }),
          };

          let matches =
            result.ok === ok &&
            (ok
              ? derivationEqual(actual.recipients, expected.recipients)
              : unchanged);

          if (expected.recipients && result.ok) {
            const notifications = trial.state.notifications.slice(
              beforeState.notifications.length
            );

            expected.notifications = expected.recipients.map((row, index) => ({
              id: `${result.event.id}:n${index + 1}`,
              eventId: result.event.id,
              issueId: result.value.id,
              recipient: row.recipient,
              action,
              reasons: row.reasons,
            }));
            actual.notifications = notifications;
            matches =
              matches &&
              derivationEqual(notifications, expected.notifications) &&
              trial.state.events.length === beforeState.events.length + 1;
          }

          const unknown =
            ok && !result.ok && unchanged && resourceBound(result.reason);

          add(
            `${prefix}:${variant.name}`,
            action,
            actor.id,
            expected,
            actual,
            unknown ? "unknown" : matches ? "passed" : "failed",
            unknown && !result.ok
              ? `Resource-bound witness: ${result.reason}`
              : matches
                ? undefined
                : "Observed dispatch differs from independent declaration expectation."
          );
        }
      }
    }
  }

  return {
    result: cases.some((row) => row.status === "failed")
      ? "failed"
      : cases.some((row) => row.status === "unknown")
        ? "unknown"
        : "passed",
    revision,
    cases,
    scope: derivationScope,
  };
}
