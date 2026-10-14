//@ts-check
/**
 * @file A rebuild that retypes a mapped column copies each value through a
 * cast, and a value the target type cannot hold does not survive it: a text
 * that names no number, a fraction in an integer, a number in a boolean, an
 * integer a double cannot hold exactly. The rebuild checks the stored values
 * ahead of its copy, under the table lock where PostgreSQL has one, and a
 * value that would not survive refuses the migration (`JD0023`, naming the
 * member, the table and the value) with every row as it was. Both engines
 * answer one verdict for one value, and a retype that loses nothing plans no
 * check.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openStore, planModelMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { PG_URL, withPostgres } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

/** @param {string} type */
const model = (type) => ({ $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'], properties: {
  id: { type: 'string', 'x-entity': { key: true } }, v: { type }, w: { type: 'string' } } } } } });
const CHECK = /^WITH "_jaren_cast"/;

/**
 * One database on `engine`, with the handles a retype needs.
 * @typedef {{ dialect: any, open: (m: any) => Promise<any>, target: any, text: (sql: string) => Promise<any[]>, run: (sql: string) => Promise<void> }} Handles
 * @param {string} engine @param {(h: Handles) => Promise<void>} fn
 */
async function onEngine(engine, fn) {
  if (engine === 'sqlite') {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const read = (/** @type {string} */ sql) => { const d = new DatabaseSync(dbPath); try { return d.prepare(sql).all().map((r) => ({ ...r })); } finally { d.close(); } };
      await fn({ dialect: sqliteDialect, open: (m) => openStore(m, { driver: nodeDriver(), path: dbPath }),
        target: { driver: nodeDriver(), path: dbPath }, text: async (sql) => read(sql), run: async (sql) => { read(sql); } });
    }
    finally { cleanup(); }
    return;
  }
  await withPostgres(async ({ pool, schema, driver }) => {
    /** @param {string} sql */
    const query = async (sql) => {
      const client = await pool.connect();
      try { await client.query(`SET search_path TO "${schema}"`); return (await client.query(sql)).rows; }
      finally { client.release(); }
    };
    await fn({ dialect: postgresDialect({ searchPath: schema }), open: (m) => openStore(m, { driver: driver() }),
      target: { driver: driver() }, text: query, run: async (sql) => { await query(sql); } });
  });
}

/**
 * Seed one row holding `seed` as `from`, retype the column to `to`, and answer
 * what happened: the refusal, or nothing, and the column read as text after.
 * @param {Handles} h @param {string} from @param {string} to @param {any} seed
 */
async function retype(h, from, to, seed) {
  const store = await h.open(model(from));
  const raw = seed !== null && typeof seed === 'object' ? seed.raw : undefined;
  await store.entity('T').create({ id: 'r', v: raw === undefined ? seed : 1, w: 'kept' });
  await store.close();
  if (raw !== undefined) await h.run(`UPDATE "T" SET "v" = ${raw}`);
  const { migration } = planModelMigration(model(from), model(to), { dialect: h.dialect, id: 'retype' });
  migration.steps = migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
  /** @type {any} */
  let refusal = null;
  try { await migrate(h.target, [migration], { baseline: model(from), model: model(to), shadow: false }); }
  catch (error) { refusal = error; }
  const [row] = await h.text('SELECT CAST("v" AS TEXT) AS v, "w" FROM "T"');
  return { refusal, value: row.v, kept: row.w, migration };
}

const ENGINES = ['sqlite', ...(PG_URL ? ['postgres'] : [])];
/**
 * [from, to, seed, the number it lands as, or null for a refusal]; where the engines' own casts differ,
 * `{ sqlite, postgres }`.
 * @type {[string, string, any, number | null | { sqlite: number | null, postgres: number | null }][]}
 */
