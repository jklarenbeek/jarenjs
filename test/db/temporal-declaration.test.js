//@ts-check
/**
 * @file A declared temporal member (`temporals`, MODEL-FORMAT §2): a member
 * holding a calendar value of `@jarenjs/core/calendar` of one kind. The store
 * refuses any other value before the statement (`JD2003`), a CHECK named
 * `<name>_temporal` refuses it from every other writer (`JD2005`), and the
 * member is keyed by its value's one spelling — a generated column for a
 * date, a floating, a utc and a date-range value, a column the store writes
 * for a zoned one (the instant under the declared policy, beside the zone
 * provider's stamp — absent where no provider wrote it, and then never read). A comparison and an ordering of the key answer what the
 * engine answers over the same rows, on SQLite and PostgreSQL alike: natively
 * and exactly for every kind but zoned, whose key narrows the rows the
 * engine decides.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openStore, normalizeModel, planCollection, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { compileJsonQuery } from '@jarenjs/json/query';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { storeTemporals } from '@jarenjs/db/temporals';
import { queryCalendar } from '@jarenjs/json/query/calendar';

import { ENGINES, skipFor, withStore, withPostgres } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

const zoneProvider = createIntlZoneProvider({ revision: 'test-a' });
/** The temporal seam every store here is opened with. */
const temporalSeam = storeTemporals();
const calendar = queryCalendar();
const laterProvider = createIntlZoneProvider({ revision: 'test-b' });
const TEMPORALS = [
  { name: 'd', path: '$.d', kind: 'date' }, { name: 'f', path: '$.f', kind: 'floating' },
  { name: 'u', path: '$.u', kind: 'utc' }, { name: 'z', path: '$.z', kind: 'zoned', policy: 'rfc5545' },
  { name: 'r', path: '$.r', kind: 'date-range' },
];
/** @param {{ temporals?: any[], indexes?: any[], schema?: any }} [options] */
const model = ({ temporals = TEMPORALS, indexes = [{ name: 'by_u', path: '$.u' }, { name: 'by_f', path: '$.f' },
  { name: 'by_z', path: '$.z' }, { name: 'by_r', path: '$.r' }, { name: 'by_d', path: '$.d' }],
schema = { type: 'object', properties: { id: { type: 'string' } } } } = {}) => ({
  $model: '0.1', collections: { ev: { schema, key: '/id', temporals, indexes } } });
const utc = (/** @type {string} */ instant) => ({ kind: 'utc', instant });
const floating = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'floating', date, time });
const zoned = (/** @type {string} */ date, /** @type {string} */ time, /** @type {string} */ zone) => ({ kind: 'zoned', date, time, zone });
const date = (/** @type {string} */ value) => ({ kind: 'date', date: value });
const range = (/** @type {string} */ start, /** @type {string} */ end) => ({ kind: 'date-range', start, end });
/** Every edge a key must order and compare by: the calendar's first and last
 * years, an instant before the epoch, every admitted spelling of one value, a
 * fold where wall order and instant order differ, an absent member. */
const ROWS = [
  { id: 'a', u: utc('0000-01-01T00:00:00Z'), f: floating('0000-01-01', '00:00'), d: date('0000-01-01'), r: range('0000-01-01', '0000-01-02'),
    z: zoned('2026-10-25', '02:30', 'Europe/Amsterdam') },
  { id: 'b', u: utc('9999-12-31T23:59:59.999Z'), f: floating('9999-12-31', '23:59:59.999'), d: date('9999-12-31'), r: range('9999-12-30', '9999-12-31'),
    z: zoned('2026-10-25', '01:50', 'Europe/London') },
  { id: 'c', u: utc('1969-12-31T23:59:59.5Z'), f: floating('2026-07-01', '10:00'), d: date('2026-07-01'), r: range('2026-07-01', '2026-07-15'),
    z: zoned('2026-10-25', '00:40', 'UTC') },
  { id: 'e', u: utc('2026-03-29T12:00:00Z'), f: floating('2026-07-01', '10:00:00.000'), d: date('2026-07-02'), r: range('2026-07-15', '2026-07-20'),
    z: zoned('2026-03-29', '02:30', 'Europe/Amsterdam') },
  { id: 'g', u: utc('2026-03-29T12:00:00.5Z'), f: floating('2026-07-01', '09:59:59.5'), d: date('2026-07-02'), r: range('2026-07-01', '2026-07-02') },
  { id: 'h', u: utc('2026-03-29T12:00:00.000Z'), f: floating('2026-07-01', '09:59:59.45') },
  { id: 'n' },
];
const F = (/** @type {any} */ where, /** @type {any} */ orderby) => ({ $for: { it: '$[*]' },
  ...(where === null ? {} : { $where: where }), ...(orderby === undefined ? {} : { $orderby: [orderby, '$it.id'] }), $return: '$it.id' });
