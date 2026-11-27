//@ts-check
/**
 * @file A calendar kind on an entity member (`x-entity: { temporal: { kind,
 * policy? } }`, MODEL-FORMAT §9.3): the value stays in the entity's document,
 * and the table keys it exactly as a collection's declared temporal member is
 * keyed — the same generated key columns, the same CHECK, the same refusals —
 * through the same seam (`@jarenjs/db/temporals`). Every comparison and
 * ordering answers what the same data answers through a collection and
 * through the engine, on SQLite and PostgreSQL alike.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openStore, normalizeModel, normalizeEntities, explainMapping, planCollection, planEntity, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { compileJsonQuery } from '@jarenjs/json/query';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { storeTemporals } from '@jarenjs/db/temporals';
import { queryCalendar } from '@jarenjs/json/query/calendar';

import { ENGINES, skipFor, withStore, withPostgres } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

const zoneProvider = createIntlZoneProvider({ revision: 'test-a' });
const laterProvider = createIntlZoneProvider({ revision: 'test-b' });
const temporalSeam = storeTemporals();
const calendar = queryCalendar();
const KINDS = /** @type {const} */ ([['d', 'date'], ['f', 'floating'], ['u', 'utc'], ['z', 'zoned', 'rfc5545'], ['r', 'date-range']]);

/** A property declared a calendar kind. @param {string} kind @param {string} [policy] @param {any} [flags] */
const temporal = (kind, policy = undefined, flags = {}) => ({ type: 'object',
  'x-entity': { temporal: { kind, ...(policy === undefined ? {} : { policy }) }, ...flags } });
/** The entity model, each member indexed (`index: true`) unless `flags` says otherwise. @param {Record<string, any>} [flags] */
const entityModel = (flags = {}) => ({ $model: '0.1', entities: { Ev: { schema: { type: 'object', properties: {
  id: { type: 'string', 'x-entity': { key: true } },
  ...Object.fromEntries(KINDS.map(([name, kind, policy]) => [name, temporal(kind, policy, flags[name] ?? { index: true })])),
} } } } });
/** The same members declared on a collection. */
const collectionModel = { $model: '0.1', collections: { evc: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id',
  temporals: KINDS.map(([name, kind, policy]) => ({ name, path: `$.${name}`, kind, ...(policy === undefined ? {} : { policy }) })),
  indexes: KINDS.map(([name]) => ({ name: `by_${name}`, path: `$.${name}` })) } } };

const utc = (/** @type {string} */ instant) => ({ kind: 'utc', instant });
const floating = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'floating', date, time });
const zoned = (/** @type {string} */ date, /** @type {string} */ time, /** @type {string} */ zone) => ({ kind: 'zoned', date, time, zone });
const date = (/** @type {string} */ value) => ({ kind: 'date', date: value });
const range = (/** @type {string} */ start, /** @type {string} */ end) => ({ kind: 'date-range', start, end });
/** The edges a collection's declared members are probed at: the calendar's first and last years, an
 * instant before the epoch, every admitted spelling of one value, a fold
 * where wall order and instant order differ, an absent member. */
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
/** A query over `over`. @param {string} over @param {any} where @param {any} [orderby] */
const query = (over, where, orderby = undefined) => ({ $for: { it: over },
  ...(where === null ? {} : { $where: where }), ...(orderby === undefined ? {} : { $orderby: [orderby, '$it.id'] }), $return: '$it.id' });