const CASES = [
  // a text into an integer: the number the cast keeps, however it is spelled
  ['string', 'integer', '12', 12], ['string', 'integer', '-12', -12], ['string', 'integer', '0', 0],
  ['string', 'integer', '007', 7], ['string', 'integer', '+5', 5], ['string', 'integer', ' 12', 12],
  ['string', 'integer', '12.0', 12], ['string', 'integer', '5.', 5], ['string', 'integer', '-0', 0],
  ['string', 'integer', '9223372036854775807', 2 ** 63], ['string', 'integer', '-9223372036854775808', -9223372036854775808],
  ['string', 'integer', '1e3', { sqlite: null, postgres: 1000 }],
  // a text the cast truncates, reads as 0 or cannot hold
  ['string', 'integer', 'abc', null], ['string', 'integer', '12.5', null], ['string', 'integer', 'true', null],
  ['string', 'integer', 'NaN', null], ['string', 'integer', '', null], ['string', 'integer', '.5', null],
  ['string', 'integer', '1000000000000000000.4', null], ['string', 'integer', '12abc', null],
  ['string', 'integer', '99999999999999999999', null], ['string', 'integer', '9223372036854775808', null],
  ['string', 'integer', '-9223372036854775809', null], ['string', 'integer', '-9223372036854775808.5', null],
  ['string', 'integer', '-9223372036854776832', null], ['string', 'integer', '-9223372036854776000', null],
  ['string', 'number', '12', 12], ['string', 'number', '12.5', 12.5], ['string', 'number', '1e3', 1000],
  ['string', 'number', '-0.25e2', -25], ['string', 'number', '.5', 0.5], ['string', 'number', '5.', 5],
  ['string', 'number', '+5', 5], ['string', 'number', '007', 7], ['string', 'number', ' 12', 12],
  ['string', 'number', 'abc', null], ['string', 'number', 'true', null], ['string', 'number', 'NaN', null],
  ['string', 'number', 'Infinity', null], ['string', 'number', '1e999', null], ['string', 'number', '', null],
  ['string', 'number', '9007199254740992', 9007199254740992], ['string', 'number', '9223372036854775807', { sqlite: null, postgres: 2 ** 63 }],
  ['string', 'number', '1.2.3', null], ['string', 'number', '1e-400', 0],
  // an unsigned hexadecimal, octal or binary integer, which Number() reads and PostgreSQL's cast reads alike (SQLite's reads 0);
  // a signed one, digits grouped by `_` and a fraction of one, which Number() reads as NaN and PostgreSQL's cast reads as a number
  ['string', 'number', '0x10', { sqlite: null, postgres: 16 }], ['string', 'number', '0X1f', { sqlite: null, postgres: 31 }],
  ['string', 'number', '0o20', { sqlite: null, postgres: 16 }], ['string', 'number', '0b101', { sqlite: null, postgres: 5 }],
  ['string', 'number', ' 0x10 ', { sqlite: null, postgres: 16 }], ['string', 'number', `0x${'f'.repeat(256)}`, null],
  ['string', 'number', '-0x10', null], ['string', 'number', '+0x10', null], ['string', 'number', '1_000', null],
  ['string', 'number', '0x1_0', null], ['string', 'number', '0x10.5', null],
  ['string', 'integer', '0x10', { sqlite: null, postgres: 16 }], ['string', 'integer', `0x${'f'.repeat(16)}`, null],
  ['string', 'integer', '1_000', null], ['string', 'boolean', '0x1', { sqlite: null, postgres: 1 }],
  ['string', 'boolean', '0x2', null], ['string', 'boolean', '-0x1', null],
  ['string', 'boolean', '1', 1], ['string', 'boolean', '0', 0], ['string', 'boolean', '01', 1], ['string', 'boolean', '+1', 1],
  ['string', 'boolean', 'true', null], ['string', 'boolean', '2', null], ['string', 'boolean', '12', null],
  ['string', 'boolean', '-1', null], ['string', 'boolean', 'abc', null], ['string', 'boolean', '1.0', null],
  ['integer', 'number', 81, 81], ['integer', 'number', 9007199254740992, 9007199254740992],
  ['integer', 'number', { raw: '9007199254740993' }, { sqlite: null, postgres: 9007199254740992 }],
  ['integer', 'number', { raw: '-9007199254740993' }, { sqlite: null, postgres: -9007199254740992 }],
  ['integer', 'number', { raw: '9223372036854775807' }, { sqlite: null, postgres: 2 ** 63 }],
  ['integer', 'boolean', 0, 0], ['integer', 'boolean', 1, 1], ['integer', 'boolean', 2, null],
  ['integer', 'boolean', 81, null], ['integer', 'boolean', -1, null],
  ['number', 'integer', 81, 81], ['number', 'integer', 0, 0], ['number', 'integer', 81.125, null],
  ['number', 'integer', 0.5, null], ['number', 'integer', 1e30, null], ['number', 'integer', 2 ** 63, null],
  ['number', 'integer', 2 ** 62, 2 ** 62], ['number', 'integer', -(2 ** 63), -(2 ** 63)],
  ['number', 'integer', -(2 ** 63) - 4096, null],
  ['number', 'boolean', 0, 0], ['number', 'boolean', 1, 1], ['number', 'boolean', 0.5, null],
  ['number', 'boolean', 81.125, null], ['number', 'boolean', 2, null], ['number', 'boolean', 5, null], ['number', 'boolean', 1e30, null],
  ['integer', 'string', 81, 81], ['number', 'string', 81.125, 81.125],
  ['boolean', 'integer', true, 1], ['boolean', 'number', false, 0],
];

