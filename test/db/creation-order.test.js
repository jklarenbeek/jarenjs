//@ts-check
/**
 * @file A table is created after the tables it references. PostgreSQL has no
 * forward references, so a store whose model declared a child before its
 * parent (or an entity before the one a one-to-one points at) did not open
 * there -- `relation "Author" does not exist` -- while SQLite, which checks a
 * foreign key when a row meets it, opened the same model; a migration that
 * adds the two entities in that order failed the same way. Tables keep the
 * order they were declared in wherever no reference asks otherwise.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { openStore, planModelMigration, sqliteDialect } from '@jarenjs/db';
import { creationOrder } from '../../packages/db/src/ddl.js';
import { ENGINES, skipFor, withPostgres, withStore } from './store-core-engines.js';
import { postgresDialect } from '@jarenjs/db/postgres';

const ent = (extra = {}) => ({ schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, ...extra } } });
const rel = (/** @type {string} */ to, /** @type {any} */ more) => ({ 'x-entity': { relation: { to, ...more } } });
const MODELS = /** @type {Record<string, any>} */ ({
  'a child declared before its parent': { Book: ent(), Author: ent({ books: rel('Book', { many: true, via: 'authorId', onDelete: 'cascade' }) }) },
  'a one-to-one declared before its target': { Author: ent({ profile: rel('Profile', { via: 'profileId', onDelete: 'setNull' }) }), Profile: ent() },
  'a chain declared from its last link': {
    C: ent({ bId: { type: 'string' } }),
    B: ent({ cs: rel('C', { many: true, via: 'bId', onDelete: 'cascade' }), aId: { type: 'string' } }),
    A: ent({ bs: rel('B', { many: true, via: 'aId', onDelete: 'cascade' }) }),
  },
  'two one-to-ones that reference each other in a cycle': {
    Person: ent({ petId: { type: 'string' }, pet: rel('Pet', { via: 'petId', onDelete: 'setNull' }) }),
    Pet: ent({ ownerId: { type: 'string' }, owner: rel('Person', { via: 'ownerId', onDelete: 'setNull' }) }),
  },
  'a cycle of three beside a table that references itself': {
    C: ent({ aId: { type: 'string' }, a: rel('A', { via: 'aId', onDelete: 'setNull' }) }),
    Tree: ent({ parentId: { type: 'string' }, parent: rel('Tree', { via: 'parentId', onDelete: 'setNull' }) }),
    A: ent({ bId: { type: 'string' }, b: rel('B', { via: 'bId', onDelete: 'setNull' }) }),
    B: ent({ cId: { type: 'string' }, c: rel('C', { via: 'cId', onDelete: 'setNull' }) }),
  },
});
const CYCLE = MODELS['two one-to-ones that reference each other in a cycle'];

