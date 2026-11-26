import {createInterpreter, type Model, type ApprovalRequest, type ApprovalReceipt, type Invocation, type State, type Policy} from './core.ts';

// Compile-only integration contract; never executed as a runtime test.
declare const model: Model;
declare const state: State;
declare const invocation: Invocation;
declare const request: ApprovalRequest;
declare const receipts: readonly ApprovalReceipt[];
const rt = createInterpreter(model);
const p = rt.prepare(state, invocation);
if (p.status === 'prepared') rt.commit(state, p.prepared);
if (p.status === 'pending') {
  const [policyId]=p.policyIds;
  if(!policyId)throw Error('Expected pending approval policy');
  const grant = rt.approve(p.request, {policyId, approver: 'boss'});
  if (grant.status === 'approved') rt.resume(state, invocation, p.request, [grant.receipt], {clock: 12});
}
const r = rt.prepareResume(state, invocation, request, receipts, {clock: 12});
if (r.status === 'prepared') rt.commit(state, r.prepared);
// @ts-expect-error Approval policies require an approver expression.
const missingApprover: Policy = {id: 'review', when: {op: 'literal', value: true}, effect: 'approval-required'};
// @ts-expect-error Allow is not approval and may not smuggle an approver declaration.
const invalidAllow: Policy = {id: 'allow', when: {op: 'literal', value: true}, effect: 'allow', approvers: {op: 'actor'}};
// @ts-expect-error Resume requires an explicit new clock.
rt.resume(state, invocation, request, receipts);
// @ts-expect-error Serializable requests are not opaque preparation capabilities.
rt.commit(state, request);
// @ts-expect-error Receipt model content is immutable.
receipts[0].request.model.id = 'replace';
void missingApprover; void invalidAllow;