const at = Date.parse;
/** [name, document, exact] — exact: native, no prefilter, no residual. */
const QUERIES = /** @type {[string, any, boolean][]} */ ([
  ['utc ascending', F(null, { $instant: ['$it.u'] }), true],
  ['utc descending', F(null, { $key: { $instant: ['$it.u'] }, $dir: 'desc' }), true],
  ['utc empty greatest', F(null, { $key: { $instant: ['$it.u'] }, $empty: 'greatest' }), true],
  ['utc <', F({ $lt: [{ $instant: ['$it.u'] }, at('2026-03-29T12:00:00.2Z')] }), true],
  ['utc = across spellings', F({ $eq: [{ $instant: ['$it.u'] }, at('2026-03-29T12:00:00Z')] }), true],
  ['utc ≠', F({ $ne: [{ $instant: ['$it.u'] }, at('2026-03-29T12:00:00Z')] }), true],
  ['utc >= a fraction', F({ $ge: [{ $instant: ['$it.u'] }, at('2026-03-29T12:00:00Z') + 0.25] }), true],
  ['utc between', F({ $and: [{ $ge: [{ $instant: ['$it.u'] }, at('1969-12-31T00:00:00Z')] }, { $le: [{ $instant: ['$it.u'] }, at('2026-03-29T12:00:00Z')] }] }), true],
  ['utc past 9999', F({ $lt: [{ $instant: ['$it.u'] }, 9e15] }), true],
  ['utc before 0000', F({ $gt: [{ $instant: ['$it.u'] }, -9e15] }), true],
  ['utc against text', F({ $lt: [{ $instant: ['$it.u'] }, 'x'] }), true],
  ['$epoch of the instant', F({ $le: [{ $epoch: '$it.u.instant' }, at('2026-03-29T12:00:00.5Z')] }, { $epoch: '$it.u.instant' }), true],
  ['wall ascending', F(null, { $wall: '$it.f' }), true],
  ['wall descending', F(null, { $key: { $wall: '$it.f' }, $dir: 'desc' }), true],
  ['wall = across spellings', F({ $eq: [{ $wall: '$it.f' }, '2026-07-01T10:00:00.000'] }), true],
  ['wall <', F({ $lt: [{ $wall: '$it.f' }, '2026-07-01T10:00:00.000'] }), true],
  ['wall ≠', F({ $ne: ['2026-07-01T10:00:00.000', { $wall: '$it.f' }] }), true],
  ['date <', F({ $lt: ['$it.d.date', '2026-07-02'] }), true],
  ['date order', F(null, '$it.d.date'), true],
  ['date-range order', F(null, '$it.r.start'), true],
  ['$overlaps inside', F({ $overlaps: ['$it.r', { $const: { start: '2026-07-14', end: '2026-07-16' } }] }), true],
  ['$overlaps touching an end', F({ $overlaps: ['$it.r', { $const: { start: '2026-07-20', end: '2026-07-21' } }] }), true],
  ['$overlaps touching a start', F({ $overlaps: [{ $const: { start: '2026-06-30', end: '2026-07-01' } }, '$it.r'] }), true],
  ['$overlaps the year 9999', F({ $overlaps: ['$it.r', { $const: { start: '9999-12-30', end: '9999-12-31' } }] }), true],
  ['zoned <', F({ $lt: [{ $instant: ['$it.z', 'rfc5545'] }, at('2026-10-25T00:45:00Z')] }), false],
  ['zoned order (instant, not wall clock)', F(null, { $instant: ['$it.z', 'rfc5545'] }), false],
  ['zoned under another policy', F({ $lt: [{ $instant: ['$it.z', 'later'] }, at('2026-10-25T01:40:00Z')] }), false],
]);
/** The engine's answer as a list. @param {any} doc @param {any[]} rows @param {any} provider */
const engine = (doc, rows, provider = zoneProvider) => [compileJsonQuery(doc, { zoneProvider: provider, calendar })(rows)].flat().filter((x) => x !== undefined);
const list = (/** @type {any} */ answer) => (answer === undefined ? [] : [answer].flat());

