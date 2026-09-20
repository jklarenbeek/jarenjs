//@ts-check
/**
 * @file Regressions for the store quirks a consumer (WorkOps, on
 * 0.91.4) found, plus the one its report led to: a misspelt `openStore`
 * option is refused rather than dropped (`JD0009`); an additive,
 * optional-only model change is a WIDENING, so the planner drafts no
 * transform and the plan applies unattended; an `enum` of one scalar
 * type gets the column and `CHECK` §9.3 promises, and takes an index;
 * a nullable column-mapped member is carved out of `required` for
 * write validation, because the store's own read answers it absent;
 * and a version token added to an existing entity is STARTED for the
 * rows that predate it rather than left SQL `NULL`, which no save's
 * guard could ever match.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore, planModelMigration, migrate, explainMapping, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { JarenValidator } from '@jarenjs/validate';
import { tempDbPath } from './helpers.js';

const validator = new JarenValidator({ collectErrors: true, skipErrors: false });
const compileSchema = (/** @type {any} */ schema) => validator.compile(schema);

/** @param {Record<string, any>} properties @param {string[]} [required] */
const entity = (properties, required = ['id']) => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    required,
    properties: { id: { type: 'string', 'x-entity': { key: true } }, ...properties },
  },
});

describe('openStore refuses an option it does not read (JD0009)', () => {
  it('names the nearest option rather than opening a store without the feature', async () => {
    const model = { $model: '0.1', entities: { Team: entity({ name: { type: 'string' } }) } };
    await assert.rejects(
      () => openStore(model, { driver: nodeDriver(), path: ':memory:', captur: true }),
      (/** @type {any} */ error) => {
        assert.strictEqual(error.code, 'JD0009');
        assert.match(error.message, /'captur'/);
        assert.match(error.message, /did you mean 'capture'\?/);
        return true;
      });
    // a pragma outside the closed set keeps its own, more specific refusal
    await assert.rejects(
      () => openStore(model, { driver: nodeDriver(), path: ':memory:', pageSize: 4096 }),
      (/** @type {any} */ error) => error.code === 'JD0006');
    // every option the store does read still opens
    const store = await openStore(model, { driver: nodeDriver(), path: ':memory:', compileSchema, busyTimeout: 1000 });
    await store.close();
  });
});

describe('an additive, optional-only change is a widening', () => {
  it('plans the ADD COLUMN alone, reports it widened, and applies unattended', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const from = { $model: '0.1', entities: { Shift: entity({ name: { type: 'string' } }) } };
      const to = { $model: '0.1', entities: { Shift: entity({ name: { type: 'string' }, source: { type: 'string' } }) } };
      let store = await openStore(from, { driver: nodeDriver(), path: dbPath, compileSchema });
      store.entity('Shift').add({ id: 's1', name: 'Morning' });
      await store.saveChanges();
      await store.close();

      const { migration, report } = planModelMigration(from, to, { dialect: sqliteDialect, id: 'widen' });
      assert.deepStrictEqual(report.widened, ['Shift']);
      assert.deepStrictEqual(report.drafts, []);
      assert.deepStrictEqual(report.schemaChanged, ['Shift'], 'it still reports that the schema moved');
      assert.ok(!migration.steps.some((/** @type {any} */ step) => step.draft === true),
        'nothing is left for a person to delete by hand');

      // the plan applies as written — no edit, no JD0021
      const applied = await migrate({ driver: nodeDriver(), path: dbPath }, [migration],
        { baseline: from, model: to, compileSchema });
      assert.deepStrictEqual(applied.applied, ['widen']);

      store = await openStore(to, { driver: nodeDriver(), path: dbPath, compileSchema });
      assert.deepStrictEqual(await store.entity('Shift').get('s1'), { id: 's1', name: 'Morning' });
      await store.close();
    }
    finally { cleanup(); }
  });

  it('a NARROWING still drafts: a new required member, a changed member, and a member first named under an open schema', () => {
    const plan = (/** @type {any} */ from, /** @type {any} */ to) =>
      planModelMigration(from, to, { dialect: sqliteDialect, id: 'x' }).report;

    const base = { $model: '0.1', entities: { Shift: entity({ name: { type: 'string' } }) } };
    // a new REQUIRED member: the stored documents do not carry it
    assert.deepStrictEqual(plan(base,
      { $model: '0.1', entities: { Shift: entity({ name: { type: 'string' }, source: { type: 'string' } }, ['id', 'source']) } },
    ).drafts, ['Shift']);
    // a member whose shape changed
    assert.deepStrictEqual(plan(base,
      { $model: '0.1', entities: { Shift: entity({ name: { type: 'integer' } }) } },
    ).drafts, ['Shift']);
    // a member first NAMED under an OPEN schema may already be stored
    // with any shape, so naming it narrows what exists
    const open = (/** @type {any} */ properties) => ({
      schema: { type: 'object', required: ['id'],
        properties: { id: { type: 'string', 'x-entity': { key: true } }, ...properties } },
    });
    assert.deepStrictEqual(plan(
      { $model: '0.1', entities: { Shift: open({ name: { type: 'string' } }) } },
      { $model: '0.1', entities: { Shift: open({ name: { type: 'string' }, age: { type: 'integer' } }) } },
    ).drafts, ['Shift'], 'an open schema keeps the draft');
  });
});

