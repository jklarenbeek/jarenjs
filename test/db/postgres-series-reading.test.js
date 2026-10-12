//@ts-check
/**
 * @file A native `$resample` bucket on PostgreSQL meets a row with no
 * reading: the kernel refuses it (JQ2001), the database would skip the
 * NULL it reads there, so the statement counts the rows that carry none
 * (`jsonb_typeof` over the document) and the store hands the question
 * back to the engine. OPT-IN: skipped without `JAREN_PG_URL`.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';

const URL = process.env.JAREN_PG_URL;
const SKIP = URL === undefined || URL === '' ? 'JAREN_PG_URL is not set' : false;

const MODEL = {
  $model: '0.1',
  collections: {
    sample: {
      schema: { type: 'object', properties: {
        series: { type: 'string' }, at: { type: 'integer' }, value: { type: ['number', 'null'] } } },
      key: null,
      identity: 'integer',
      indexes: [{ name: 'by_series_at', path: ['$.series', '$.at'] }],
    },
  },
};
const bucket = (aggregate) => ({ $resample: [
  { $for: { s: '$[*]' }, $return: '$s' }, { every: 1000, aggregate }] });

describe('PostgreSQL, a bucket reading the kernel requires of every row', { skip: SKIP }, () => {
  /** @type {any} */
  let admin = null;
  /** @type {any} */
  let pool = null;
  const schema = `jaren_series_reading_${process.pid}`;

  before(async () => {
    const pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: URL, max: 2 });
  });

  after(async () => {
    try {
      if (pool !== null) await pool.end();
    }
    finally {
      if (admin !== null) {
        try {
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
        finally {
          await admin.end();
        }
      }
    }
  });

  it('a row with no reading diverts to the engine, which refuses; a null reading is a gap', async () => {
    const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
    try {
      const samples = store.collection('sample');
      await samples.insert({ series: 'a', at: 1000, value: 4 });
      await samples.insert({ series: 'a', at: 1200, value: null });
      for (const aggregate of ['count', 'max']) {
        assert.strictEqual((await samples.explain(bucket(aggregate))).mode, 'native', aggregate);
        assert.deepStrictEqual(await samples.execute(bucket(aggregate)),
          await samples.execute(bucket(aggregate), { pushdown: false }), aggregate);
      }
      // one bucket is one item, which a sequence of one answers unwrapped
      assert.deepStrictEqual(await samples.execute(bucket('count')), { at: 1000, value: 2, count: 2 });
      assert.strictEqual(samples.stats().series.diverted, 0);
      await samples.insert({ series: 'a', at: 1300 });
      for (const aggregate of ['count', 'max']) {
        await assert.rejects(async () => samples.execute(bucket(aggregate)), { code: 'JQ2001' }, aggregate);
        await assert.rejects(async () => samples.execute(bucket(aggregate), { pushdown: false }),
          { code: 'JQ2001' }, aggregate);
      }
      assert.strictEqual(samples.stats().series.diverted, 2);
    }
    finally {
      await store.close();
    }
  });
});
