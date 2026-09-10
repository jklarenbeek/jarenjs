//@ts-check
/** Neutral application declarations reused by durable correctness and cost probes. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { compileContract } from '@jarenjs/contract';
import { open, createDbReceipts } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';

export const model = { $model: '0.1', collections: Object.fromEntries(['receipts', 'leases', 'items', 'audit', 'effects', 'runs', 'events'].map((name) => [name, {
  key: '/id', schema: { type: 'object' }, indexes: [],
}])) };
export const contract = compileContract({ $contract: '0.1', operations: { 'item.adjust': {
  kind: 'command', input: { type: 'object', properties: { key: { type: 'string' }, expected: { type: 'integer' }, delta: { type: 'integer' } }, required: ['key', 'expected', 'delta'] },
  output: { type: 'object', properties: { revision: { type: 'integer' }, count: { type: 'integer' } }, required: ['revision', 'count'], additionalProperties: false },
  errors: { conflict: { status: 409 }, rejected: { status: 422, schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
  http: { method: 'POST', path: '/adjust' },
} } });
export const input = { key: 'command-1', expected: 0, delta: 3 };
/** @param {any} value */
export const identity = (value = input) => ({ tenant: 'tenant-a', environment: 'test', aggregate: 'item-1', op: 'item.adjust', key: value.key,
  hashVersion: 'canonical/1', hash: canonicalizeJson(value) });
/** @param {any} [options] */
export async function fixture(options = {}) {
  let time = 100;
  const now = () => time;
  const client = await open(model, { driver: nodeDriver(), validator: null, jobs: { now }, ...options });
  const receipts = createDbReceipts(client, { receipts: 'receipts', leases: 'leases', runtime: { now } });
  return { client, receipts, now, advance: (ms) => { time += ms; } };
}
/** @param {any} value @param {any} context */
export async function adjust(value, context) {
  const items = context.host.collections.items;
  const current = await items.get('item-1') ?? { id: 'item-1', revision: 0, count: 0 };
  if (current.revision !== value.expected) return context.fail('conflict');
  const next = { ...current, revision: current.revision + 1, count: current.count + value.delta };
  await items.put(next, next.id);
  await context.host.jobs.enqueue('notify', { count: next.count }, { id: value.key });
  return { revision: next.revision, count: next.count };
}
