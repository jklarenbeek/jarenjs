import { federate, fromAsync, type AsyncProvider, type FederationPlan } from '@jarenjs/linq';
import type { LiveMode } from '@jarenjs/db';

const provider: AsyncProvider<{ id: string }> = {
  root: '$[*]',
  async execute() { return []; },
};
const federation = federate({ sources: { a: provider, b: provider, c: provider },
  maxRows: 100, maxBytes: 4096, maxTotalRows: 250, maxTotalBytes: 8192 });
const chain = fromAsync(federation.source<{ id: string }>('a'))
  .join(fromAsync(federation.source<{ id: string }>('b')), (a) => a.id, (b) => b.id, (a) => a)
  .join(fromAsync(federation.source<{ id: string }>('c')), (a) => a.id, (c) => c.id, (a) => a);
const plan: FederationPlan = federation.source('a').explain(chain.toDocument());
const total: number = plan.combinedBudget.maxTotalBytes;
const nested: string | undefined = plan.order[0]?.children?.[0]?.source;
const distinct: LiveMode['strategy'] = 'distinct';
void [total, nested, distinct];