for (const engine of ENGINES) {
  describe(`${engine}: a retype whose copy would lose a value is refused before the copy`, () => {
    for (const [from, to, seed, expected] of CASES) {
      const lands = expected !== null && typeof expected === 'object' ? expected[/** @type {'sqlite' | 'postgres'} */ (engine)] : expected;
      const shown = typeof seed === 'object' ? seed.raw : JSON.stringify(seed);
      it(`${from} ${shown} -> ${to}: ${lands === null ? 'refused' : `lands as ${lands}`}`, async () => {
        await onEngine(engine, async (h) => {
          const held = await retype(h, from, to, seed);
          if (lands !== null) {
            assert.equal(held.refusal, null);
            assert.equal(Number(held.value), lands);
            return;
          }
          assert.equal(held.refusal?.code, 'JD0023', held.refusal?.message);
          // a double past 2^62 is written as each engine writes it, so only the member is checked there
          const text = typeof seed === 'object' ? seed.raw : typeof seed === 'number' && Math.abs(seed) >= 2 ** 62 ? '' : String(seed);
          const mark = engine === 'postgres' ? "'" : '"';
          assert.ok(held.refusal.message.includes(`the member ${mark}v${mark} of ${mark}T${mark} holds ${text}`), held.refusal.message);
          assert.ok(held.refusal.message.includes(`step 0 (rebuild)`), held.refusal.message);
          // the migration rolled back whole: the row is as it was, in its first type
          assert.equal(held.kept, 'kept');
          if (typeof seed === 'object') assert.equal(held.value, seed.raw);
          else if (typeof seed === 'number') assert.equal(Number(held.value), seed);
          else assert.equal(held.value, seed);
        });
      });
    }

    it('names the first offender in order and leaves NULL members alone', async () => {
      await onEngine(engine, async (h) => {
        const store = await h.open(model('string'));
        await store.entity('T').create({ id: 'a', w: 'absent' });
        await store.entity('T').create({ id: 'b', v: '7', w: 'ok' });
        await store.entity('T').create({ id: 'c', v: 'zebra', w: 'bad' });
        await store.entity('T').create({ id: 'd', v: 'apple', w: 'bad' });
        await store.close();
        const { migration } = planModelMigration(model('string'), model('integer'), { dialect: h.dialect, id: 'retype' });
        migration.steps = migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
        await assert.rejects(() => migrate(h.target, [migration], { baseline: model('string'), model: model('integer'), shadow: false }),
          (/** @type {any} */ error) => error.code === 'JD0023' && error.message.includes(`the member ${engine === 'postgres' ? "'v' of 'T'" : '"v" of "T"'} holds apple`));
        assert.deepEqual((await h.text('SELECT "id", CAST("v" AS TEXT) AS v FROM "T" ORDER BY "id"')).map((r) => [r.id, r.v]),
          [['a', null], ['b', '7'], ['c', 'zebra'], ['d', 'apple']]);
        // without the offenders the same migration runs, the absent member staying absent
        await h.run(`DELETE FROM "T" WHERE "id" IN ('c', 'd')`);
        await migrate(h.target, [migration], { baseline: model('string'), model: model('integer'), shadow: false });
        assert.deepEqual((await h.text('SELECT "id", CAST("v" AS TEXT) AS v FROM "T" ORDER BY "id"')).map((r) => [r.id, r.v]),
          [['a', null], ['b', '7']]);
      });
    });
  });
}

