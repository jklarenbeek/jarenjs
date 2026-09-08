import { openStore, encodeReplication, normalizeReplicationSnapshot } from '@jarenjs/db';
import type { Driver, ReplicationEnvelope, ReplicationSnapshot } from '@jarenjs/db';
import { typedStore } from '@jarenjs/db/typed';
import { defineReplication } from '@jarenjs/linq/db';

declare const driver: Driver;
const store = await openStore({ $model: '0.1', collections: { notes: { key: '/id', schema: { type: 'object' } } } },
  { driver, replication: { replica: 'a', resolver: { id: 'reviewed-v1', resolve: () => ({ action: 'remote' }) } }, live: { maxBytes: 1024 } });
const envelope: ReplicationEnvelope = defineReplication({ replica: 'a', seq: 1, model: 'revision', frontier: {} })
  .change('notes', 'one', null, { id: 'one' }).toDocument();
const encoded: string = encodeReplication(envelope);
const snapshot: ReplicationSnapshot = normalizeReplicationSnapshot(await store.replication!.snapshot());
await store.replication!.reset(snapshot);
await store.replication!.apply(envelope, { signal: AbortSignal.abort() });
await store.replication!.page({ after: 0, maxBytes: 1024 });
// @ts-expect-error — a causal sequence is numeric.
defineReplication({ replica: 'a', seq: '1', model: 'revision', frontier: {} });
// @ts-expect-error — an envelope operation must specify its before image.
envelope.operations.push({ table: 'notes', key: 'x', after: null });
void encoded;

await typedStore(store).replication!.frontier();
await store.transaction(async (tx) => {
  // @ts-expect-error — replication owns a root transaction.
  await tx.replication.frontier();
});
