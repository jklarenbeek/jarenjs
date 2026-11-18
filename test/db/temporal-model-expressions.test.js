//@ts-check
/**
 * @file A model's own expressions read a calendar value through the store's
 * temporal seam (`temporals: storeTemporals()`, MODEL-FORMAT §2): an entity's
 * `{ query }` default and invariant assert (its arithmetic included) compile
 * with the seam's calendar, identically on SQLite and PostgreSQL; without
 * the seam they are `JD0005` naming it. A migration reads a model, and runs
 * its document steps, with the calendar always, so such a model plans — as
 * history too — on any host, and a document step answers alike over a store
 * and over arrays.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, prepareModel, normalizeEntities, explainMapping, compileEntityModel, planModelMigration,
  planInvariants, planMigration, migrate, migrateDocuments, classifyAssertion, entityEmitModel, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { storeTemporals } from '@jarenjs/db/temporals';
import { queryCalendar } from '@jarenjs/json/query/calendar';
import { compileEmitModel } from '@jarenjs/emit';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

const temporals = storeTemporals();
const utc = (/** @type {string} */ instant) => ({ kind: 'utc', instant });
const floating = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'floating', date, time });

/** An entity whose default and invariant read calendar values. */
const MODEL = { $model: '0.1', entities: { Slot: { schema: { type: 'object', properties: {
  id: { type: 'string', 'x-entity': { key: true } },
  from: { type: 'object' }, until: { type: 'object' }, local: { type: 'object' },
  label: { type: 'string', 'x-entity': { default: { query: { $wall: '$.local' } } } },
} }, invariants: [
  { name: 'ordered', on: ['insert', 'update'], enforcement: 'store',
    assert: { $lt: [{ $instant: ['$.new.from'] }, { $instant: ['$.new.until'] }] } },
  // arithmetic over calendar keys: each operand compiles on its own
  { name: 'underADay', on: ['insert', 'update'], enforcement: 'store',
    assert: { $lt: [{ $sub: [{ $instant: ['$.new.until'] }, { $instant: ['$.new.from'] }] }, 86400000] } },
] } } };

/** @param {any} e @param {string} at */
const unseamed = (e, at) => {
  assert.equal(e.code, 'JD0005', e.message);
  assert.equal(e.docPath, at);
  assert.match(e.message, /JQ0003[^]*storeTemporals\(\)/);
  return true;
};

describe('an entity expression reading a calendar value', () => {
  for (const engine of ENGINES) {
    it(`compiles with the store's seam and answers on ${engine}`, { skip: skipFor(engine) }, async () => {
      await withStore(engine, MODEL, async (store) => {
        const slots = store.entity('Slot');
        const created = await slots.create({ id: 'a', from: utc('2026-01-01T00:00:00Z'), until: utc('2026-01-01T01:00:00.000Z'),
          local: floating('2026-01-01', '09:30') });
        assert.equal(created.label, '2026-01-01T09:30:00.000');
        assert.equal((await slots.get('a')).label, '2026-01-01T09:30:00.000');
        // the same instant in two spellings is not before itself
        await assert.rejects(slots.create({ id: 'b', from: utc('2026-01-01T01:00:00Z'), until: utc('2026-01-01T01:00:00.000Z'),
          local: floating('2026-01-01', '10:00') }), { code: 'JD2096', message: /ordered/ });
        await assert.rejects(slots.create({ id: 'c', from: utc('2026-01-01T00:00:00Z'), until: utc('2026-01-02T00:00:00Z'),
          local: floating('2026-01-01', '10:00') }), { code: 'JD2096', message: /underADay/ });
        slots.put({ ...created, until: utc('2025-12-31T23:59:59.999Z') });
        await assert.rejects(store.saveChanges(), { code: 'JD2096' });
      }, { temporals });
    });

    it(`is JD0005 naming the seam without it on ${engine}`, { skip: skipFor(engine) }, async () => {
      await assert.rejects(withStore(engine, MODEL, async () => {}),
        (/** @type {any} */ e) => unseamed(e, '/entities/Slot/schema/properties/label/x-entity/default'));
      const invariantOnly = structuredClone(MODEL);
      delete (/** @type {any} */ (invariantOnly.entities.Slot.schema.properties.label))['x-entity'];
      await assert.rejects(withStore(engine, invariantOnly, async () => {}),
        (/** @type {any} */ e) => unseamed(e, '/entities/Slot/invariants/0/assert'));
    });
  }

  it('a prepared model keeps needing the seam: prepared with it, opened without, refused', async () => {
    assert.throws(() => prepareModel(MODEL), (/** @type {any} */ e) => e.code === 'JD0005');
    const prepared = prepareModel(MODEL, { temporals });
    await assert.rejects(openStore(prepared, { driver: nodeDriver() }), (/** @type {any} */ e) => e.code === 'JD0005');
    const store = await openStore(prepared, { driver: nodeDriver(), temporals });
    try {
      const row = await store.entity('Slot').create({ id: 'a', from: utc('2026-01-01T00:00:00Z'), until: utc('2026-01-01T00:00:01Z'),
        local: floating('2026-01-01', '08:00') });
      assert.equal(row.label, '2026-01-01T08:00:00.000');
    }
    finally { await store.close(); }
  });

  it('normalizeEntities, explainMapping and compileEntityModel take the seam as temporals', () => {
    for (const read of [normalizeEntities, explainMapping, compileEntityModel]) {
      assert.throws(() => read(MODEL), (/** @type {any} */ e) => e.code === 'JD0005');
      assert.doesNotThrow(() => read(MODEL, { temporals }));
      assert.throws(() => read(MODEL, { temporals: /** @type {any} */ ({ hooks: {}, calendar: queryCalendar() }) }), { code: 'JD0009' });
      assert.throws(() => read(MODEL, /** @type {any} */ ({ calendar: queryCalendar() })), { code: 'JD0009' });
    }
    assert.equal(normalizeEntities(MODEL, { temporals }).get('Slot').invariants.length, 2);
    // a model without such an expression reads as it did, with or without the seam
    const plain = { $model: '0.1', entities: { A: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } } } } } } };
    assert.deepEqual(explainMapping(plain, { temporals }), explainMapping(plain));
  });
});

