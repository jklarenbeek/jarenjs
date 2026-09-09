//@ts-check
/** Engine-owned tables shared by replication storage and schema inspection. */
export const REPLICATION_TABLES = Object.freeze({
  state: '_jaren_replica',
  rows: '_jaren_replica_rows',
  receipts: '_jaren_replica_receipts',
  outbox: '_jaren_replica_outbox',
  conflicts: '_jaren_replica_conflicts',
  claims: '_jaren_replica_claims',
});