describe('a version token added to an existing entity', () => {
  const withVersion = { type: 'integer', 'x-entity': { version: true } };

  for (const [label, from, to] of /** @type {any[][]} */ ([
    ['the additive path (ADD COLUMN)',
      { $model: '0.1', entities: { User: entity({ name: { type: 'string' } }) } },
      { $model: '0.1', entities: { User: entity({ name: { type: 'string' }, rev: withVersion }) } }],
    ['the rebuild path (a column also changed type)',
      { $model: '0.1', entities: { User: entity({ age: { type: 'integer' } }) } },
      { $model: '0.1', entities: { User: entity({ age: { type: 'string' }, rev: withVersion }) } }],
  ])) {
    it(`starts at 0 for the rows that predate it — ${label}`, async () => {
      const { dbPath, cleanup } = tempDbPath();
      try {
        let store = await openStore(from, { driver: nodeDriver(), path: dbPath });
        store.entity('User').add(from.entities.User.schema.properties.age === undefined
          ? { id: 'u1', name: 'Ada' } : { id: 'u1', age: 7 });
        await store.saveChanges();
        await store.close();

        const { migration } = planModelMigration(from, to, { dialect: sqliteDialect, id: 'v' });
        // a rebuild still drafts (the type changed); the operator deletes
        // it, which is the documented move and the one that used to
        // expose the NULL token
        migration.steps = migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
        await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: from, model: to });

        store = await openStore(to, { driver: nodeDriver(), path: dbPath });
        const users = store.entity('User');
        const stored = await users.get('u1');
        assert.strictEqual(stored.rev, 0, '§9.6: an insert without one writes 0, never SQL NULL');
        // the point of the token: the row can still be written
        users.put({ ...stored, id: 'u1', ...(stored.name === undefined ? { age: '8' } : { name: 'Ada Lovelace' }) });
        await store.saveChanges();
        assert.strictEqual((await users.get('u1')).rev, 1, 'the write bumped it');
        await store.close();
      }
      finally { cleanup(); }
    });
  }
});

describe('an enum of one scalar type is column-mapped (§9.3)', () => {
  it('gets the column and its CHECK, takes an index, and refuses an unlisted value', async () => {
    const model = {
      $model: '0.1',
      entities: {
        Shift: entity({
          status: { enum: ['draft', 'open', 'closed'], 'x-entity': { index: true } },
          priority: { enum: [1, 2, 3] },
          mixed: { enum: ['a', 1] },
        }),
      },
    };
    const mapping = explainMapping(model).entities.Shift;
    const column = (/** @type {string} */ name) =>
      mapping.columns.find((/** @type {any} */ c) => c.name === name);
    assert.deepStrictEqual(column('status').check, ['draft', 'open', 'closed']);
    assert.strictEqual(column('status').storage, 'string');
    assert.strictEqual(column('priority').storage, 'integer', 'an integer set is an integer column');
    assert.strictEqual(column('mixed'), undefined, 'a MIXED enum has no one column type');
    assert.deepStrictEqual(mapping.document, ['mixed']);
    assert.deepStrictEqual(mapping.indexes, [{ property: 'status', unique: false }]);

    const store = await openStore(model, { driver: nodeDriver(), path: ':memory:', compileSchema });
    const shifts = store.entity('Shift');
    shifts.add({ id: 's1', status: 'open', priority: 2, mixed: 'a' });
    await store.saveChanges();
    assert.strictEqual((await shifts.get('s1')).status, 'open');
    assert.throws(() => shifts.add({ id: 's2', status: 'bogus', priority: 1, mixed: 1 }),
      (/** @type {any} */ error) => error.code === 'JD2003');
    await store.close();
  });
});

describe('a nullable column-mapped member and write validation', () => {
  it('survives the read-modify-write the store\'s own read shape produces', async () => {
    const model = {
      $model: '0.1',
      entities: {
        Team: entity({ name: { type: 'string' }, color: { type: ['string', 'null'] } },
          ['id', 'name', 'color']),
      },
    };
    const store = await openStore(model, { driver: nodeDriver(), path: ':memory:', compileSchema });
    const teams = store.entity('Team');
    teams.add({ id: 't1', name: 'Front of house', color: null });
    await store.saveChanges();
    const team = await teams.get('t1');
    assert.deepStrictEqual(team, { id: 't1', name: 'Front of house' },
      '§9.3: a null column reads back ABSENT');
    teams.put({ ...team, name: 'Front' });
    await store.saveChanges();
    assert.deepStrictEqual(await teams.get('t1'), { id: 't1', name: 'Front' });
    // a member that is NOT nullable is still required of a write
    assert.throws(() => teams.add(/** @type {any} */ ({ id: 't2', color: null })),
      (/** @type {any} */ error) => error.code === 'JD2003');
    await store.close();
  });

  it('a nullable member kept in the DOCUMENT stays required — there null round-trips as null', async () => {
    const model = {
      $model: '0.1',
      entities: {
        Note: entity({ body: { type: ['string', 'null'], 'x-entity': { column: 'json' } } },
          ['id', 'body']),
      },
    };
    const store = await openStore(model, { driver: nodeDriver(), path: ':memory:', compileSchema });
    const notes = store.entity('Note');
    notes.add({ id: 'n1', body: null });
    await store.saveChanges();
    assert.deepStrictEqual(await notes.get('n1'), { id: 'n1', body: null });
    assert.throws(() => notes.add(/** @type {any} */ ({ id: 'n2' })),
      (/** @type {any} */ error) => error.code === 'JD2003');
    await store.close();
  });
});