describe('the order tables are created in', () => {
  it('a migration adds a child and its parent in the order that works, on either dialect', () => {
    const before = { $model: '0.1', entities: { Other: ent() } };
    const after = { $model: '0.1', entities: { Other: ent(), ...MODELS['a child declared before its parent'] } };
    for (const dialect of [sqliteDialect, postgresDialect({ searchPath: 'tenant' })]) {
      const created = planModelMigration(before, after, { dialect, id: 'add' }).migration.steps
        .map((/** @type {any} */ step) => /^CREATE TABLE "(\w+)"/.exec(step.sql ?? '')?.[1]).filter((name) => name !== undefined);
      assert.deepStrictEqual(created, ['Author', 'Book']);
    }
  });

  it('a migration creates a cycle\'s tables, then adds its foreign keys after, on PostgreSQL only', () => {
    const steps = (/** @type {any} */ dialect) => planModelMigration({ $model: '0.1', entities: { Other: ent() } }, { $model: '0.1', entities: { Other: ent(), ...CYCLE } }, { dialect, id: 'cycle' })
      .migration.steps.map((/** @type {any} */ step) => step.sql).filter((/** @type {any} */ sql) => /^(CREATE TABLE|ALTER TABLE)/.test(sql ?? ''));
    const pg = steps(postgresDialect({ searchPath: 'tenant' }));
    assert.deepStrictEqual(pg.map((sql) => /^(CREATE TABLE|ALTER TABLE) "(\w+)"/.exec(sql)?.slice(1, 3).join(' ')), ['CREATE TABLE Pet', 'CREATE TABLE Person', 'ALTER TABLE Pet', 'ALTER TABLE Person']);
    assert.ok(pg.slice(0, 2).every((sql) => !sql.includes('REFERENCES')), pg.join('\n'));
    assert.match(pg[3], /^ALTER TABLE "Person" ADD FOREIGN KEY \("petId"\) REFERENCES "Pet" \("id"\) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE$/);
    assert.match(pg[2], /^ALTER TABLE "Pet" ADD FOREIGN KEY \("ownerId"\) REFERENCES "Person" \("id"\) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE$/);
    const tree = planModelMigration({ $model: '0.1', entities: { Other: ent() } }, { $model: '0.1', entities: { Other: ent(), Tree: MODELS['a cycle of three beside a table that references itself'].Tree } },
      { dialect: postgresDialect({ searchPath: 'tenant' }), id: 'tree' }).migration.steps.map((/** @type {any} */ step) => step.sql).filter((/** @type {any} */ sql) => /^(CREATE TABLE|ALTER TABLE)/.test(sql ?? ''));
    assert.strictEqual(tree.length, 1, 'a table that references itself keeps its key in its own CREATE');
    assert.match(tree[0], /REFERENCES "Tree"/);
    const lite = steps(sqliteDialect);
    assert.deepStrictEqual(lite.map((sql) => /^(CREATE TABLE|ALTER TABLE) "(\w+)"/.exec(sql)?.slice(1, 3).join(' ')), ['CREATE TABLE Pet', 'CREATE TABLE Person'], 'SQLite adds nothing');
    assert.ok(lite.every((sql) => sql.includes('REFERENCES')), lite.join('\n'));
  });

  it('is the declared order, with each table after those it references', () => {
    const references = /** @type {Record<string, string[]>} */ ({ Book: ['Author'], Author: [], Profile: ['Author', 'Elsewhere'], Self: ['Self'], A: ['B'], B: ['A'] });
    const of = (/** @type {string[]} */ names) => creationOrder(names, (name) => references[name]);
    assert.deepStrictEqual(of(['Author', 'Book', 'Profile']), ['Author', 'Book', 'Profile'], 'already ordered: unchanged');
    assert.deepStrictEqual(of(['Book', 'Author']), ['Author', 'Book']);
    assert.deepStrictEqual(of(['Profile', 'Book', 'Author']), ['Author', 'Profile', 'Book'], 'a reference outside the set asks for nothing');
    assert.deepStrictEqual(of(['Self', 'Book', 'Author']), ['Self', 'Author', 'Book'], 'a table that references itself needs no other');
    assert.deepStrictEqual(of(['A', 'Author', 'B']), ['B', 'A', 'Author'], 'a cycle has no order: it keeps the one it was declared in, after what it needs');
  });

  describe('PostgreSQL: a cycle', { skip: skipFor('postgres') }, () => {
    it('opens with both foreign keys in the catalog, enforces them, and verifies them on the next open', async () => {
      const model = { $model: '0.1', entities: CYCLE };
      await withPostgres(async ({ pool, schema, driver }) => {
        const store = await openStore(model, { driver: driver() });
        try {
          await store.entity('Person').create({ id: 'a' });
          await store.entity('Pet').create({ id: 'p', ownerId: 'a' });
          await store.entity('Person').update('a', { petId: 'p' });
          await assert.rejects(store.entity('Pet').create({ id: 'q', ownerId: 'nobody' }));
          await store.entity('Pet').delete('p');
          assert.strictEqual((await store.entity('Person').get('a'))?.petId, undefined, 'ON DELETE SET NULL reaches the other side of the cycle');
        }
        finally { await store.close(); }
        const { rows } = await pool.query('SELECT conrelid::regclass::text AS "table", pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = $1 AND connamespace = $2::regnamespace ORDER BY 1', ['f', schema]);
        assert.deepStrictEqual(rows.map((row) => row.def.replace(`${schema}.`, '')), ['FOREIGN KEY ("petId") REFERENCES "Pet"(id) ON DELETE SET NULL DEFERRABLE', 'FOREIGN KEY ("ownerId") REFERENCES "Person"(id) ON DELETE SET NULL DEFERRABLE']);
        await (await openStore(model, { driver: driver() })).close();
        await pool.query(`ALTER TABLE "${schema}"."Person" DROP CONSTRAINT "Person_petId_fkey"`);
        await assert.rejects(openStore(model, { driver: driver() }), { code: 'JD0002', message: /the foreign keys are \[\], the model declares \[petId -> Pet\(id\) ON DELETE SET NULL/ });
      });
    });
  });

  for (const engine of ENGINES) {
    describe(`${engine}: a model declared out of order`, { skip: skipFor(engine) }, () => {
      for (const [label, entities] of Object.entries(MODELS)) {
        it(`${label} opens, takes its rows, and opens again`, async () => {
          const model = { $model: '0.1', entities };
          const run = async (/** @type {any} */ store) => {
            const names = Object.keys(entities);
            const last = names.at(-1);
            await store.entity(names[0]).create({ id: 'x' });
            assert.strictEqual((await store.entity(names[0]).get('x'))?.id, 'x', `${label}: ${last}`);
          };
          if (engine === 'sqlite') {
            await withStore(engine, model, run);
            return;
          }
          await withPostgres(async ({ driver }) => {
            const first = await openStore(model, { driver: driver() });
            await run(first);
            await first.close();
            const second = await openStore(model, { driver: driver() });
            await second.close();
          });
        });
      }
    });
  }
});
