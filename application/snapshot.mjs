// Append-only durable invocation/operation ledgers order every observable mutation,
// including pending requests and grants which do not advance domain revision.
export function acceptsSnapshot(current,next,contractId){
  return next.contractId===contractId && Number.isSafeInteger(next.snapshotVersion)
    && next.snapshotVersion>=0 && (!current || next.snapshotVersion>=current.snapshotVersion);
}
