import { createProviderExecutor, providerReplayKey } from '@jarenjs/contract/provider';
import type { SubscriptionLike } from '@jarenjs/contract/stream';
const request = { url: 'https://example.test', safety: 'safe-read' as const };
const executor = createProviderExecutor({ cache: new Map(), cacheScope: 'public/v1', replay: 'replay' });
const key: string = await providerReplayKey(request, { scope: 'public/v1' });
await executor.execute(request); await executor.close();
const source: SubscriptionLike = { snapshot: () => [], snapshotWithCursor: async ({ signal }) => ({ value: [], seq: signal.aborted ? 0 : 1 }),
  subscribe: () => () => {}, close() {} };
void [key, source];
