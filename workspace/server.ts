import {asError,errorMessage,httpErrorStatus} from '../errors.ts';
import {createServer} from 'node:http';
import type {IncomingMessage,Server,ServerResponse} from 'node:http';
import type {DatabaseSync} from 'node:sqlite';
import {mkdir, readFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {browserBundle} from '../browser-build.ts';
import {inventoryModel, initialState as v1State} from '../inventory/model.ts';
import {inventoryV2Model, initialState as v2State} from '../inventory/v2/model.ts';
import {jsonSnapshot, validateState as validateV1} from '../semantic/core.ts';
import {validateState as validateV2} from '../semantic/v2/core.ts';
import {makeDurableRuntime, makeDurableStore, initializeDurableState, durableState,
  durableExecute, durableApprove, durableResume, closeDurableStore} from '../adapters/effect/durable.ts';
import {
  decodeJson,
  decodeStrictJson,
  decodeJsonValue,
  encodeJson,
  encodeCanonicalJson as canonical,
  DurablePendingRequestSchema,
  DurableReceiptSchema,
  DurableEventSchema,
  SimulationIdentity,
  WorkspaceExecuteRequestSchema,
  WorkspaceApproveRequestSchema,
  WorkspaceResumeRequestSchema,
  Schema,
} from '../adapters/effect/json.ts';
import {deriveTools, deriveChange} from './derive.ts';
import type {WorkspaceChange} from './derive.ts';

const adapterRequire = createRequire(new URL('../adapters/effect/package.json', import.meta.url));
const Effect = await import(adapterRequire.resolve('effect/Effect'));
const run = Effect.runSync;
const here = dirname(fileURLToPath(import.meta.url));
const workspaceBundle = browserBundle(new URL('./app.ts', import.meta.url));
const decodeWith = <S extends Schema.ConstraintDecoder<unknown>>(schema:S, value:unknown):S['Type'] => jsonSnapshot(decodeJson(schema, value));
const scope = {identity: 'local-simulation', authentication: false, transport: 'loopback-only', clock: 'explicit-simulation-input', mutations: 'through-this-server-only'};
const failure = (status, message) => Object.assign(new Error(message), {httpStatus: status});
const decodeSimulationIdentity = Schema.decodeUnknownSync(SimulationIdentity);
function identity(value) {
  try { decodeSimulationIdentity(value); }
  catch { throw failure(400, 'Expected a bounded simulation identity.'); }
}
async function body<S extends Schema.ConstraintDecoder<unknown>>(req:IncomingMessage, schema:S):Promise<S['Type']> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw failure(415, 'Expected application/json.');
  let size = 0; const chunks:Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 262144) throw failure(413, 'JSON body exceeds 262144 bytes.');
    chunks.push(chunk);
  }
  try { return jsonSnapshot(decodeStrictJson(schema, Buffer.concat(chunks).toString('utf8'))); }
  catch { throw failure(400, 'Malformed or unbounded JSON.'); }
}
const sequence = (db:DatabaseSync) => {
  const n=db.prepare('SELECT (SELECT count(*) FROM durable_invocations) + (SELECT count(*) FROM durable_operations) AS n').get()?.['n'];
  if(typeof n!=='number')throw Error('Missing workspace sequence.');
  return n;
};
type Profile = typeof WorkspaceExecuteRequestSchema.Type.profile;
type Binding = {db:DatabaseSync;runtime:ReturnType<typeof makeDurableRuntime>;validate:typeof validateV1|typeof validateV2};
type Client = {profile:Profile;actor:string;res:ServerResponse};
function portOf(server:Server) {
  const address=server.address();
  if(!address||typeof address==='string')throw Error('Expected TCP address for workspace.');
  return address.port;
}
function isProfile(profile:string|null):profile is Profile {return profile==='v1'||profile==='v2';}