describe('the check is planned where a cast can lose, and nowhere else', () => {
  /** The statements a rebuild runs ahead of its copy, past the table's creation. @param {any} dialect @param {string} from @param {string} to */
  const planned = (dialect, from, to) => {
    const rebuild = planModelMigration(model(from), model(to), { dialect, id: 'm' }).migration.steps.find((/** @type {any} */ s) => s.kind === 'rebuild');
    return { rebuild, checks: rebuild.create.filter((/** @type {string} */ sql) => CHECK.test(sql)) };
  };
  const LOSSY = [['string', 'integer'], ['string', 'number'], ['string', 'boolean'], ['integer', 'number'],
    ['integer', 'boolean'], ['number', 'integer'], ['number', 'boolean']];
  const LOSSLESS = [['integer', 'string'], ['number', 'string'], ['boolean', 'string'], ['boolean', 'integer'], ['boolean', 'number']];

  it('SQLite: a lossy retype is one check after the new table; a lossless one plans none', () => {
    for (const [from, to] of LOSSY) {
      const { rebuild, checks } = planned(sqliteDialect, from, to);
      assert.equal(checks.length, 1, `${from} -> ${to}`);
      assert.equal(rebuild.create.indexOf(checks[0]), 1, 'right after the CREATE TABLE of the new shape');
      assert.match(checks[0], /^WITH "_jaren_cast" AS \(SELECT "v" FROM "T" WHERE "v" IS NOT NULL AND .* ORDER BY "v" LIMIT 1\) SELECT json_extract\('\{\}', /s);
      assert.equal(rebuild.create.length, 2);
    }
    for (const [from, to] of LOSSLESS) {
      const { rebuild, checks } = planned(sqliteDialect, from, to);
      assert.equal(checks.length, 0, `${from} -> ${to}`);
      assert.equal(rebuild.create.length, 1);
    }
  });

  it('PostgreSQL: the check runs under the rebuild lock, after the lock and before the copy', () => {
    const dialect = postgresDialect();
    // PostgreSQL's numeric column keeps an integer past 2^53 as it is
    for (const [from, to] of LOSSY.filter(([f, t]) => !(f === 'integer' && t === 'number'))) {
      const { rebuild, checks } = planned(dialect, from, to);
      assert.equal(checks.length, 1, `${from} -> ${to}`);
      assert.match(rebuild.create[0], /LOCK TABLE/);
      assert.equal(rebuild.create.indexOf(checks[0]), 2, 'after the lock and the new table');
      assert.match(checks[0], /\)::bigint FROM "_jaren_cast"$/);
    }
    for (const [from, to] of [...LOSSLESS, ['integer', 'number']]) assert.equal(planned(dialect, from, to).checks.length, 0, `${from} -> ${to}`);
  });

  it('an instant retyped to a number plans no check, to a boolean one; each retyped column has its own, on both engines', () => {
    const instant = (/** @type {string} */ type, /** @type {any} */ extra = {}) => ({ $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'],
      properties: { id: { type: 'string', 'x-entity': { key: true } }, m: type === 'datetime' ? { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } } : { type }, ...extra } } } } });
    const rebuildOf = (/** @type {any} */ dialect, /** @type {any} */ from, /** @type {any} */ to) =>
      planModelMigration(from, to, { dialect, id: 'm' }).migration.steps.find((/** @type {any} */ s) => s.kind === 'rebuild');
    const checksOf = (/** @type {any} */ rebuild) => rebuild.create.filter((/** @type {string} */ sql) => CHECK.test(sql)).length;
    for (const dialect of [sqliteDialect, postgresDialect()]) {
      assert.equal(checksOf(rebuildOf(dialect, instant('datetime'), instant('number'))), 0);
      assert.equal(checksOf(rebuildOf(dialect, instant('datetime'), instant('boolean'))), 1);
      assert.equal(checksOf(rebuildOf(dialect, instant('string', { n: { type: 'string' } }), instant('integer', { n: { type: 'number' } }))), 2);
    }
  });

  it('a key column retyped is checked like any other', () => {
    const keyed = (/** @type {string} */ type) => ({ $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'],
      properties: { id: { type, 'x-entity': { key: true } }, w: { type: 'string' } } } } } });
    for (const dialect of [sqliteDialect, postgresDialect()]) {
      const plan = planModelMigration(keyed('string'), keyed('integer'), { dialect, id: 'm' }).migration.steps.find((/** @type {any} */ s) => s.kind === 'rebuild');
      assert.equal(plan.create.filter((/** @type {string} */ sql) => CHECK.test(sql)).length, 1);
      assert.match(plan.create.find((/** @type {string} */ sql) => CHECK.test(sql)), /FROM "T" WHERE "id" IS NOT NULL/);
    }
  });
});