const at = Date.parse;
/** [name, where, orderby, exact] — exact: native on the entity, nothing left to the engine. */
const PROBES = /** @type {[string, any, any, boolean][]} */ ([
  ['utc ascending', null, { $instant: ['$it.u'] }, true],
  ['utc descending', null, { $key: { $instant: ['$it.u'] }, $dir: 'desc' }, true],
  ['utc empty greatest', null, { $key: { $instant: ['$it.u'] }, $empty: 'greatest' }, true],
  ['utc <', { $lt: [{ $instant: ['$it.u'] }, at('2026-03-29T12:00:00.2Z')] }, undefined, true],
  ['utc = across spellings', { $eq: [{ $instant: ['$it.u'] }, at('2026-03-29T12:00:00Z')] }, undefined, true],
  ['utc ≠', { $ne: [{ $instant: ['$it.u'] }, at('2026-03-29T12:00:00Z')] }, undefined, true],
  ['utc >= a fraction', { $ge: [{ $instant: ['$it.u'] }, at('2026-03-29T12:00:00Z') + 0.25] }, undefined, true],
  ['utc between', { $and: [{ $ge: [{ $instant: ['$it.u'] }, at('1969-12-31T00:00:00Z')] }, { $le: [{ $instant: ['$it.u'] }, at('2026-03-29T12:00:00Z')] }] }, undefined, true],
  ['utc past 9999', { $lt: [{ $instant: ['$it.u'] }, 9e15] }, undefined, true],
  ['utc before 0000', { $gt: [{ $instant: ['$it.u'] }, -9e15] }, undefined, true],
  ['utc against text', { $lt: [{ $instant: ['$it.u'] }, 'x'] }, undefined, true],
  ['$epoch of the instant', { $le: [{ $epoch: '$it.u.instant' }, at('2026-03-29T12:00:00.5Z')] }, { $epoch: '$it.u.instant' }, true],
  ['wall ascending', null, { $wall: '$it.f' }, true],
  ['wall descending', null, { $key: { $wall: '$it.f' }, $dir: 'desc' }, true],
  ['wall = across spellings', { $eq: [{ $wall: '$it.f' }, '2026-07-01T10:00:00.000'] }, undefined, true],
  ['wall <', { $lt: [{ $wall: '$it.f' }, '2026-07-01T10:00:00.000'] }, undefined, true],
  ['wall ≠', { $ne: ['2026-07-01T10:00:00.000', { $wall: '$it.f' }] }, undefined, true],
  ['date <', { $lt: ['$it.d.date', '2026-07-02'] }, undefined, true],
  ['date order', null, '$it.d.date', true],
  ['date-range order', null, '$it.r.start', true],
  ['date-range end between', { $and: [{ $gt: ['$it.r.end', '2026-07-01'] }, { $le: ['$it.r.end', '2026-07-20'] }] }, undefined, true],
  ['$overlaps inside', { $overlaps: ['$it.r', { $const: { start: '2026-07-14', end: '2026-07-16' } }] }, undefined, true],
  ['$overlaps touching an end', { $overlaps: ['$it.r', { $const: { start: '2026-07-20', end: '2026-07-21' } }] }, undefined, true],
  ['$overlaps touching a start', { $overlaps: [{ $const: { start: '2026-06-30', end: '2026-07-01' } }, '$it.r'] }, undefined, true],
  ['$overlaps the year 9999', { $overlaps: ['$it.r', { $const: { start: '9999-12-30', end: '9999-12-31' } }] }, undefined, true],
  ['zoned <', { $lt: [{ $instant: ['$it.z', 'rfc5545'] }, at('2026-10-25T00:45:00Z')] }, undefined, false],
  ['zoned order (instant, not wall clock)', null, { $instant: ['$it.z', 'rfc5545'] }, false],
  ['zoned under another policy', { $lt: [{ $instant: ['$it.z', 'later'] }, at('2026-10-25T01:40:00Z')] }, undefined, false],
]);
/** The engine's answer as a list. @param {any} doc @param {any} data @param {any} [provider] */
const engine = (doc, data, provider = zoneProvider) => [compileJsonQuery(doc, { zoneProvider: provider, calendar })(data)].flat().filter((x) => x !== undefined);
const list = (/** @type {any} */ answer) => (answer === undefined ? [] : [answer].flat());
/** The planned entity table. @param {any} doc @param {any} dialect */
const entityPlan = (doc, dialect) => {
  const mapping = explainMapping(doc, { temporals: temporalSeam });
  return planEntity('Ev', mapping.entities.Ev, mapping, dialect, { temporalHooks: temporalSeam.hooks });
};