// The adapter APIs own their own transactions; this read-only projection uses
// their documented SQLite schema so state/history/grants share ONE read snapshot.
function snapshot(binding, profile) {
  const {db, runtime, validate} = binding;
  db.exec('BEGIN');
  try {
    const meta = Object.fromEntries(db.prepare('SELECT key,value FROM durable_meta').all().map(x => [x.key, x.value]));
    if (meta['format'] !== 'durable-effect/v1' || meta['model_key'] !== canonical(runtime.model)) throw new Error('Durable model binding mismatch.');
    const state = validate(runtime.model, jsonSnapshot(decodeJsonValue(meta['state_json'])));
    if (canonical(state) !== meta['state_json']) throw new Error('Stored state is not canonical.');
    const pending = db.prepare('SELECT * FROM durable_pending ORDER BY invocation_id').all().map(row => {
      const request = decodeWith(DurablePendingRequestSchema, row.request_json);
      const original = runtime.execute(request.prestate, request.invocation);
      if (request.invocation?.id !== row.invocation_id || original.status !== 'pending' || canonical(original.request) !== canonical(request)) throw new Error('Malformed stored pending request.');
      const grants = db.prepare('SELECT receipt_json FROM durable_grants WHERE invocation_id=? ORDER BY policy_id').all(row.invocation_id).map(grant => {
        const receipt = decodeWith(DurableReceiptSchema, grant.receipt_json);
        const approved = runtime.approve(request, {policyId: receipt.policyId, approver: receipt.approver});
        if (approved.status !== 'approved' || canonical(approved.receipt) !== canonical(receipt)) throw new Error('Malformed stored grant.');
        return {policyId: receipt.policyId, approver: receipt.approver};
      });
      return {invocationId: row.invocation_id, status: row.status, request, grants, resumeId: row.resume_id};
    });
    const events = db.prepare('SELECT sequence,event_id,event_json FROM durable_outbox ORDER BY sequence').all()
      .map(row => ({sequence: row.sequence, eventId: row.event_id, event: decodeWith(DurableEventSchema, row.event_json)}));
    const result = {profile, model: runtime.model, state, pending, events, tools: deriveTools(runtime.model), sequence: sequence(db), scope};
    db.exec('COMMIT'); return result;
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

export async function createWorkspaceServer({directory = resolve('artifacts/workspace-data'), port = 0} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port.');
  await mkdir(directory, {recursive: true});
  const bindings = new Map<Profile,Binding>(), streams = new Set<Client>();
  let server:Server|undefined, closing = false, closePromise:Promise<void>|undefined;
  const cleanup = async () => {
    closing = true;
    for (const client of streams) client.res.end();
    streams.clear();
    const listening=server;
    if (listening?.listening) await new Promise<void>((accept, reject) => {
      listening.close(error => error ? reject(error) : accept());
      listening.closeIdleConnections();
      listening.closeAllConnections();
    });
    const errors:unknown[] = [];
    for (const {db} of bindings.values()) { try { run(closeDurableStore(db)); } catch (e) { errors.push(e); } }
    bindings.clear();
    if (errors.length) throw new AggregateError(errors, 'Database cleanup failed.');
  };
  try {
    for (const [profile, model, initial, validate] of [['v1', inventoryModel, v1State, validateV1], ['v2', inventoryV2Model, v2State, validateV2]] as const) {
      const runtime = makeDurableRuntime(model), db = run(makeDurableStore(resolve(directory, `${profile}.sqlite`), {busyTimeout: 250}));
      bindings.set(profile, {runtime, db, validate});
      if (!db.prepare('SELECT value FROM durable_meta WHERE key=?').get('format')) run(initializeDurableState(runtime, db, initial));
      else run(durableState(runtime, db)); // Fail startup on changed model/corrupt state; never reset it.
    }
    const send = (client:Client, change:WorkspaceChange) => {
      // Bound a stalled client's memory. Reconnection always requests full resync.
      if (!client.res.write(`id: ${change.sequence}\nevent: change\ndata: ${encodeJson(change)}\n\n`)) client.res.destroy();
    };
    const http = server = createServer(async (req, res) => {
      const json = (status, value) => { res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}); res.end(encodeJson(value)); };
      try {
        if (closing) throw failure(503, 'Server closing.');
        const allowedHosts = [`127.0.0.1:${portOf(http)}`, `localhost:${portOf(http)}`];
        if (!req.headers.host||!allowedHosts.includes(req.headers.host)) throw failure(403, 'Unexpected loopback Host.');
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw failure(403, 'Cross-origin requests are not supported.');
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw failure(403, 'Cross-site requests are not supported.');
        const url = new URL(req.url??'/', `http://${req.headers.host}`);
        if (url.pathname === '/api/snapshot' || url.pathname === '/api/events') {
          if (req.method !== 'GET') throw failure(405, 'Method not allowed.');
          if ([...url.searchParams.keys()].some(k => !['profile', 'actor'].includes(k)) || url.searchParams.getAll('profile').length !== 1 || url.searchParams.getAll('actor').length > 1) throw failure(400, 'Unexpected query members.');
          const profile = url.searchParams.get('profile');
          if(!isProfile(profile))throw failure(400,'Unknown profile.');
          const binding = bindings.get(profile);
          if (!binding) throw failure(400, 'Unknown profile.');
          const actor = url.searchParams.get('actor') ?? 'alice'; identity(actor);
          const current = snapshot(binding, profile);
          if (url.pathname === '/api/snapshot') return json(200, current);
          res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no'});
          const client = {profile, actor, res}; streams.add(client);
          res.on('close', () => streams.delete(client));
          send(client, {sequence: current.sequence, invalidations: [{view: 'snapshot'}], recipients: [], reason: 'resync'});
          return;
        }
        const kind=url.pathname.slice(5);
        if (url.pathname.startsWith('/api/')&&(kind==='execute'||kind==='approve'||kind==='resume')) {
          if (req.method !== 'POST') throw failure(405, 'Method not allowed.');
          if (url.search) throw failure(400, 'Unexpected query members.');
          const source = kind==='execute'?{kind:'execute' as const,...await body(req,WorkspaceExecuteRequestSchema)}
            :kind==='approve'?{kind:'approve' as const,...await body(req,WorkspaceApproveRequestSchema)}
              :{kind:'resume' as const,...await body(req,WorkspaceResumeRequestSchema)};
          const binding = bindings.get(source.profile);
          if (!binding) throw failure(400, 'Unknown profile.');
          const {runtime, db} = binding;
          const before = sequence(db);
          const result = run(source.kind === 'execute' ? durableExecute(runtime, db, source.invocation)
            : source.kind === 'approve' ? durableApprove(runtime, db, source.command, {authenticatedApprover: source.actor})
              : durableResume(runtime, db, source.command));
          const after = sequence(db);
          if (after !== before) {
            const change = deriveChange(runtime.model, result.events ?? [], {sequence: after,
              pending: result.status === 'pending' || result.status === 'approved' || (kind === 'resume' && result.status === 'committed'),
              reason: result.status === 'committed' ? 'commit' : result.status === 'approved' || result.status === 'pending' ? 'approval-ledger' : 'outcome'});
            for (const client of streams) if (client.profile === source.profile) send(client, change);
          }
          return json(200, result);
        }
        if (url.pathname.startsWith('/api/')) throw failure(404, 'Unknown API endpoint.');
        if (req.method !== 'GET' && req.method !== 'HEAD') throw failure(405, 'Method not allowed.');
        if (url.pathname === '/app.js') {
          const script = req.method === 'HEAD' ? undefined : await workspaceBundle();
          res.writeHead(200, {'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
          return res.end(script);
        }
        const files = {'/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html']};
        const file = files[url.pathname];
        if (!file) throw failure(404, 'Not found.');
        let content;
        try { content = await readFile(resolve(here, file[0])); } catch (e) { if (e instanceof Error&&'code' in e&&e.code==='ENOENT') throw failure(404, 'Frontend file not available.'); throw e; }
        res.writeHead(200, {'content-type': `${file[1]}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
        res.end(req.method === 'HEAD' ? undefined : content);
      } catch (error) {
        if (res.headersSent) res.destroy(asError(error));
        else json(httpErrorStatus(error) ?? 500, {error: errorMessage(error) || 'Storage or transport failure.'});
      }
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    await new Promise<void>((accept, reject) => {
      const onError = error => { http.off('listening', onListen); reject(error); };
      const onListen = () => { http.off('error', onError); accept(); };
      http.once('error', onError); http.once('listening', onListen); http.listen(port, '127.0.0.1');
    });
    return {url: `http://127.0.0.1:${portOf(http)}`, close() { return closePromise ??= cleanup(); }};
  } catch (error) { await cleanup(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instance = await createWorkspaceServer({directory: process.env['WORKSPACE_DIR'] ?? resolve('artifacts/workspace-data'), port: Number(process.env['PORT'] ?? 4173)});
  console.log(`Local simulation workspace: ${instance.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { instance.close().catch(error => { console.error(error); process.exitCode = 1; }); });
}
