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
});

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

  it('is the declared order, with each table after those it references', () => {
    const references = /** @type {Record<string, string[]>} */ ({ Book: ['Author'], Author: [], Profile: ['Author', 'Elsewhere'], Self: ['Self'], A: ['B'], B: ['A'] });
    const of = (/** @type {string[]} */ names) => creationOrder(names, (name) => references[name]);
    assert.deepStrictEqual(of(['Author', 'Book', 'Profile']), ['Author', 'Book', 'Profile'], 'already ordered: unchanged');
    assert.deepStrictEqual(of(['Book', 'Author']), ['Author', 'Book']);
    assert.deepStrictEqual(of(['Profile', 'Book', 'Author']), ['Author', 'Profile', 'Book'], 'a reference outside the set asks for nothing');
    assert.deepStrictEqual(of(['Self', 'Book', 'Author']), ['Self', 'Author', 'Book'], 'a table that references itself needs no other');
    assert.deepStrictEqual(of(['A', 'Author', 'B']), ['B', 'A', 'Author'], 'a cycle has no order: it keeps the one it was declared in, after what it needs');
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
