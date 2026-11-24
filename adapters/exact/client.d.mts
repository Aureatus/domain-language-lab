export interface Snapshot {
  contractId: string;
  snapshotVersion: number;
  defaults: Record<string, Record<string, Record<string, unknown>>>;
  availability: Record<string, Record<string, boolean>>;
  state: {records: Record<string, Record<string, {values: Record<string, unknown>}>>};
  pending: Array<{id:string;status:string;stale:boolean;invocation:{actor:string;action:string;args:Record<string,unknown>};requirements:Array<{policyId:string;approvers:string[]}>;grants:Array<{policyId:string}>}>;
}
export interface Screen {
  owner: string;
  rows: Array<{id:string;title:string;detail:string}>;
  inbox: Array<{id:string;title:string;detail:string;complete:boolean;grants:Array<{id:string;label:string;eligible:boolean}>}>;
}
export function createClient(envelope: unknown, base: string, fetcher?: typeof fetch): {
  request(path: string, body?: unknown): Promise<unknown>;
  snapshot(): Promise<Snapshot>;
  project(snapshot: Snapshot, actor: string): Screen;
  command(path: string, body: unknown): Promise<{ok:boolean;message:string}>;
};
export function submissionDriver(client: ReturnType<typeof createClient>, actor: string, action: string): {
  run(type:'submit'|'retry'|'check', args?:Record<string,unknown>): Promise<{phase:string;message:string}>;
};