describe('an entity temporal member is held to the collection\'s rules', () => {
  /** @param {any} property @param {RegExp} message @param {string} [code] @param {any} [extra] */
  const refused = (property, message, code = 'JD0005', extra = {}) => assert.throws(() => normalizeEntities({ $model: '0.1', entities: { Ev: {
    ...extra, schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, a: property } } } } }, { temporals: temporalSeam }),
  (/** @type {any} */ e) => e.code === code && message.test(e.message) && typeof e.docPath === 'string' && e.docPath.startsWith('/entities/Ev'),
  JSON.stringify(property));
  it('refuses an unknown kind, a missing or a stray policy, an unknown member, a non-object type', () => {
    refused(temporal('instant'), /kind is one of date, floating, utc, zoned, date-range/);
    refused(temporal('zoned'), /declares the policy .* got none/);
    refused(temporal('zoned', 'earlier'), /one of rfc5545, later, reject/);
    refused(temporal('utc', 'later'), /has none to resolve/);
    refused({ type: 'object', 'x-entity': { temporal: { kind: 'utc', path: '$.a' } } }, /path/);
    refused({ type: 'object', 'x-entity': { temporal: 'utc' } }, /x-entity.temporal is an object/);
    refused({ type: 'string', 'x-entity': { temporal: { kind: 'utc' } } }, /a calendar value is an object/);
  });
  it('refuses a key, a column mapping or a relation beside it, and an adopted layout (JD0004)', () => {
    refused(temporal('utc', undefined, { column: 'json' }), /takes no column beside it/);
    refused(temporal('utc', undefined, { key: true }), /takes no key beside it/);
    refused(temporal('utc'), /adopted layout \(physical\) has no document column/, 'JD0004',
      { physical: { table: 'ev', columns: { id: { name: 'id', codec: 'text', null: 'reject' }, a: { name: 'a', codec: 'json', null: 'null' } } } });
  });
  it('refuses a model declaring one without the seam (JD0017), at the member', () => {
    const doc = entityModel();
    for (const read of [() => normalizeEntities(doc), () => explainMapping(doc)])
      assert.throws(read, (/** @type {any} */ e) => e.code === 'JD0017' && e.docPath === '/entities/Ev/schema/properties/d/x-entity/temporal');
    const mapping = explainMapping(doc, { temporals: temporalSeam });
    assert.throws(() => planEntity('Ev', mapping.entities.Ev, mapping, sqliteDialect), /JD0017/);
  });
  it('refuses a unique zoned member and a key column another member names (JD0004)', () => {
    assert.throws(() => entityPlan(entityModel({ z: { unique: true } }), sqliteDialect), /JD0004.*takes no unique index/);
    const doc = entityModel();
    doc.entities.Ev.schema.properties.tk_u = { type: 'string' };
    assert.throws(() => entityPlan(doc, sqliteDialect), (/** @type {any} */ e) => e.code === 'JD0004' && /'tk_u'/.test(e.message));
  });
  it('names the member, its place and the remedy in each refusal the table plan and the layout make', () => {
    /** @param {string} code @param {string} docPath @param {string} reason */
    const exactly = (code, docPath, reason) => (/** @type {any} */ e) => {
      assert.deepEqual({ code: e.code, docPath: e.docPath, message: e.message }, { code, docPath, message: `${code}: ${reason} at ${docPath}` });
      return true;
    };
    /** @param {string} entity @param {Record<string, any>} properties */
    const plan = (entity, properties) => {
      const mapping = explainMapping({ $model: '0.1', entities: { [entity]: { schema: { type: 'object', properties: {
        id: { type: 'string', 'x-entity': { key: true } }, ...properties } } } } }, { temporals: temporalSeam });
      return planEntity(entity, mapping.entities[entity], mapping, postgresDialect(), { temporalHooks: temporalSeam.hooks });
    };
    assert.throws(() => plan('Ev', { u: temporal('utc'), tk_u: { type: 'string' } }), exactly('JD0004', '/entities/Ev/schema/properties/u',
      "the key column of the temporal member 'u' would be named 'tk_u', the name of the column for 'tk_u' — two columns of one table "
      + 'cannot share a name: rename the member'));
    const long = 'm'.repeat(54);
    assert.throws(() => plan('EventsLog', { [long]: temporal('date', undefined, { index: true }) }), exactly('JD0004',
      `/entities/EventsLog/schema/properties/${long}`, `the index over '${long}' would be named 'EventsLog_${long}', 64 bytes; the postgres `
      + 'engine keeps 63 bytes of an identifier and truncates a longer one silently, so two names that share a prefix would be one — shorten the name'));
    assert.throws(() => normalizeEntities({ $model: '0.1', entities: { Ev: {
      physical: { table: 'ev', columns: { id: { name: 'id', codec: 'text', null: 'reject' }, a: { name: 'a', codec: 'json', null: 'null' } } },
      schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, a: temporal('utc') } } } } }, { temporals: temporalSeam }),
    exactly('JD0004', '/entities/Ev/schema/properties/a/x-entity/temporal', "'a' declares a calendar kind, keyed by columns generated from the "
      + "entity's document, and an adopted layout (physical) has no document column: keep the value in the columns the application declares, "
      + 'or declare the entity without physical'));
  });
});

