//@ts-check
/**
 * @file A many-to-many relation names its join table by a string `through`
 * (MODEL-FORMAT §9.4). Any other value — a number, an object of a table and
 * columns, `null`, an array, a boolean — opened and named the implicit
 * `<A>_<B>` table without a word; a store that opens or prepares such a
 * model refuses it `JD0005` at the relation's `through`. A migration plan
 * reads a model carrying one as before, so a history that holds one still
 * plans.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore, prepareModel, planModelMigration, explainMapping, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

/** A post and a tag joined many-to-many, the relation's `through` as given (left out for `undefined`).
 * @param {any} through */
const model = (through) => ({
  $model: '0.1',
  entities: {
    Post: { schema: { type: 'object', properties: { pid: { type: 'integer', 'x-entity': { key: true } },
      tags: { 'x-entity': { relation: { to: 'Tag', many: true, ...(through === undefined ? {} : { through }) } } } } } },
    Tag: { schema: { type: 'object', properties: { tid: { type: 'integer', 'x-entity': { key: true } } } } },
  },
});
const AT = '/entities/Post/schema/properties/tags/x-entity/relation/through';

describe('a join table is named by a string through', () => {
  it('refuses any other through where a store opens or prepares the model', async () => {
    const reason = `JD0005: through names the join table, as a string at ${AT}`;
    for (const through of [42, { table: 'Links', columns: { at: { type: 'string' } } }, null, ['Links'], true]) {
      await assert.rejects(() => openStore(model(through), { driver: nodeDriver() }), (error) => {
        assert.strictEqual(/** @type {any} */ (error).code, 'JD0005');
        assert.strictEqual(/** @type {any} */ (error).docPath, AT);
        assert.strictEqual(/** @type {any} */ (error).message, reason);
        return true;
      }, JSON.stringify(through));
      assert.throws(() => prepareModel(model(through)), { code: 'JD0005', message: reason });
    }
  });

  it('opens a string through as the table it names, and the implicit name without one', async () => {
    for (const [through, table] of [['Links', 'Links'], [undefined, 'Post_Tag']]) {
      const store = await openStore(model(through), { driver: nodeDriver() });
      try {
        await store.entity('Post').create({ pid: 1 });
        await store.entity('Tag').create({ tid: 7 });
        await store.saveChanges();
        assert.deepStrictEqual(await store.execute({ $count: `$.${table}[*]` }), 0);
        assert.deepStrictEqual(Object.keys(explainMapping(model(through)).joinTables), [table]);
      }
      finally { await store.close(); }
    }
  });

  it('plans from a model a history carries one in as before', () => {
    for (const through of [42, { table: 'Links' }, null]) {
      // the implicit table it stood for: no step to the model that leaves it out or names it
      for (const to of [undefined, 'Post_Tag']) {
        assert.deepStrictEqual(planModelMigration(model(through), model(to), { dialect: sqliteDialect, id: 'next' }).migration.steps, [],
          JSON.stringify({ through, to }));
      }
      assert.deepStrictEqual(Object.keys(explainMapping(model(through)).joinTables), ['Post_Tag']);
    }
  });
});
