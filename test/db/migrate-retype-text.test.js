//@ts-check
/**
 * @file A rebuild that retypes a number, an integer or a boolean member to
 * text copies each value as the text JavaScript's `String()` spells for the
 * value the store read: `5` where SQLite's cast wrote `5.0`, `1e+21` and
 * `1e-7` where PostgreSQL's wrote every digit, `true` and `false` where both
 * wrote `1` and `0`. An integer keeps its digits. A value the double range
 * does not hold spells as the number the store reads it as. Applied again, the
 * migration changes nothing, and the model it reaches plans nothing more. On
 * SQLite a number whose shortest spelling takes 16 or 17 digits can end in
 * another last digit than `String()`'s, as SQLite's formatter rounds it; the
 * text still reads back as the same number.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openStore, planModelMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { PG_URL, withPostgres } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';
import { NUMBERS, textModel, retypeToText } from './oracle/number-text.js';

/**
 * One database on `engine`, with the handles a retype needs.
 * @typedef {{ dialect: any, open: (m: any) => Promise<any>, target: any, run: (sql: string) => Promise<void>, rows: (sql: string) => Promise<any[]> }} Handles
 * @param {string} engine @param {(h: Handles) => Promise<void>} fn
 */
async function onEngine(engine, fn) {
  if (engine === 'sqlite') {
    const { dbPath, cleanup } = tempDbPath();
    const rows = (/** @type {string} */ sql) => { const d = new DatabaseSync(dbPath); try { return d.prepare(sql).all().map((r) => ({ ...r })); } finally { d.close(); } };
    try {
      await fn({ dialect: sqliteDialect, open: (m) => openStore(m, { driver: nodeDriver(), path: dbPath }),
        target: { driver: nodeDriver(), path: dbPath }, run: async (sql) => { rows(sql); }, rows: async (sql) => rows(sql) });
    }
    finally { cleanup(); }
    return;
  }
  await withPostgres(async ({ pool, schema, driver }) => {
    const rows = async (/** @type {string} */ sql) => {
      const client = await pool.connect();
      try { await client.query(`SET search_path TO "${schema}"`); return (await client.query(sql)).rows; }
      finally { client.release(); }
    };
    await fn({ dialect: postgresDialect({ searchPath: schema }), open: (m) => openStore(m, { driver: driver() }),
      target: { driver: driver() }, run: async (sql) => { await rows(sql); }, rows });
  });
}

/** Plan the rebuild from `from` to `to`, without its draft steps. @param {any} dialect @param {any} from @param {any} to @param {string} [id] */
const planned = (dialect, from, to, id = 'retype') => {
  const { migration } = planModelMigration(from, to, { dialect, id });
  migration.steps = migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
  return migration;
};

/** Every text of `v`, in key order. @param {Handles} h */
const texts = async (h) => (await h.rows('SELECT "v" FROM "T" ORDER BY "id"')).map((row) => row.v);

const ENGINES = ['sqlite', ...(PG_URL ? ['postgres'] : [])];

