import {isNotSubmittedError} from './submission.ts';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplicationClient} from './client.ts';
import type {ApplicationReceipt,ApplicationSnapshot} from './client.ts';
import {createApplicationServer} from './server.ts';
import type {SubmissionBody} from './submission.ts';

export type WalkthroughEvent = (
  | {type:'snapshot';snapshot:ApplicationSnapshot}
  | {type:'draft';body:SubmissionBody;id:string}
  | {type:'submit'|'lost'|'check'}
  | {type:'invalid'|'blocked'|'unavailable';message:string}
  | {type:'receipt';result:ApplicationReceipt}
  | {type:'grant';result:ApplicationReceipt;actor:string;policyId:string}
  | {type:'complete';result:ApplicationReceipt;actor:string}
)&{snapshot?:ApplicationSnapshot;result?:ApplicationReceipt};

// An isolated demonstration, not a replay against a user's live database.
// 'lost' models withholding a successful HTTP response from the observer;
// it is not an assertion that a real network failure occurred.
export async function* walkthrough(declaration:unknown, {action, actor, args, submissionId = randomUUID()}: SubmissionBody & {submissionId?: string}):AsyncGenerator<WalkthroughEvent> {
  if (typeof submissionId !== 'string' || !submissionId.trim() || submissionId.length > 200)
    throw Error('Expected a nonempty submission ID of at most 200 characters.');
  const body = {action, actor, args: structuredClone(Object.fromEntries(Object.entries(args).filter(([, value])=>value!==undefined)))};
  const directory = await mkdtemp(join(tmpdir(), 'action-walkthrough-'));
  let server;
  try {
    server = await createApplicationServer(declaration, {directory});
    const client = createApplicationClient(server.url);
    const {contract} = await client.contract();
    const initial=await client.snapshot();
    yield {type:'snapshot',snapshot:initial};
    if(!initial.availability[actor]?.[action]){yield {type:'unavailable',message:'The selected action is unavailable to this actor.'};return;}
    yield {type: 'draft', body: structuredClone(body), id: submissionId};
    yield {type: 'submit'};
    try{await client.execute({...body, submissionId});}catch(e){
      if(!isNotSubmittedError(e))throw e;
      yield {type:'invalid',message:e.message};return;
    } // Discard a successful reply; never submit twice.
     // A separate delivery path may update the view before the writer even
     // learns its reply was lost. It is not the writer's acknowledgement.
     yield {type: 'snapshot', snapshot: await client.snapshot()};
     yield {type: 'lost'};
    yield {type: 'snapshot', snapshot: await client.snapshot()};
    yield {type: 'check'};
    const result = await client.reconcile({actor, submissionId});
    if (!['pending', 'committed', 'rejected'].includes(result.status))
      throw Error(`No recorded execution receipt: ${result.status}`);
    yield {type: 'receipt', result: structuredClone(result)};
    if (result.status !== 'pending') return;

    if(!result.evidence||!result.requirements)throw Error('Missing pending receipt evidence.');
    const requestId = result.evidence.invocation.id;
    for (const {policyId, approvers} of result.requirements) {
      const [approver] = approvers.filter(id => contract.actors.some(a => a.id === id)).sort();
      if (approver === undefined){yield {type:'blocked',message:`No selectable approver for ${policyId}.`};return;}
      const grant = await client.grant({requestId, policyId, actor: approver});
      yield {type: 'grant', actor:approver, policyId, result: structuredClone(grant)};
      yield {type:'snapshot',snapshot:await client.snapshot()};
      if (grant.status !== 'approved') return;
    }
    yield {type: 'complete', actor, result: await client.resume({requestId, actor})};
  } finally {
    try { await server?.close(); }
    finally { await rm(directory, {recursive: true, force: true}); }
  }
}
