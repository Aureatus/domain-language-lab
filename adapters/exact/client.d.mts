interface Snapshot {
  contractId: string;
  snapshotVersion: number;
  defaults: Record<string, Record<string, Record<string, unknown>>>;
  availability: Record<string, Record<string, boolean>>;
  state: {
    records: Record<
      string,
      Record<string, { values: Record<string, unknown> }>
    >;
  };
  pending: {
    id: string;
    status: string;
    stale: boolean;
    invocation: {
      actor: string;
      action: string;
      args: Record<string, unknown>;
    };
    requirements: { policyId: string; approvers: string[] }[];
    grants: { policyId: string }[];
  }[];
}

interface Screen {
  owner: string;
  rows: { id: string; title: string; detail: string }[];
  inbox: {
    id: string;
    title: string;
    detail: string;
    complete: boolean;
    grants: { id: string; label: string; eligible: boolean }[];
  }[];
}

/**
 * Imported by the generated Exact app.
 * @public
 */
export function createClient(
  envelope: unknown,
  base: string,
  fetcher?: typeof fetch
): {
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- responses are untrusted JSON, validated by callers.
  request: (path: string, body?: unknown) => Promise<unknown>;
  snapshot: () => Promise<Snapshot>;
  project: (snapshot: Snapshot, actor: string) => Screen;
  command: (
    path: string,
    body: unknown
  ) => Promise<{ ok: boolean; message: string }>;
};
/**
 * Imported by the generated Exact app.
 * @public
 */
export function submissionDriver(
  client: ReturnType<typeof createClient>,
  actor: string,
  action: string
): {
  run: (
    type: "submit" | "retry" | "check",
    args?: Record<string, unknown>
  ) => Promise<{ phase: string; message: string }>;
};