for (const engine of ENGINES) {
  describe(`${engine}: a rebuild that retypes a member to text spells it as String() does`, () => {
    it('a number', async () => {
      await onEngine(engine, async (h) => {
        const { texts: read } = await retypeToText(h, 'number', NUMBERS);
        assert.deepEqual(read, NUMBERS.map(String));
      });
    });

    it('a boolean, as true or false', async () => {
      await onEngine(engine, async (h) => {
        assert.deepEqual((await retypeToText(h, 'boolean', [true, false])).texts, ['true', 'false']);
      });
    });

    it('an integer, as its digits, a scale a retype from text left included', async () => {
      await onEngine(engine, async (h) => {
        const integers = [5, -5, 0, 81, 9007199254740991, -9007199254740991];
        assert.deepEqual((await retypeToText(h, 'integer', integers)).texts, integers.map(String));
      });
      await onEngine(engine, async (h) => {
        // `12.0` retypes into an integer as 12, which PostgreSQL's numeric keeps as `12.0`
        const store = await h.open(textModel('string'));
        await store.entity('T').create({ id: 'a', v: '12.0' });
        await store.entity('T').create({ id: 'b', v: '-7.000' });
        await store.close();
        await migrate(h.target, [planned(h.dialect, textModel('string'), textModel('integer'))],
          { baseline: textModel('string'), model: textModel('integer'), shadow: false });
        // an integer past 2^53 that trusted SQL wrote keeps every digit, where a double would round it
        await h.run('UPDATE "T" SET "v" = 1152921504606846977 WHERE "id" = \'b\'');
        await migrate(h.target, [planned(h.dialect, textModel('string'), textModel('integer')), planned(h.dialect, textModel('integer'), textModel('string'), 'back')],
          { baseline: textModel('string'), model: textModel('string'), shadow: false });
        assert.deepEqual(await texts(h), ['12', '1152921504606846977']);
      });
    });

    it('a value the double range does not hold, as the number the store reads', async () => {
      await onEngine(engine, async (h) => {
        const raw = engine === 'postgres'
          ? ["'NaN'", "'Infinity'", "'-Infinity'", '1e-400', '-1e-400', '1e400', '-1e400', '1e21']
          : ['9e999', '-9e999'];
        const store = await h.open(textModel('number'));
        for (const at of raw.keys()) await store.entity('T').create({ id: `r${at}`, v: 1 });
        await store.close();
        for (const [at, value] of raw.entries()) await h.run(`UPDATE "T" SET "v" = ${value} WHERE "id" = 'r${at}'`);
        await migrate(h.target, [planned(h.dialect, textModel('number'), textModel('string'))],
          { baseline: textModel('number'), model: textModel('string'), shadow: false });
        assert.deepEqual(await texts(h), raw.map((value) => String(Number(value.replaceAll("'", '')))));
      });
      if (engine === 'postgres') {
        // the integer column is numeric too: past 1e21 it spells as the number the store reads
        await onEngine(engine, async (h) => {
          assert.deepEqual((await retypeToText(h, 'integer', [1e21, -1e22])).texts, ['1e+21', '-1e+22']);
        });
      }
    });

    it('a number key finds its row under the text it now holds', async () => {
      await onEngine(engine, async (h) => {
        const keyed = (/** @type {string} */ type) => ({ $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'],
          properties: { id: { type, 'x-entity': { key: true } }, w: { type: 'string' } } } } } });
        const store = await h.open(keyed('number'));
        await store.entity('T').create({ id: 5, w: 'five' });
        await store.entity('T').create({ id: 0.5, w: 'half' });
        await store.close();
        await migrate(h.target, [planned(h.dialect, keyed('number'), keyed('string'))], { baseline: keyed('number'), model: keyed('string'), shadow: false });
        const after = await h.open(keyed('string'));
        try {
          assert.deepEqual([(await after.entity('T').asNoTracking().get('5'))?.w, (await after.entity('T').asNoTracking().get('0.5'))?.w], ['five', 'half']);
        }
        finally { await after.close(); }
      });
    });

    it('runs once: applied again it changes nothing, and the model it reaches plans nothing more', async () => {
      await onEngine(engine, async (h) => {
        const { texts: read, migration } = await retypeToText(h, 'number', [5, 1e21, 0.1]);
        assert.deepEqual(read, ['5', '1e+21', '0.1']);
        await migrate(h.target, [migration], { baseline: textModel('number'), model: textModel('string'), shadow: false });
        assert.deepEqual(await texts(h), ['5', '1e+21', '0.1']);
        const store = await h.open(textModel('string'));
        try {
          const { model: derived } = await store.introspect();
          assert.deepEqual(planModelMigration(derived, textModel('string'), { dialect: h.dialect, id: 'again' }).migration.steps, []);
        }
        finally { await store.close(); }
      });
    });

    it('every power of two and a seeded spread of doubles reads back as itself', async () => {
      const values = [];
      for (let exponent = -1074; exponent <= 1023; exponent += 1) values.push(2 ** exponent);
      let seed = 20261014;
      const view = new DataView(new ArrayBuffer(8));
      while (values.length < 2098 + 2000) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; view.setUint32(0, seed);
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; view.setUint32(4, seed);
        const value = view.getFloat64(0);
        if (Number.isFinite(value)) values.push(value);
      }
      await onEngine(engine, async (h) => {
        const store = await h.open(textModel('number'));
        await store.entity('T').create({ id: 'x', v: 1 });
        await store.close();
        await h.run('DELETE FROM "T"');
        for (let at = 0; at < values.length; at += 500) {
          const rows = values.slice(at, at + 500).map((value, offset) =>
            `('${String(at + offset).padStart(5, '0')}', ${engine === 'postgres' ? `'${String(value)}'` : String(value)}, ${engine === 'postgres' ? "'{}'" : "jsonb('{}')"})`);
          await h.run(`INSERT INTO "T" ("id", "v", "doc") VALUES ${rows.join(', ')}`);
        }
        await migrate(h.target, [planned(h.dialect, textModel('number'), textModel('string'))],
          { baseline: textModel('number'), model: textModel('string'), shadow: false });
        const read = await texts(h);
        assert.equal(read.length, values.length);
        const differ = read.flatMap((text, at) => (text === String(values[at]) ? [] : [[values[at], text]]));
        assert.deepEqual(read.filter((text, at) => Number(text) !== values[at]), [], 'every text reads back as the stored double');
        if (engine === 'postgres') assert.deepEqual(differ, []);
        // SQLite rounds the last of 16 or 17 digits with its own formatter: the same digits but the last
        const digits = (/** @type {any} */ text) => String(text).replace(/e.*$/, '').replace(/[-.]/g, '').replace(/^0+/, '');
        for (const [value, text] of differ) {
          assert.ok(digits(String(value)).length >= 16 && digits(text).length === digits(String(value)).length
            && digits(text).slice(0, -1) === digits(String(value)).slice(0, -1), `${value} spelled ${text}`);
        }
      });
    });
  });
}

