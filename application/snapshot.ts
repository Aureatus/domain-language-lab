// Append-only durable invocation/operation ledgers order every observable mutation,
// including pending requests and grants which do not advance domain revision.
interface SnapshotIdentity {
  contractId: string;
  snapshotVersion: number;
}

export function acceptsSnapshot(
  current: Pick<SnapshotIdentity, "snapshotVersion"> | null | undefined,
  next: SnapshotIdentity,
  contractId: string
) {
  return (
    next.contractId === contractId &&
    Number.isSafeInteger(next.snapshotVersion) &&
    next.snapshotVersion >= 0 &&
    (!current || next.snapshotVersion >= current.snapshotVersion)
  );
}