describe('a temporal declaration is held to its rules (JD0005, JD0004)', () => {
  /** @param {any} temporals @param {RegExp} message @param {string} [code] */
  const refused = (temporals, message, code = 'JD0005') => assert.throws(() => normalizeModel(model({ temporals, indexes: [] }), undefined, temporalSeam.hooks),
    (/** @type {any} */ e) => e.code === code && message.test(e.message) && typeof e.docPath === 'string');
  it('refuses an unknown kind, a missing or a stray policy, an unknown member', () => {
    refused([{ name: 'a', path: '$.a', kind: 'instant' }], /kind is one of date, floating, utc, zoned, date-range/);
    refused([{ name: 'a', path: '$.a', kind: 'zoned' }], /declares the policy .* got none/);
    refused([{ name: 'a', path: '$.a', kind: 'zoned', policy: 'earlier' }], /one of rfc5545, later, reject/);
    refused([{ name: 'a', path: '$.a', kind: 'utc', policy: 'later' }], /has none to resolve/);
    refused([{ name: 'a', path: '$.a', kind: 'utc', unique: true }], /unique/);
  });
  it('refuses a bad name, a duplicate, an index step, a member declared twice or as an interval span, a non-object type', () => {
    refused([{ name: '1a', path: '$.a', kind: 'utc' }], /identifier name/);
    refused([{ name: 'a', path: '$.a', kind: 'utc' }, { name: 'a', path: '$.b', kind: 'utc' }], /duplicate temporal member name/);
    refused([{ name: 'a', path: '$.a[0]', kind: 'utc' }], /names members alone/);
    refused([{ name: 'a', path: '$.a', kind: 'utc' }, { name: 'b', path: "$['a']", kind: 'date' }], /declared twice/);
    refused([{ name: 'a'.repeat(60), path: '$.a', kind: 'utc' }], /exceeds 63 bytes/);
    assert.throws(() => normalizeModel(model({ temporals: [{ name: 'a', path: '$.a', kind: 'utc' }], indexes: [],
      schema: { type: 'object', properties: { a: { type: 'string' } } } }), undefined, temporalSeam.hooks), /JD0005.*a calendar value is an object/);
  });
  it('refuses a unique index over a zoned member, and a zoned member without a recorded provider', async () => {
    const plan = (/** @type {any} */ doc) => planCollection('ev', normalizeModel(doc, undefined, temporalSeam.hooks).get('ev'), sqliteDialect);
    assert.throws(() => plan(model({ indexes: [{ name: 'one', path: '$.z', unique: true }] })), /JD0004.*takes no unique index/);
    for (const provider of [undefined, createIntlZoneProvider()]) {
      await assert.rejects(openStore(model(), { driver: nodeDriver(), temporals: temporalSeam, ...(provider === undefined ? {} : { zoneProvider: provider }) }),
        (/** @type {any} */ e) => e.code === 'JD0004' && /zoneProvider whose identity records/.test(e.message));
    }
    const without = await openStore(model({ temporals: TEMPORALS.filter((t) => t.kind !== 'zoned'), indexes: [] }), { driver: nodeDriver(), temporals: temporalSeam });
    await without.close();
  });
});

