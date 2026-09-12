/** A committed page survives an abrupt process exit without closing its store. */
import { open, createDbIngestionStore } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { model, storeOptions, plan, page } from '../../flow/fixtures/ingestion.js';
import { crashAt } from './abrupt-exit.js';
const client = await open(model, { driver: nodeDriver(), path: process.argv[2], validator: null });
const store = createDbIngestionStore(client, storeOptions);
await store.begin(plan);
await store.stage(plan, 'north', page('north'));
crashAt('staged');