describe('the planned DDL is the collection\'s', () => {
  it('keys every kind by the same columns and holds it by the same CHECK, on both engines', () => {
    const doc = entityModel({ f: { unique: true } });
    for (const dialect of [sqliteDialect, postgresDialect()]) {
      const plan = entityPlan(doc, dialect);
      const created = plan.createSql.join(';\n');
      assert.match(created, /"tk_u" (TEXT|text COLLATE "C") GENERATED ALWAYS AS/);
      assert.match(created, /"tk_z" (INTEGER|bigint), "tk_z\$rfc5545" (TEXT|text COLLATE "C")/);
      assert.match(created, /CREATE INDEX "Ev_z" ON "Ev" \("tk_z\$rfc5545", "tk_z"\)/);
      assert.match(created, /CREATE INDEX "Ev_r" ON "Ev" \("tk_r", "tk_r\$end"\)/);
      assert.match(created, /CREATE UNIQUE INDEX "Ev_f" ON "Ev" \("tk_f"\)/);
      const collection = planCollection('evc', normalizeModel(collectionModel, undefined, temporalSeam.hooks).get('evc'), dialect);
      for (const [name] of KINDS) {
        const mine = plan.temporals.find((/** @type {any} */ t) => t.name === name);
        const theirs = collection.temporals.find((/** @type {any} */ t) => t.name === name);
        assert.equal(mine.sql, theirs.sql, `${dialect.name} ${name}`);
        assert.match(created, new RegExp(`CONSTRAINT "${name}_temporal" CHECK \\(CASE WHEN`));
      }
      const generated = (/** @type {any} */ p) => p.generated.map((/** @type {any} */ g) => [g.name, g.type, g.expression ?? null, g.stored === true]);
      assert.deepEqual(generated(plan), generated(collection), dialect.name);
    }
  });
  it('plans a model without a temporal member as it did', () => {
    const doc = { $model: '0.1', entities: { Ev: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
      at: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer', index: true } }, note: { type: 'object' } } } } } };
    for (const dialect of [sqliteDialect, postgresDialect()]) {
      const mapping = explainMapping(doc);
      assert.equal('temporals' in mapping.entities.Ev, false);
      const plan = planEntity('Ev', mapping.entities.Ev, mapping, dialect);
      assert.equal('temporals' in plan, false);
      assert.doesNotMatch(plan.createSql[0], /GENERATED|CONSTRAINT/);
    }
  });
});

for (const engineName of ENGINES) {
  describe(`${engineName}: an entity member answers as a collection's and as the engine`, { skip: skipFor(engineName) }, () => {
    it('answers every probe through the entity, the collection and the engine alike, natively but for zoned', async () => {
      const both = { ...entityModel(), collections: collectionModel.collections };
      await withStore(engineName, both, async (store) => {
        const ev = store.entity('Ev');
        for (const row of ROWS) await ev.create(row);
        for (const row of ROWS) await store.collection('evc').put(row);
        for (const [name, where, orderby, exact] of PROBES) {
          const entityQuery = query('$.Ev[*]', where, orderby);
          const expected = engine(entityQuery, { Ev: ROWS });
          assert.deepEqual(list(await ev.execute(entityQuery)), expected, name);
          assert.deepEqual(list(await ev.execute(entityQuery, { pushdown: false })), expected, `${name} (pushdown off)`);
          assert.deepEqual(list(await store.collection('evc').execute(query('$[*]', where, orderby))), expected, `${name} (collection)`);
          const explained = await ev.explain(entityQuery);
          if (exact) assert.equal(explained.mode, 'native', `${name}: ${JSON.stringify(explained.reasons)}`);
          else assert.notEqual(explained.mode, 'native', name);
          // a date's and a date range's members are read from their key columns, which their indexes cover
          if (/^date/.test(name)) assert.match(explained.sql, /"tk_[dr](\$end)?"/, name);
        }
        assert.deepEqual(await ev.get('h'), ROWS[5]);
      }, { zoneProvider, temporals: temporalSeam });
    });

    it('holds one key per value: a unique member refuses a second spelling of one wall clock or instant (JD2005)', async () => {
      await withStore(engineName, entityModel({ f: { unique: true }, u: { unique: true } }), async (store) => {
        const ev = store.entity('Ev');
        await ev.create({ id: 'a', f: floating('2026-07-01', '10:00'), u: utc('2026-01-01T00:00:00Z') });
        await assert.rejects(ev.create({ id: 'b', f: floating('2026-07-01', '10:00:00.000') }), /JD2005/);
        await assert.rejects(ev.create({ id: 'c', u: utc('2026-01-01T00:00:00.00Z') }), /JD2005/);
        await ev.create({ id: 'e', f: floating('2026-07-01', '10:00:00.001'), u: utc('2026-01-01T00:00:00.001Z') });
        await assert.rejects(ev.update('e', { u: utc('2026-01-01T00:00:00.000Z') }), /JD2005/);
      }, { zoneProvider, temporals: temporalSeam });
    });

    it('refuses a value that is not its kind before the statement, on every write path (JD2003)', async () => {
      await withStore(engineName, entityModel(), async (store) => {
        const ev = store.entity('Ev');
        const faults = /** @type {[any, RegExp][]} */ ([
          [{ id: 'x', u: utc('2026-01-01T00:00:00.1234Z') }, /JY0010/],
          [{ id: 'x', u: utc('2016-12-31T23:59:60Z') }, /JY0009/],
          [{ id: 'x', f: floating('2026-07-01', '24:00') }, /JY0008/],
          [{ id: 'x', f: floating('2026-07-01', '10:00Z') }, /JY0011/],
          [{ id: 'x', d: date('2026-02-30') }, /JY0012/],
          [{ id: 'x', d: utc('2026-01-01T00:00:00Z') }, /is a utc value, and the member is declared date/],
          [{ id: 'x', r: range('2026-07-02', '2026-07-01') }, /not a calendar value/],
          [{ id: 'x', u: { ...utc('2026-01-01T00:00:00Z'), note: 1 } }, /not a calendar value/],
          [{ id: 'x', u: null }, /not a calendar value/],
          [{ id: 'x', z: zoned('2026-07-01', '10:00', 'Nowhere/City') }, /resolves to no instant under 'rfc5545' \(JY0001/],
        ]);
        const refused = (/** @type {RegExp} */ why) => (/** @type {any} */ e) => e.code === 'JD2003' && /entity 'Ev' rejected the document/.test(e.message) && why.test(e.message);
        for (const [doc, why] of faults) await assert.rejects(ev.create(doc), refused(why), JSON.stringify(doc));
        assert.equal(await ev.get('x'), undefined);
        await ev.create({ id: 'p', u: utc('2026-01-01T00:00:00Z') });
        for (const [doc, why] of faults) {
          const { id: _id, ...change } = doc;
          await assert.rejects(ev.update('p', change), refused(why), JSON.stringify(doc));
          const current = await ev.get('p');
          assert.throws(() => ev.put({ ...current, ...change }), refused(why), `put ${JSON.stringify(doc)}`);
        }
        assert.deepEqual(await ev.get('p'), { id: 'p', u: utc('2026-01-01T00:00:00Z') });
      }, { zoneProvider, temporals: temporalSeam });
    });
  });
}

describe('the CHECK refuses every other writer, on SQLite', () => {
  it('a raw INSERT of a value of another kind, an extra member, a key the store did not write', async () => {
    const { dbPath: path, cleanup } = tempDbPath();
    const store = await openStore(entityModel(), { driver: nodeDriver(), temporals: temporalSeam, path, zoneProvider });
    await store.entity('Ev').create({ id: 'ok', z: zoned('2026-07-01', '10:00', 'Europe/Amsterdam') });
    await store.close();
    const raw = new DatabaseSync(path);
    try {
      const insert = (/** @type {any} */ doc, /** @type {any[]} */ keys = [null, null]) =>
        raw.prepare('INSERT INTO "Ev" ("id", "doc", "tk_z", "tk_z$rfc5545") VALUES (?, jsonb(?), ?, ?)').run(doc.id, JSON.stringify(doc), ...keys);
      for (const doc of [{ id: '1', d: utc('2026-01-01T00:00:00Z') }, { id: '2', u: { ...utc('2026-01-01T00:00:00Z'), x: 1 } },
        { id: '3', f: floating('2026-07-01', '10:00:00.0001') }, { id: '4', r: range('2026-07-01', '2026-07-01') }, { id: '5', u: { kind: 'utc', instant: 5 } }])
        assert.throws(() => insert(doc), /CHECK constraint failed: \w_temporal/, JSON.stringify(doc));
      insert({ id: '6', z: zoned('2026-07-01', '10:00', 'UTC') });
      assert.throws(() => insert({ id: '7' }, [5, '[]']), /z_temporal/);
      assert.throws(() => insert({ id: '9', z: zoned('2026-07-01', '10:00', 'UTC') }, [253402300800000, '[]']), /z_temporal/);
    }
    finally { raw.close(); cleanup(); }
  });
});

describe('the CHECK refuses every other writer, on PostgreSQL', { skip: skipFor('postgres') }, () => {
  it('a raw INSERT of a value of another kind or a key the store did not write; a dropped or altered CHECK is drift', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      // an enum column's CHECK beside the members' is the table's own
      const doc = entityModel();
      doc.entities.Ev.schema.properties.state = { type: 'string', enum: ['open', 'shut'] };
      const store = await openStore(doc, { driver: driver(), temporals: temporalSeam, zoneProvider });
      await store.close();
      const insert = (/** @type {any} */ row, /** @type {any[]} */ keys = [null, null]) =>
        pool.query(`INSERT INTO "${schema}"."Ev" ("id", "doc", "tk_z", "tk_z$rfc5545") VALUES ($1, $2, $3, $4)`, [row.id, JSON.stringify(row), ...keys]);
      for (const row of [{ id: '1', d: utc('2026-01-01T00:00:00Z') }, { id: '2', u: { ...utc('2026-01-01T00:00:00Z'), x: 1 } },
        { id: '3', f: floating('2026-07-01', '10:00:00.0001') }, { id: '4', r: range('2026-07-01', '2026-07-01') }, { id: '5', u: { kind: 'utc', instant: 5 } }])
        await assert.rejects(insert(row), (/** @type {any} */ e) => e.code === '23514' && /_temporal/.test(e.message), JSON.stringify(row));
      await insert({ id: '6', z: zoned('2026-07-01', '10:00', 'UTC') });
      await assert.rejects(insert({ id: '7' }, [5, '[]']), /z_temporal/);
      await pool.query(`ALTER TABLE "${schema}"."Ev" DROP CONSTRAINT "u_temporal"`);
      await assert.rejects(openStore(doc, { driver: driver(), temporals: temporalSeam, zoneProvider }),
        (/** @type {any} */ e) => e.code === 'JD0002' && /u_temporal/.test(e.message));
      await pool.query(`ALTER TABLE "${schema}"."Ev" ADD CONSTRAINT "u_temporal" CHECK (true)`);
      await assert.rejects(openStore(doc, { driver: driver(), temporals: temporalSeam, zoneProvider }),
        (/** @type {any} */ e) => e.code === 'JD0002' && /CHECK 'u_temporal' is declared as/.test(e.message));
    });
  });
});

