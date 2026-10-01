import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import '@jarenjs/db/worker-endpoint';

const model = { $model: '0.1', collections: { notes: { key: '/id', schema: { type: 'object' } } } } as const;
// a bundled or compiled application names its own copy of the endpoint
const endpoint = new URL('./worker-endpoint.js', import.meta.url);
const pool = nodeWorkerPoolDriver({ readers: 2, endpoint });
nodeWorkerDriver({ endpoint: endpoint.href });

async function parallelReads() {
  const store = await openStore(model, { driver: pool, path: 'application.sqlite', reads: 'parallel' });
  const mode: 'parallel' | 'serialized' = store.capabilities.parallelReads;
  const serialized = await openStore(model, { driver: nodeDriver(), reads: 'serialized' });
  void [mode, serialized.capabilities.parallelReads];
  await store.close(); await serialized.close();
}
void parallelReads;
// @ts-expect-error reads is 'serialized' or 'parallel'
void openStore(model, { driver: pool, reads: 'concurrent' });
// @ts-expect-error the endpoint is a URL, not a number
nodeWorkerPoolDriver({ endpoint: 7 });
// @ts-expect-error the process host forks its own endpoint
nodeProcessDriver({ endpoint });