describe('the planned DDL', () => {
  it('keys every kind by one generated column per value, a zoned one by two the store writes', () => {
    const doc = model({ indexes: [{ name: 'by_u', path: '$.u' }, { name: 'by_z', path: '$.z' }, { name: 'by_r', path: '$.r' }, { name: 'by_f', path: '$.f', unique: true }] });
    for (const dialect of [sqliteDialect, postgresDialect()]) {
      const plan = planCollection('ev', normalizeModel(doc, undefined, temporalSeam.hooks).get('ev'), dialect);
      const created = plan.createSql.join(';\n');
      assert.match(created, /"tk_u" (TEXT|text COLLATE "C") GENERATED ALWAYS AS/);
      assert.match(created, /"tk_z" (INTEGER|bigint), "tk_z\$rfc5545" (TEXT|text COLLATE "C")/);
      assert.match(created, /CREATE INDEX "ev_by_z" ON "ev" \("tk_z\$rfc5545", "tk_z"\)/);
      assert.match(created, /CREATE INDEX "ev_by_r" ON "ev" \("tk_r", "tk_r\$end"\)/);
      assert.match(created, /CREATE UNIQUE INDEX "ev_by_f" ON "ev" \("tk_f"\)/);
      for (const name of ['d', 'f', 'u', 'z', 'r']) assert.match(created, new RegExp(`CONSTRAINT "${name}_temporal" CHECK \\(CASE WHEN`));
    }
    const sqlite = planCollection('ev', normalizeModel(doc, undefined, temporalSeam.hooks).get('ev'), sqliteDialect).temporals.find((t) => t.name === 'u').sql;
    assert.equal(sqlite, 'CASE WHEN json_type("doc", \'$."u"\') IS NULL THEN 1 ELSE json_type("doc", \'$."u"\') = \'object\' '
      + 'AND json_extract("doc", \'$."u"."kind"\') IS \'utc\' AND json_remove(json_extract("doc", \'$."u"\'), \'$."kind"\', \'$."instant"\') = \'{}\' '
      + 'AND json_type("doc", \'$."u"."instant"\') IS \'text\' AND (json_extract("doc", \'$."u"."instant"\') GLOB '
      + '\'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z\' OR json_extract("doc", \'$."u"."instant"\') GLOB '
      + '\'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9]Z\' OR json_extract("doc", \'$."u"."instant"\') GLOB '
      + '\'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9]Z\' OR json_extract("doc", \'$."u"."instant"\') GLOB '
      + '\'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z\') END');
    const postgres = planCollection('ev', normalizeModel(doc, undefined, temporalSeam.hooks).get('ev'), postgresDialect()).temporals.find((t) => t.name === 'u').sql;
    assert.equal(postgres, 'CASE WHEN jsonb_typeof(("doc" #> \'{"u"}\')) IS NULL THEN true ELSE jsonb_typeof(("doc" #> \'{"u"}\')) = \'object\' '
      + 'AND (NOT (("doc" #>> \'{"u","kind"}\') IS DISTINCT FROM \'utc\')) AND (((("doc" #> \'{"u"}\') - \'kind\') - \'instant\') = \'{}\'::jsonb) '
      + 'AND (NOT (jsonb_typeof(("doc" #> \'{"u","instant"}\')) IS DISTINCT FROM \'string\')) '
      + 'AND ("doc" #>> \'{"u","instant"}\') ~ \'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?Z$\' END');
  });
});