for (const engineName of ENGINES) {
  describe(`${engineName}: every write of a zoned member keys it under the writing store's provider`, { skip: skipFor(engineName) }, () => {
    it('create, update, a tracked save of the member and a tracked save of another member each write the key they owe', async () => {
      const doc = entityModel();
      const amsterdam = zoned('2026-10-25', '02:30', 'Europe/Amsterdam');
      const run = async (/** @type {any} */ older, /** @type {any} */ current, /** @type {(sql: string) => Promise<any[]>} */ read) => {
        const keys = async () => Object.fromEntries((await read('SELECT "id", "tk_z" AS k, "tk_z$rfc5545" AS s FROM "Ev" ORDER BY "id"'))
          .map((row) => [row.id, [row.k === null ? null : Number(row.k), row.s]]));
        const a = '["intl","test-a"]', b = '["intl","test-b"]';
        for (const id of ['p', 'q', 'r', 's']) await older.entity('Ev').create({ id, z: amsterdam, u: utc('2026-01-01T00:00:00Z') });
        await older.entity('Ev').create({ id: 'n' });
        const instant = (/** @type {any} */ value) => at(`${value.date}T${value.time}:00Z`) - (value.time === '02:30' ? 2 : 1) * 3600000;
        assert.deepEqual((await keys()).p, [instant(amsterdam), a]);
        assert.deepEqual((await keys()).n, [null, null]);
        // update(): the whole row is written, so its key with it
        const later = zoned('2026-10-25', '03:30', 'Europe/Amsterdam');
        await current.entity('Ev').update('p', { z: later });
        // a tracked save that edits inside the member restamps it
        const ev = current.entity('Ev');
        ev.put({ ...(await ev.get('q')), z: { ...amsterdam, time: '03:30' } });
        await current.saveChanges();
        // one that edits another member leaves the member's key as its writer keyed it
        ev.put({ ...(await ev.get('r')), u: utc('2026-02-01T00:00:00Z') });
        await current.saveChanges();
        // and one that removes the member writes no key at all
        const { z: _z, ...rest } = await ev.get('s');
        ev.put(rest);
        await current.saveChanges();
        const held = await keys();
        assert.deepEqual(held.p, [at('2026-10-25T02:30:00Z'), b]);
        assert.deepEqual(held.q, [at('2026-10-25T02:30:00Z'), b]);
        assert.deepEqual(held.r, [instant(amsterdam), a]);
        assert.deepEqual(held.s, [null, null]);
        // every store answers as the engine, whoever stamped what
        const probe = query('$.Ev[*]', { $lt: [{ $instant: ['$it.z', 'rfc5545'] }, at('2026-10-25T02:00:00Z')] });
        const rows = [{ id: 'p', z: later }, { id: 'q', z: { ...amsterdam, time: '03:30' } }, { id: 'r', z: amsterdam }, { id: 's' }, { id: 'n' }];
        for (const store of [older, current])
          assert.deepEqual(list(await store.entity('Ev').execute(probe)), engine(probe, { Ev: rows }));
      };
      if (engineName === 'sqlite') {
        const { dbPath: path, cleanup } = tempDbPath();
        const older = await openStore(doc, { driver: nodeDriver(), temporals: temporalSeam, path, zoneProvider });
        const current = await openStore(doc, { driver: nodeDriver(), temporals: temporalSeam, path, zoneProvider: laterProvider });
        const raw = new DatabaseSync(path);
        try { await run(older, current, async (sql) => raw.prepare(sql).all()); }
        finally { raw.close(); await current.close(); await older.close(); cleanup(); }
      }
      else {
        await withPostgres(async ({ schema, driver }) => {
          // the two stores hold the pool's two connections: the raw reads take a third
          const { default: pg } = await import('pg');
          const reader = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 1 });
          const older = await openStore(doc, { driver: driver(), temporals: temporalSeam, zoneProvider });
          const current = await openStore(doc, { driver: driver(), temporals: temporalSeam, zoneProvider: laterProvider });
          try { await run(older, current, async (sql) => (await reader.query(sql.replace('FROM "Ev"', `FROM "${schema}"."Ev"`))).rows); }
          finally { await current.close(); await older.close(); await reader.end(); }
        });
      }
    });

    it('refuses a store whose model declares a zoned member without a recorded zone provider (JD0004)', async () => {
      for (const provider of [undefined, createIntlZoneProvider()]) {
        await assert.rejects(withStore(engineName, entityModel(), async () => {}, { temporals: temporalSeam,
          ...(provider === undefined ? {} : { zoneProvider: provider }) }),
        (/** @type {any} */ e) => e.code === 'JD0004' && /zoneProvider whose identity records/.test(e.message));
      }
    });
  });
}

