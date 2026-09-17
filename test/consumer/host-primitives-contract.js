import assert from 'node:assert/strict';
import { createProviderExecutor } from '@jarenjs/contract/provider';
let calls = 0;
const executor = createProviderExecutor({ cache: new Map(), cacheScope: 'installed/public-v1',
  transport: async () => { calls++; return new Response('captured'); } });
try {
  const request = { url: 'https://fixture.invalid', safety: 'safe-read' };
  assert.equal((await executor.execute(request)).replayed, false);
  const replayed = await executor.execute(request);
  assert.equal(replayed.replayed, true); assert.equal(replayed.text, 'captured'); assert.equal(calls, 1);
} finally { await executor.close(); }