describe('a migration reads such a model with the calendar always', () => {
  it('plans it from and to, without the host installing the seam', () => {
    const empty = { $model: '0.1', entities: { Other: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } } } } } } };
    assert.doesNotThrow(() => planModelMigration(empty, MODEL, { dialect: sqliteDialect }));
    assert.doesNotThrow(() => planModelMigration(MODEL, empty, { dialect: sqliteDialect }));
    const moved = structuredClone(MODEL);
    moved.entities.Slot.invariants[1].assert.$lt[1] = 3600000;
    assert.doesNotThrow(() => planModelMigration(MODEL, moved, { dialect: sqliteDialect }));
  });

  it('the generated types read it with the seam the CLI passes', () => {
    assert.throws(() => entityEmitModel(MODEL, { compile: compileEmitModel }), (/** @type {any} */ e) => e.code === 'JD0005');
    const emitted = entityEmitModel(MODEL, { compile: compileEmitModel, temporals });
    assert.ok(JSON.stringify(emitted).includes('Slot'));
  });

  it('planInvariants takes the seam as temporals', () => {
    assert.throws(() => planInvariants(MODEL, { dialect: sqliteDialect }), (/** @type {any} */ e) => e.code === 'JD0005');
    assert.deepEqual(planInvariants(MODEL, { dialect: sqliteDialect, temporals }), []);
  });
});

const COLLECTIONS = { $model: '0.1', collections: { events: { schema: { type: 'object' }, key: '/id', indexes: [] } } };
const NEXT = { $model: '0.1', collections: { ...COLLECTIONS.collections, other: { schema: { type: 'object' }, key: null, identity: 'integer' } } };
const STEPS = [
  { kind: 'jslt', collection: 'events', stylesheet: [{ match: '$', body: { id: '$.id', at: '$.at', wall: { $wall: '$.local' } } }] },
  { kind: 'query', collection: 'events', assert: { $for: { it: '$[*]' }, $where: { $lt: [{ $instant: ['$it.at'] }, 0] }, $return: '$it.id' } },
];
const SEED = [
  { id: 'e1', at: utc('2026-01-01T00:00:00Z'), local: floating('2026-01-01', '10:00') },
  { id: 'e2', at: utc('2026-01-01T00:00:00.000Z'), local: floating('2026-01-02', '10:00:00.000') },
];

describe('a document step reading a calendar value', () => {
  const migration = () => {
    const { migration: planned } = planMigration(COLLECTIONS, NEXT, { dialect: sqliteDialect, id: '0001-calendar' });
    planned.steps.push(...structuredClone(STEPS));
    return planned;
  };

  it('answers alike over a store and over arrays, classified per document', async () => {
    const arrays = await migrateDocuments({ events: structuredClone(SEED) },
      [{ ...migration(), steps: migration().steps.filter((s) => s.kind === 'jslt' || s.kind === 'query') }]);
    assert.deepEqual(arrays.documents.events.map((/** @type {any} */ d) => d.wall), ['2026-01-01T10:00:00.000', '2026-01-02T10:00:00.000']);
    assert.equal(arrays.report.counts.events.asserted, 2);
    // the assertion is analyzed with the calendar: per document
    /** @type {any[]} */
    const plans = [];
    await migrateDocuments({ events: structuredClone(SEED) }, [{ ...migration(), steps: migration().steps.filter((s) => s.kind === 'query') }],
      { onAssertionPlan: (/** @type {any} */ plan) => plans.push(plan) });
    assert.deepEqual(plans.map((plan) => plan.strategy), ['perDocument']);
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(COLLECTIONS, { driver: nodeDriver(), path: dbPath });
      for (const doc of SEED) await store.collection('events').insert(structuredClone(doc));
      await store.close();
      const dry = await migrate({ driver: nodeDriver(), path: dbPath }, [migration()], { baseline: COLLECTIONS, model: NEXT, shadow: false, dryRun: true });
      assert.ok(dry.statements.some((/** @type {string} */ line) => line.startsWith("-- assert over 'events' (perDocument;")), dry.statements.join('\n'));
      await migrate({ driver: nodeDriver(), path: dbPath }, [migration()], { baseline: COLLECTIONS, model: NEXT, shadow: false });
      const reopened = await openStore(NEXT, { driver: nodeDriver(), path: dbPath });
      const stored = [];
      for await (const row of reopened.collection('events').query({ $for: { it: '$[*]' }, $orderby: '$it.id', $return: '$it' })) stored.push(row);
      await reopened.close();
      assert.deepEqual(stored, arrays.documents.events);
    }
    finally { cleanup(); }
  });

  it('classifyAssertion analyzes it with the calendar, and refuses one that is not the seam', () => {
    const assertion = STEPS[1].assert;
    assert.equal(classifyAssertion(assertion, { calendar: queryCalendar() }).strategy, 'perDocument');
    assert.equal(classifyAssertion(assertion).strategy, 'materialize');
    assert.throws(() => classifyAssertion(assertion, { calendar: {} }), TypeError);
  });
});
