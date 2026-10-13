//@ts-check
/**
 * @file An instant key kept as an epoch column (`column: "integer"` on a key)
 * opens and serves an append-only, range-queried log: create, load, ordered
 * load and a range predicate answer by the instant. The statements that name
 * one row by its key (`get`, `update`, `delete`) bind the string against the
 * integer column and find no row, so they are not claimed here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntities, openStore, planModelMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

/** @param {boolean} epoch */
const model = (epoch) => ({ $model: '0.1', entities: { E: { schema: { type: 'object', properties: {
  at: { type: 'string', format: 'date-time', 'x-entity': { key: true, ...(epoch ? { column: 'integer' } : {}) } }, n: { type: 'integer' } } } } } });
const AT = ['2026-03-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'];

describe('an instant key kept as an epoch column', () => {
  it('opens, and an append-only log is loaded, ordered and range-queried by the instant', async () => {
    assert.equal(normalizeEntities(model(true)).get('E').properties.get('at').column, 'integer');
    const store = await openStore(model(true), { driver: nodeDriver() });
    try {
      for (const [n, at] of AT.entries()) await store.entity('E').create({ at, n });
      assert.deepEqual((await store.entity('E').load({ orderBy: '$it.at' })).map((row) => row.at), [AT[1], AT[2], AT[0]]);
      assert.deepEqual(await store.execute([{ $for: { e: '$.E[*]' }, $where: { $gt: ['$e.at', '2026-01-15T00:00:00.000Z'] },
        $orderby: ['$e.at'], $return: '$e.n' }]), [2, 0]);
    }
    finally { await store.close(); }
  });

  it('a baseline keyed by the epoch plans to a text key and back', () => {
    for (const [from, to] of [[true, false], [false, true]]) {
      const plan = planModelMigration(model(from), model(to), { dialect: sqliteDialect });
      assert.equal(plan.migration.$migration, '0.2');
      assert.notEqual(plan.migration.from, plan.migration.to);
    }
  });
});