describe('sqlite: a key a foreign key joins, and the column that joins it, keep the cast into text', () => {
  it('the child still finds its parent, and a plain number of the same table spells as String() does', async () => {
    const model = (/** @type {string} */ type) => ({ $model: '0.1', entities: {
      P: { schema: { type: 'object', required: ['id'], properties: { id: { type, 'x-entity': { key: true } }, n: { type },
        kids: { 'x-entity': { relation: { to: 'C', many: true, via: 'pid', onDelete: 'cascade' } } } } } },
      C: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, pid: { type } } } } } });
    await onEngine('sqlite', async (h) => {
      const store = await h.open(model('number'));
      await store.entity('P').create({ id: 5, n: 5 });
      await store.entity('C').create({ id: 'c', pid: 5 });
      await store.close();
      await migrate(h.target, [planned(h.dialect, model('number'), model('string'))], { baseline: model('number'), model: model('string'), shadow: false });
      // SQLite compares a reference by the key column's type, so the key and the
      // reference keep the text the cast writes, `5.0`, and still match
      assert.deepEqual(await h.rows('SELECT "id", "n" FROM "P"'), [{ id: '5.0', n: '5' }]);
      assert.deepEqual(await h.rows('SELECT "pid" FROM "C"'), [{ pid: '5.0' }]);
      const after = await h.open(model('string'));
      try {
        assert.deepEqual((await after.entity('C').asNoTracking().get('c'))?.pid, '5.0');
        assert.deepEqual((await after.entity('P').asNoTracking().get('5.0'))?.n, '5');
        assert.deepEqual(await after.foreignKeyCheck(), { ok: true, violations: [] });
      }
      finally { await after.close(); }
    });
  });
});

describe('sqlite: a key a join table references keeps the cast into text', () => {
  it('plans the cast for the key, and refuses the retype as before, the join table being no part of the rebuild', async () => {
    const model = (/** @type {string} */ type) => ({ $model: '0.1', entities: {
      P: { schema: { type: 'object', required: ['id'], properties: { id: { type, 'x-entity': { key: true } }, n: { type },
        tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
      Tag: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } } } } } } });
    await onEngine('sqlite', async (h) => {
      const store = await h.open(model('number'));
      await store.entity('P').create({ id: 5, n: 5 });
      await store.entity('Tag').create({ id: 't' });
      await store.close();
      await h.run('INSERT INTO "P_Tag" ("P_key", "Tag_key") VALUES (5, \'t\')');
      const migration = planned(h.dialect, model('number'), model('string'));
      assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.kind), ['rebuild']);
      assert.match(migration.steps[0].copy, /SELECT CAST\("id" AS TEXT\), CASE WHEN "n" IS NULL/);
      await assert.rejects(() => migrate(h.target, [migration], { baseline: model('number'), model: model('string'), shadow: false }),
        (/** @type {any} */ error) => error.code === 'JD0023' && /the migrated shape does not equal the target model's: table:P_Tag differs/.test(error.message));
      assert.deepEqual(await h.rows('SELECT "P_key", "Tag_key" FROM "P_Tag"'), [{ P_key: 5, Tag_key: 't' }]);
      assert.deepEqual(await h.rows('SELECT "id", "n" FROM "P"'), [{ id: 5, n: 5 }]);
    });
  });
});
