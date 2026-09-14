import { it } from 'node:test';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { bunDriver } from '@jarenjs/db/bun';
import { qualifyOutboxRelay } from '../consumer/outbox-relay.js';

const factories = process.versions.bun ? [bunDriver] : [nodeDriver, nodeWorkerDriver, nodeWorkerPoolDriver, nodeProcessDriver];
for (const [index, factory] of factories.entries()) it(`separate-file outbox: ${factory.name} survives delivered-but-unacknowledged replay`, async () => {
  await qualifyOutboxRelay(factory, factories[(index + 1) % factories.length]);
});