for (const engineName of ENGINES) {
  describe(`${engineName}: a key read in a join and a related entity's filter`, { skip: skipFor(engineName) }, () => {
    it('qualifies the key column by its binding, natively, and answers as the engine', async () => {
      const doc = entityModel();
      doc.entities.Ev.schema.properties.owner = { type: 'string' };
      doc.entities.Own = { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
        since: temporal('utc') } } };
      const owners = [{ id: 'o1', since: utc('2026-01-01T00:00:00Z') }, { id: 'o2', since: utc('2025-01-01T00:00:00.000Z') }, { id: 'o3' }];
      const rows = ROWS.map((row, i) => ({ ...row, owner: owners[i % owners.length].id }));
      await withStore(engineName, doc, async (store) => {
        for (const owner of owners) await store.entity('Own').create(owner);
        for (const row of rows) await store.entity('Ev').create(row);
        const join = { $for: { e: '$.Ev[*]', o: '$.Own[*]' }, $where: { $and: [{ $eq: ['$e.owner', '$o.id'] },
          { $lt: [{ $instant: ['$e.u'] }, at('2026-03-29T12:00:00.2Z')] }, { $ge: [{ $instant: ['$o.since'] }, at('2025-06-01T00:00:00Z')] }] },
        $orderby: [{ $wall: '$e.f' }, '$e.id'], $return: { e: '$e.id', o: '$o.id' } };
        const expected = engine(join, { Ev: rows, Own: owners });
        assert.ok(expected.length > 0);
        assert.deepEqual(list(await store.entity('Ev').execute(join)), expected);
        assert.deepEqual(list(await store.entity('Ev').execute(join, { pushdown: false })), expected);
        const explained = await store.entity('Ev').explain(join);
        assert.equal(explained.mode, 'native', JSON.stringify(explained.reasons));
        assert.match(explained.sql, /"t\d"\."tk_u" IS NOT NULL AND "t\d"\."tk_u" < /);
        assert.match(explained.sql, /"t\d"\."tk_since" IS NOT NULL AND "t\d"\."tk_since" >= /);
      }, { zoneProvider, temporals: temporalSeam });
    });
  });
}

for (const engineName of ENGINES) {
  describe(`${engineName}: a calendar member's member returned as the engine returns it`, { skip: skipFor(engineName) }, () => {
    it('projects a date member read from its key column, absent where the member is', async () => {
      await withStore(engineName, entityModel(), async (store) => {
        const ev = store.entity('Ev');
        for (const row of ROWS) await ev.create(row);
        for (const ret of ['$it.d.date', '$it.r.end', { on: '$it.d.date', from: '$it.r.start' }]) {
          const projected = { $for: { it: '$.Ev[*]' }, $orderby: ['$it.d.date', '$it.id'], $return: ret };
          assert.deepEqual(list(await ev.execute(projected)), engine(projected, { Ev: ROWS }), JSON.stringify(ret));
          assert.deepEqual(list(await ev.execute(projected, { pushdown: false })), engine(projected, { Ev: ROWS }), JSON.stringify(ret));
        }
      }, { zoneProvider, temporals: temporalSeam });
    });
  });
}
