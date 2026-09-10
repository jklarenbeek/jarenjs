//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadSqlCensus, storeForSqlCensus } from './oracle/harness.js';

const census = loadSqlCensus();
const plain = (value) => JSON.parse(JSON.stringify(value));

describe('native SQL census contracts', () => {
  it('mandatory environment predicates apply inside native correlated counts', async () => {
    const { store } = await storeForSqlCensus();
    try {
      const query = census.reads.find((r) => r.id === 'correlated-count').query;
      const profile = { maxRows: 16, refuseFullScan: false, predicates: { Inventory: { $eq: ['$it.environment', 'preview'] } } };
      const expected = [{ sku: '0007', locations: 1 }, { sku: '0012', locations: 0 }];
      assert.deepEqual(await store.execute(query, { strict: true, profile }), expected);
      assert.deepEqual(await store.execute(query, { pushdown: false, profile }), expected);
    }
    finally { await store.close(); }
  });
  it('streaming explanations count the admitted rows before early release', async () => {
    const { store } = await storeForSqlCensus();
    try {
      const query = { $for: { c: '$.Catalog[*]' }, $return: { sku: '$c.sku' } };
      const cursor = store.entity('Catalog').cursor(query);
      assert.deepEqual((await cursor.next()).value, { sku: '0007' });
      await cursor.return();
      const explained = await store.explain(query);
      assert.equal(explained.admitted.statements, 1);
      assert.equal(explained.admitted.rows, 1);
      assert.ok(explained.admitted.bytes > 2);
    }
    finally { await store.close(); }
  });
  it('enumerates the frozen read and mutation families with finite costs and public forms', async () => {
    const { store, fixture } = await storeForSqlCensus();
    try {
      assert.deepEqual(census.reads.map((r) => r.id), fixture.reads.map((r) => r.id));
      assert.deepEqual(census.mutations.map((r) => r.id), fixture.mutations.map((r) => r.id));
      for (const family of [...census.reads, ...census.mutations]) {
        assert.equal(family.referenceStatements, 1);
        assert.ok(['native', 'refused'].includes(family.target));
        assert.ok(Object.values(family.budget).every((n) => Number.isSafeInteger(n) && n > 0));
        assert.ok(family.query || family.document || family.reason);
      }
    }
    finally { await store.close(); }
  });
  for (const side of ['indexed', 'unindexed']) {
    for (const read of census.reads) it(`${read.id}: ${side} public meaning matches retained SQL`, async () => {
      const { store, db, calls } = await storeForSqlCensus(side);
      try {
        assert.deepEqual(plain(await (await db.prepare(read.sql)).all([])), read.expected);
        if (read.query === null) {
          assert.equal(read.target, 'refused');
          assert.match(read.reason, /primary key/);
          return;
        }
        calls.length = 0;
        assert.deepEqual(await store.execute(read.query, { strict: true }), read.expected);
        assert.equal(calls.length, read.budget.statements);
        const explained = await store.explain(read.query);
        assert.equal(explained.mode, 'native');
        assert.equal(explained.admitted.statements, 1);
        assert.ok(explained.admitted.rows <= read.budget.rows);
        assert.ok(explained.admitted.bytes <= read.budget.bytes);
        assert.ok(explained.scanNarrative.length > 0);
        assert.deepEqual(await store.execute(read.query, { pushdown: false }), read.expected);
      }
      finally { await store.close(); }
    });
  }
  it('preserves null-only sums, unmatched correlations, duplicate join keys and tied order', async () => {
    const { store, db } = await storeForSqlCensus();
    try {
      await db.exec("INSERT INTO catalog VALUES ('0000','Green tea','tea'),('z','Green tea','tea'); INSERT INTO inventory VALUES ('0012','preview',NULL,NULL,1),('z','null-only',NULL,NULL,1),('z','test',NULL,NULL,1)");
      for (const read of census.reads.filter((r) => r.query)) {
        const expected = plain(await (await db.prepare(read.sql)).all([]));
        assert.deepEqual(await store.execute(read.query, { strict: true }), expected, read.id);
        assert.deepEqual(await store.execute(read.query, { pushdown: false }), expected, read.id);
      }
      const grouped = census.reads.find((r) => r.id === 'nullable-aggregate');
      assert.equal((await store.execute(grouped.query)).find((r) => r.environment === 'null-only').quantity, null);
    }
    finally { await store.close(); }
  });
});