for (const engineName of ENGINES) {
  describe(`${engineName}: every kind keyed, compared and refused as the engine reads it`, { skip: skipFor(engineName) }, () => {
    it('answers every comparison and ordering as the engine does, natively and exactly but for zoned', async () => {
      await withStore(engineName, model(), async (store) => {
        const ev = store.collection('ev');
        for (const row of ROWS) await ev.put(row);
        for (const [name, doc, exact] of QUERIES) {
          assert.deepEqual(list(await ev.execute(doc)), engine(doc, ROWS), name);
          assert.deepEqual(list(await ev.execute(doc, { pushdown: false })), engine(doc, ROWS), `${name} (residual)`);
          const explained = await ev.explain(doc);
          if (exact) {
            assert.equal(explained.mode, 'native', `${name}: ${JSON.stringify(explained.reasons)}`);
            assert.deepEqual(explained.prefilters, [], name);
            assert.deepEqual(explained.udfs, [], name);
            assert.doesNotMatch(explained.sql, /jaren_p_/, name);
          }
        }
        const narrowed = await ev.explain(QUERIES.find(([name]) => name === 'zoned <')?.[1]);
        assert.deepEqual(narrowed.prefilters.map((/** @type {any} */ p) => p.columns), [['tk_z$rfc5545', 'tk_z']]);
      }, { zoneProvider, temporals: temporalSeam });
    });

    it('holds one key per value: a unique index refuses a second spelling of one wall clock or instant', async () => {
      const doc = model({ indexes: [{ name: 'one_f', path: '$.f', unique: true }, { name: 'one_u', path: '$.u', unique: true }] });
      await withStore(engineName, doc, async (store) => {
        const ev = store.collection('ev');
        await ev.put({ id: 'a', f: floating('2026-07-01', '10:00'), u: utc('2026-01-01T00:00:00Z') });
        await assert.rejects(ev.put({ id: 'b', f: floating('2026-07-01', '10:00:00.000') }), /JD2005/);
        await assert.rejects(ev.put({ id: 'c', u: utc('2026-01-01T00:00:00.00Z') }), /JD2005/);
        await ev.put({ id: 'e', f: floating('2026-07-01', '10:00:00.001'), u: utc('2026-01-01T00:00:00.001Z') });
      }, { zoneProvider, temporals: temporalSeam });
    });

    it('refuses a value that is not its kind before the statement, hook or no hook (JD2003)', async () => {
      await withStore(engineName, model(), async (store) => {
        const ev = store.collection('ev');
        for (const [doc, why] of /** @type {[any, RegExp][]} */ ([
          [{ id: 'x', u: utc('2026-01-01T00:00:00.1234Z') }, /JY0010/],
          [{ id: 'x', u: utc('2016-12-31T23:59:60Z') }, /JY0009/],
          [{ id: 'x', f: floating('2026-07-01', '24:00') }, /JY0008/],
          [{ id: 'x', f: floating('2026-07-01', '10:00Z') }, /JY0011/],
          [{ id: 'x', d: date('2026-02-30') }, /JY0012/],
          [{ id: 'x', d: utc('2026-01-01T00:00:00Z') }, /is a utc value, and the member is declared date/],
          [{ id: 'x', r: range('2026-07-02', '2026-07-01') }, /not a calendar value/],
          [{ id: 'x', u: { ...utc('2026-01-01T00:00:00Z'), note: 1 } }, /not a calendar value/],
          [{ id: 'x', u: '2026-01-01T00:00:00Z' }, /not a calendar value/],
          [{ id: 'x', u: null }, /not a calendar value/],
          [{ id: 'x', z: zoned('2026-07-01', '10:00', 'Nowhere/City') }, /resolves to no instant under 'rfc5545' \(JY0001/],
        ])) await assert.rejects(ev.put(doc), (/** @type {any} */ e) => e.code === 'JD2003' && why.test(e.message), JSON.stringify(doc));
        assert.equal(await ev.get('x'), undefined);
        await ev.put({ id: 'p', u: utc('2026-01-01T00:00:00Z') });
        await assert.rejects(ev.patch('p', [{ op: 'replace', path: '/u/instant', value: '2026-01-01' }]), /JD2003/);
      }, { zoneProvider, temporals: temporalSeam });
    });
  });
}

describe('the CHECK refuses every other writer, on SQLite', () => {
  it('a raw INSERT of a value of another kind, an extra member, a key the store did not write', async () => {
    const { dbPath: path, cleanup } = tempDbPath();
    const store = await openStore(model(), { driver: nodeDriver(), temporals: temporalSeam, path, zoneProvider });
    await store.collection('ev').put({ id: 'ok', z: zoned('2026-07-01', '10:00', 'Europe/Amsterdam') });
    await store.close();
    const raw = new DatabaseSync(path);
    try {
      const insert = (/** @type {any} */ doc, /** @type {any[]} */ keys = [null, null]) =>
        raw.prepare('INSERT INTO "ev" ("key", "doc", "tk_z", "tk_z$rfc5545") VALUES (?, jsonb(?), ?, ?)').run(doc.id, JSON.stringify(doc), ...keys);
      for (const doc of [{ id: '1', d: utc('2026-01-01T00:00:00Z') }, { id: '2', u: { ...utc('2026-01-01T00:00:00Z'), x: 1 } },
        { id: '3', f: floating('2026-07-01', '10:00:00.0001') }, { id: '4', r: range('2026-07-01', '2026-07-01') }, { id: '5', u: { kind: 'utc', instant: 5 } }])
        assert.throws(() => insert(doc), /CHECK constraint failed: \w_temporal/, JSON.stringify(doc));
      // a key no store wrote is no key: the row is read as another provider's
      insert({ id: '6', z: zoned('2026-07-01', '10:00', 'UTC') });
      assert.throws(() => insert({ id: '7' }, [5, '[]']), /z_temporal/);
      assert.throws(() => insert({ id: '9', z: zoned('2026-07-01', '10:00', 'UTC') }, [253402300800000, '[]']), /z_temporal/);
      insert({ id: '8', z: zoned('2026-07-01', '10:00', 'UTC') }, [Date.parse('2026-07-01T10:00:00Z'), '["x","y"]']);
    }
    finally { raw.close(); cleanup(); }
  });
});

describe('the CHECK refuses every other writer, on PostgreSQL', { skip: skipFor('postgres') }, () => {
  it('a raw INSERT of a value of another kind or a key the store did not write; a dropped CHECK is drift', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(model(), { driver: driver(), temporals: temporalSeam, zoneProvider });
      await store.close();
      const insert = (/** @type {any} */ doc, /** @type {any[]} */ keys = [null, null]) =>
        pool.query(`INSERT INTO "${schema}"."ev" ("key", "doc", "tk_z", "tk_z$rfc5545") VALUES ($1, $2, $3, $4)`, [doc.id, JSON.stringify(doc), ...keys]);
      for (const doc of [{ id: '1', d: utc('2026-01-01T00:00:00Z') }, { id: '2', u: { ...utc('2026-01-01T00:00:00Z'), x: 1 } },
        { id: '3', f: floating('2026-07-01', '10:00:00.0001') }, { id: '4', r: range('2026-07-01', '2026-07-01') }, { id: '5', u: { kind: 'utc', instant: 5 } }])
        await assert.rejects(insert(doc), (/** @type {any} */ e) => e.code === '23514' && /_temporal/.test(e.message), JSON.stringify(doc));
      await insert({ id: '6', z: zoned('2026-07-01', '10:00', 'UTC') });
      await assert.rejects(insert({ id: '7' }, [5, '[]']), /z_temporal/);
      await assert.rejects(insert({ id: '9', z: zoned('2026-07-01', '10:00', 'UTC') }, [253402300800000, '[]']), /z_temporal/);
      await insert({ id: '8', z: zoned('2026-07-01', '10:00', 'UTC') }, [Date.parse('2026-07-01T10:00:00Z'), '["x","y"]']);
      await pool.query(`ALTER TABLE "${schema}"."ev" DROP CONSTRAINT "u_temporal"`);
      await assert.rejects(openStore(model(), { driver: driver(), temporals: temporalSeam, zoneProvider }),
        (/** @type {any} */ e) => e.code === 'JD0002' && /u_temporal/.test(e.message));
      await pool.query(`ALTER TABLE "${schema}"."ev" ADD CONSTRAINT "u_temporal" CHECK (true)`);
      await assert.rejects(openStore(model(), { driver: driver(), temporals: temporalSeam, zoneProvider }),
        (/** @type {any} */ e) => e.code === 'JD0002' && /CHECK 'u_temporal' is declared as/.test(e.message));
    });
  });
});

