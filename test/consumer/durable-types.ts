import { createCommand } from '@jarenjs/contract/command';
import { compileContract } from '@jarenjs/contract';
import { createDbReceipts, createDbEffectStore, createDbRunStore } from '@jarenjs/linq/db';
import type { CommandIdentity, DurableRecordMapping, Client } from '@jarenjs/linq/db';
import type { JobLease, JobWorkerOptions, JobsApi } from '@jarenjs/db';
import { createDomainRun, createExternalEffects } from '@jarenjs/flow';
import { createRunObservation } from '@jarenjs/app';
import { createRunPageHandler } from '@jarenjs/contract/app';

declare const client: Client<any>;
declare const lease: JobLease;
declare const jobs: JobsApi;
const mapping: DurableRecordMapping = { collection: 'history', read: (stored) => stored.record, write: (record) => ({ id: record.id, record }) };
const physical: DurableRecordMapping = { entity: 'History', key: (id) => ({ key: id }), read: (stored) => stored.record, write: (record) => ({ key: record.id, record }) };
void createDbReceipts(client, { receipts: physical });
// @ts-expect-error a mapping cannot choose two physical owners
const ambiguous: DurableRecordMapping = { entity: 'History', collection: 'history', read: (row) => row, write: (row) => row };
void ambiguous;
const identity: CommandIdentity = { tenant: 'a', environment: 'test', aggregate: 'one', op: 'item.save', key: 'one', hashVersion: '1', hash: 'hash' };
const receipts = createDbReceipts(client, { receipts: mapping, leases: 'claims' });
void receipts.claim(identity, { leaseMs: 10 });
void receipts.execute(identity, async (tx) => { await tx.jobs?.assertLease(lease); return { outcome: {} }; });
// @ts-expect-error infinite retention is a policy, not a numeric TTL option
createDbReceipts(client, { receipts: 'history', ttlMs: Infinity });
// @ts-expect-error immutable references cannot be erased by compaction
void receipts.compact(identity, { retainReplay: true, retainReferences: false, actor: 'operator', reason: 'archive' });
const contract = compileContract({ $contract: '0.1', operations: { 'item.save': { kind: 'command', output: {}, http: { method: 'POST', path: '/' } } } });
const command = createCommand(contract.operations['item.save'], { repository: receipts, identity: () => identity, authorize: () => true, handler: () => ({}) });
void command.execute(null);
const effects = createDbEffectStore(client, { operations: 'operations' });
void effects.recover('one', 1, lease);
const runs = createDbRunStore(client, { runs: 'runs', events: 'events' });
void runs.page('one', { after: 1, limit: 16 });
void runs.finish('one', 'cancelled', lease);
// @ts-expect-error only terminal cancellation/failure can be forced
void runs.finish('one', 'running', lease);
void jobs.assertLease(lease);
const worker: JobWorkerOptions = { handlers: { send: (_input, context) => context.lease() }, effectSafety: async (_job, context) => jobs.assertLease(context.lease()) };
void jobs.createWorker(worker);
const readPage = createRunPageHandler({ page: runs.page, authorize: () => true });
const observe = createRunObservation({ readPage, wake: async () => undefined });
observe({ runId: 'one', id: 1, cursor: 0, update: 'progress', error: 'failed' }, () => {})();
observe.dispose();
void createDomainRun({}, { store: runs, schemaVersion: '1' });
void createExternalEffects({ store: effects, executor: { execute: async () => ({}) }, authorize: () => true, classify: () => ({}) });
