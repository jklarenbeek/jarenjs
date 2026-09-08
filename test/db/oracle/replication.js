//@ts-check
/** Transport scheduling and state oracles contain no conflict policy. */
import * as assert from 'node:assert/strict';
import { mulberry32 } from '@jarenjs/core/random';
import { applyJSONPatch } from '@jarenjs/json/patch';

export const replicationModel = {
  $model: '0.1',
  collections: { notes: { key: '/id', schema: { type: 'object', required: ['id'],
    properties: { id: { type: 'string' }, n: { type: 'integer' }, group: { type: 'string' } } } } },
  entities: {
    Parent: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' },
      tags: { 'x-entity': { relation: { to: 'Tag', many: true } } },
    } } },
    Tag: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } }, label: { type: 'string' },
    } } },
  },
};

/** Seeded duplicate, reorder and drop controls over opaque messages. */
export function deliverySchedule(messages, { seed = 42, duplicate = true, drop = [] } = {}) {
  const random = mulberry32(seed);
  const deliveries = messages.flatMap((message, index) => drop.includes(index) ? []
    : Array.from({ length: duplicate && random() < 0.5 ? 2 : 1 }, () => structuredClone(message)));
  for (let i = deliveries.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deliveries[i], deliveries[j]] = [deliveries[j], deliveries[i]];
  }
  return deliveries;
}

/** Canonical complete state, including relation rows and hostile identifiers. */
export async function replicaState(store) {
  const notes = await store.collection('notes').execute([{ $for: { n: '$[*]' }, $return: '$n' }]);
  const parents = await store.entity('Parent').asNoTracking().load({ include: { tags: true } });
  const tags = await store.entity('Tag').asNoTracking().load({});
  const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return { notes: byId(notes), Parent: byId(parents.map(({ tags: _tags, ...row }) => row)),
    Tag: byId(tags), Parent_Tag: parents.flatMap((parent) => (parent.tags ?? []).map((tag) => [parent.id, tag.id])).sort() };
}

/** A consumer reconstructs exclusively from patches and checks a fresh evaluation. */
export function liveOracle(live, fresh) {
  let mirror = structuredClone(live.result);
  let emissions = 0;
  const unsubscribe = live.subscribe((event) => {
    if (event.error) return;
    mirror = applyJSONPatch(mirror, event.patch);
    emissions++;
  });
  return { async check() {
    assert.equal(live.state, 'live');
    assert.deepEqual(mirror, live.result);
    assert.deepEqual(live.result.rows, await fresh());
  }, get emissions() { return emissions; }, close: unsubscribe };
}
