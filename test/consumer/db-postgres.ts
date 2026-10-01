import { openStore, type Driver, type PostgresPhysicalMigrationTarget, type IsolationLevel, type OwnerError } from '@jarenjs/db';
import { postgresDriver, postgresNotifications, POSTGRES_DEFAULTS, type PostgresClient, type PostgresOptions } from '@jarenjs/db/postgres';
import { relational, sql, planSchemaChange, applySchemaChange, planTableMigration, applyTableMigration, type AsyncRelationalEngine } from '@jarenjs/db/relational';
import { asyncLive, type AsyncLiveOptions } from '@jarenjs/db/async-live';
import { createDbSearch, type DbSearchOptions } from '@jarenjs/db/search';
import { liveAppBinding } from '@jarenjs/db/app';

liveAppBinding({ statePath: '/live', collection: 'notes', query: [], mode: 'resnapshot' });
// @ts-expect-error native live maintenance has no implicit event-time mode
liveAppBinding({ statePath: '/live', query: [], mode: 'native-stream' });

const options: PostgresOptions = {
  windowRows: POSTGRES_DEFAULTS.windowRows, windowBytes: 1_048_576,
  maxConnections: 2, maxPending: 8, queueCapacity: 4, maxStatements: 32,
  allMaxRows: 1000, allMaxBytes: 2_097_152, maxCursors: 4,
  acquisitionTimeoutMs: 500, statementTimeoutMs: 2000, lockTimeoutMs: 300,
  closeTimeoutMs: 500, cursorLifetimeMs: 5000,
  poolMode: 'session', prepared: 'unnamed', cursorMode: 'native',
};
declare const client: PostgresClient;
const driver = postgresDriver({ connect: async () => client }, options);
const portable: Driver = driver;
const active: number = driver.metrics().active;
const connection: Promise<unknown> = driver.open(undefined, { signal: new AbortController().signal });
const store = await openStore({ $model: '0.1', collections: {} }, { driver: portable });
const streaming: boolean = store.capabilities.lazyIteration;
const rows: number | undefined = store.capabilities.postgres?.windowRows;
// @ts-expect-error transaction pooling cannot preserve a Store's session
postgresDriver({ connect: async () => client }, { poolMode: 'transaction' });
void [active, connection, streaming, rows];
// a store on several sessions, bounded by what the driver admits
const most: number = driver.maxConnections;
const several = await openStore({ $model: '0.1', collections: {} }, { driver, sessions: Math.min(4, most) });
const connections: number = several.capabilities.connections;
// @ts-expect-error — a count of sessions, not a mode
await openStore({ $model: '0.1', collections: {} }, { driver, sessions: 'many' });
void connections;
// the writer lock, the isolation floor and the owner lock, typed
const owned = await openStore({ $model: '0.1', collections: {} },
  { driver: portable, isolation: 'repeatable read', owner: { id: 'api-1', leaseMs: 30_000 } });
const immediate: boolean = owned.capabilities.immediateTransactions;
const levels: readonly IsolationLevel[] = owned.capabilities.isolation;
const ownerMode: 'none' | 'lease' | 'session' = owned.capabilities.owner;
const sessionDefault: IsolationLevel | undefined = owned.capabilities.postgres?.defaultIsolation;
const ran: IsolationLevel = await owned.transaction(async (tx) => {
  // @ts-expect-error — a savepoint runs at its root's level (JD0014)
  await tx.transaction(async () => 1, { isolation: 'serializable' });
  return tx.isolation;
}, { mode: 'immediate', isolation: 'serializable' });
// @ts-expect-error — the three levels, spelled as the SQL standard spells them
await owned.transaction(async () => 1, { isolation: 'snapshot' });
// @ts-expect-error — an owner is { id, leaseMs? }
await openStore({ $model: '0.1', collections: {} }, { driver: portable, owner: 'api-1' });
// compare-and-set and every document, on the store's own collection
const accounts = owned.collection<{ id: string; revision: number }>('accounts');
await accounts.put({ id: 'a', revision: 2 }, undefined, { expect: { path: '/revision', value: 1 } });
const everyAccount: { id: string; revision: number }[] = await accounts.all({ deadline: Date.now() + 1000 });
// @ts-expect-error — insert holds no precondition: its options read nothing
await accounts.insert({ id: 'b', revision: 1 }, { expect: { path: '/revision', value: 1 } });
void everyAccount;
declare const refused: OwnerError;
const holder: string | null = refused.owner;
const until: number | null = refused.expiresAt;
void [immediate, levels, ownerMode, sessionDefault, ran, holder, until];
const native = await driver.open();
declare const target: PostgresPhysicalMigrationTarget;
const schemaPlan = await planSchemaChange(native, { op: 'native', table: 'items',
  sql: 'ALTER TABLE items ADD COLUMN note text', target, dispositions: {} });
const schemaResult: Promise<{ changed: number }> = applySchemaChange(native, schemaPlan);
const tablePlan = await planTableMigration(native, target, { id: 'change', table: 'items', statements: [], dispositions: {} });
const tableResult: Promise<{ changed: number }> = applyTableMigration(native, tablePlan);
void [schemaResult, tableResult];
const engine: AsyncRelationalEngine = relational(native);
const values: Promise<Record<string, unknown>[]> = engine.all({ from: 'items', columns: { id: sql.column('id') } });
const result = await native.transaction(async (scope) => relational(scope).execute({
  op: 'update', table: 'items', set: { enabled: true }, where: sql.binary('=', sql.column('id'), 1),
}));
for await (const row of engine.iterate({ from: 'items' })) void row;
await engine.dispose();
await native.close();
void [values, result];
declare const listenerSource: { connect: Function };
const notifications = postgresNotifications(listenerSource, { channel: 'public_feed', maxReconnects: 3 });
await notifications.ready;
const token: IteratorResult<null> = await notifications.next();
await notifications.close();
void token;
const liveOptions: AsyncLiveOptions = { maxQueries: 4, maxInputRows: 100, maxInputBytes: 65536,
  maxMaintained: 100, maxBytes: 65536, maxObservers: 2, pollMs: 1000, pageRows: 16, maxAttempts: 2 };
const liveStore = await openStore({ $model: '0.1', collections: {} },
  { driver, capture: { log: true }, live: asyncLive(liveOptions) });
const modes: readonly ('incremental' | 'rerun' | 'resnapshot')[] = liveStore.capabilities.liveModes;
const live = await liveStore.live!([], { mode: 'resnapshot' });
const checkpoint: number | undefined = live.stats().checkpoint;
live.subscribe(event => { const lag: boolean | undefined = event.lag; void lag; });
await live.refresh?.(); await live.close();
const freshness: DbSearchOptions = { source: 'typed', revision: { name: 'enrolled', read: async tx => {
  // @ts-expect-error revision providers cannot close their transaction owner
  void tx.close;
  return (await tx.changes!.bounds()).highWatermark;
} } };
const search = await createDbSearch(liveStore, 'Item', { version: 1, fields: ['title'] }, freshness);
const revision: string = search.explain().revision;
await search.dispose(); await liveStore.close();
void [modes, checkpoint, revision];
const replicationStore = await openStore({ $model: '0.1', collections: {} },
  { driver, replication: { replica: 'typed-native', maxBytes: 65536 } });
const bootstrap = await replicationStore.replication!.snapshot({ maxBytes: 32768 });
const receipts: number = bootstrap.receipts.length;
// @ts-expect-error snapshot byte credits are numeric
void replicationStore.replication!.snapshot({ maxBytes: 'unbounded' });
await replicationStore.close(); void receipts;
