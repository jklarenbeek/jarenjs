export const model = { $model: '0.1', collections: Object.fromEntries(['observations', 'checkpoints', 'snapshots', 'facts'].map((name) => [name, {
  schema: { type: 'object' }, key: '/id', indexes: [],
}])) };
export const storeOptions = { staging: 'observations', checkpoints: 'checkpoints', publications: 'snapshots', facts: 'facts' };
export const plan = { source: 'inventory/test', version: 'source-1', generation: 'generation-1',
  partitions: ['north', 'south'], input: {}, policyRevision: 'policy-1', consistency: 'snapshot' };
export const proof = (plan) => ({ version: plan.version, consistency: plan.consistency });

export function page(partition, cursor = null, extra = {}) {
  const rows = [{ id: `${partition}-${cursor ?? 'first'}`, quantity: null, provenance: 'source' }];
  const raw = { items: rows, next: cursor === null ? 'next' : null, version: plan.version };
  const text = JSON.stringify(raw);
  return { state: 'page', cursor, continuation: raw.next, raw, text, rows, ids: rows.map((row) => row.id),
    version: plan.version, complete: raw.next === null, reason: null, errors: null, cost: null, bytes: new TextEncoder().encode(text).length, attempts: 1, ...extra };
}

export function provider(seen = [], interrupt = () => false) {
  return { async *pages(_input, { partition, cursor }) {
    seen.push([partition, cursor]);
    if (cursor === null) {
      yield page(partition);
      if (interrupt(partition)) throw new Error('interrupted');
    }
    yield page(partition, 'next');
    yield { state: 'complete' };
  } };
}