for (const engineName of ENGINES) {
  describe(`${engineName}: a zoned key another provider stamped is never read as the store's own`, { skip: skipFor(engineName) }, () => {
    it('keeps every row another revision keyed a candidate, in the one statement that reads the key', async () => {
      // a key another provider wrote is no key of this one: rows the second
      // store writes while the first reads are each decided by the engine
      const doc = model({ temporals: [TEMPORALS[3]], indexes: [{ name: 'by_z', path: '$.z' }] });
      const query = F({ $lt: [{ $instant: ['$it.z', 'rfc5545'] }, Date.parse('2026-10-25T00:45:00Z')] });
      const rows = [{ id: 'a', z: zoned('2026-10-25', '02:30', 'Europe/Amsterdam') }, { id: 'b', z: zoned('2026-10-25', '01:50', 'Europe/London') },
        { id: 'c', z: zoned('2026-10-25', '00:40', 'UTC') }];
      const check = async (/** @type {any} */ first, /** @type {any} */ second) => {
        const held = [];
        for (const row of rows) {
          await second.collection('ev').put(row);
          held.push(row);
          assert.deepEqual(list(await first.collection('ev').execute(query)), engine(query, held));
        }
        // a store that stamped none of the rows itself still reads none of their keys as its own
        const explained = await first.collection('ev').explain(query);
        assert.match(explained.sql, /NOT \("tk_z\$rfc5545" IS NOT NULL AND "tk_z\$rfc5545" = /);
      };
      if (engineName === 'sqlite') {
        const { dbPath: path, cleanup } = tempDbPath();
        const first = await openStore(doc, { driver: nodeDriver(), temporals: temporalSeam, path, zoneProvider });
        const second = await openStore(doc, { driver: nodeDriver(), temporals: temporalSeam, path, zoneProvider: laterProvider });
        try { await check(first, second); }
        finally { await second.close(); await first.close(); }
        const raw = new DatabaseSync(path);
        try { assert.deepEqual(raw.prepare('SELECT DISTINCT "tk_z$rfc5545" AS s FROM "ev"').all().map((r) => r.s), ['["intl","test-b"]']); }
        finally { raw.close(); cleanup(); }
      }
      else {
        await withPostgres(async ({ driver }) => {
          const first = await openStore(doc, { driver: driver(), temporals: temporalSeam, zoneProvider });
          const second = await openStore(doc, { driver: driver(), temporals: temporalSeam, zoneProvider: laterProvider });
          try { await check(first, second); }
          finally { await second.close(); await first.close(); }
        });
      }
    });
  });
}

for (const engineName of ENGINES) {
  describe(`${engineName}: rekey()`, { skip: skipFor(engineName) }, () => {
    it('keys every row another provider keyed under the store\'s own, and narrows the fetch to them', async () => {
      const doc = model({ temporals: [TEMPORALS[3]], indexes: [{ name: 'by_z', path: '$.z' }] });
      const rows = [{ id: 'a', z: zoned('2026-10-25', '02:30', 'Europe/Amsterdam') }, { id: 'b', z: zoned('2026-10-25', '01:50', 'Europe/London') }, { id: 'n' }];
      const query = F({ $lt: [{ $instant: ['$it.z', 'rfc5545'] }, Date.parse('2026-10-25T00:45:00Z')] });
      const run = async (/** @type {any} */ older, /** @type {any} */ current) => {
        for (const row of rows) await older.collection('ev').put(row);
        assert.equal(await older.collection('ev').rekey(), 0);
        assert.equal(await current.collection('ev').rekey(), 2);
        assert.equal(await current.collection('ev').rekey(), 0);
        assert.deepEqual(list(await current.collection('ev').execute(query)), engine(query, rows, laterProvider));
        assert.deepEqual(await current.collection('ev').get('a'), rows[0]);
      };
      if (engineName === 'sqlite') {
        const { dbPath: path, cleanup } = tempDbPath();
        const older = await openStore(doc, { driver: nodeDriver(), temporals: temporalSeam, path, zoneProvider });
        const current = await openStore(doc, { driver: nodeDriver(), temporals: temporalSeam, path, zoneProvider: laterProvider });
        try { await run(older, current); }
        finally { await current.close(); await older.close(); }
        const raw = new DatabaseSync(path);
        try { assert.deepEqual(raw.prepare('SELECT "key", "tk_z$rfc5545" AS s FROM "ev" ORDER BY "key"').all().map((r) => [r.key, r.s]),
          [['a', '["intl","test-b"]'], ['b', '["intl","test-b"]'], ['n', null]]); }
        finally { raw.close(); cleanup(); }
      }
      else {
        await withPostgres(async ({ driver }) => {
          const older = await openStore(doc, { driver: driver(), temporals: temporalSeam, zoneProvider });
          const current = await openStore(doc, { driver: driver(), temporals: temporalSeam, zoneProvider: laterProvider });
          try { await run(older, current); }
          finally { await current.close(); await older.close(); }
        });
      }
    });

    it('keys nothing on a collection that declares no zoned member', async () => {
      await withStore(engineName, model({ temporals: [TEMPORALS[2]], indexes: [] }), async (store) => {
        await store.collection('ev').put({ id: 'a', u: utc('2026-01-01T00:00:00Z') });
        assert.equal(await store.collection('ev').rekey(), 0);
      }, { temporals: temporalSeam });
    });
  });
}

describe('rekey() on the synchronous surface', () => {
  it('answers its count synchronously over a synchronous driver', async () => {
    const doc = model({ temporals: [TEMPORALS[3]], indexes: [] });
    const { dbPath: path, cleanup } = tempDbPath();
    try {
      const older = await openStore(doc, { driver: nodeDriver(), temporals: temporalSeam, path, zoneProvider });
      older.sync.collection('ev').put({ id: 'a', z: zoned('2026-10-25', '02:30', 'Europe/Amsterdam') });
      await older.close();
      const current = await openStore(doc, { driver: nodeDriver(), temporals: temporalSeam, path, zoneProvider: laterProvider });
      try {
        assert.equal(current.sync.collection('ev').rekey(), 1);
        assert.equal(current.sync.collection('ev').rekey(), 0);
      }
      finally { await current.close(); }
    }
    finally { cleanup(); }
  });
});
