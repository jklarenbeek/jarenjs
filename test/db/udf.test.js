//@ts-check
/**
 * @file The deterministic-function hatch (D9): a conjunct with no
 * native spelling rides a registered WHERE-clause function when — and
 * only when — the capability exists and the fragment is provably
 * deterministic (no externals, no host functions, no collations).
 * Identical fragments share one registration; the planner stays
 * CORRECT with the capability disabled (the Bun adapter, which has no
 * UDF hatch by construction, answers the same documents through the
 * set residual).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileJsonQuery } from '@jarenjs/json/query';
import { openStore, deterministicFragment, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { fromBunModule } from '@jarenjs/db/bun';

import { BunShapedDatabase } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, name: { type: 'string' }, age: { type: 'integer' } } },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }],
    },
  },
};
const DATA = [
  { id: 'a', name: 'ada', age: 36 },
  { id: 'b', name: 'kid', age: 8 },
  { id: 'c', name: 'anna', age: 30 },
  { id: 'd' },
];
// $match has no native spelling: the natural hatch candidate
const MATCH_DOC = {
  $for: { it: '$[*]' },
  $where: { $and: [{ $gt: ['$it.age', 10] }, { $match: ['$it.name', 'a.*'] }] },
  $return: '$it',
};

const seed = async (store) => {
  for (const row of DATA) await store.collection('users').insert(row);
};

describe('the hatch on a capable driver', () => {
  it('promotes the conjunct: no residual, the function named by explain()', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await seed(store);
    const users = store.collection('users');

    const actual = await Promise.resolve(users.execute(MATCH_DOC));
    const expected = compileJsonQuery(MATCH_DOC)(structuredClone(DATA));
    assert.deepStrictEqual(actual, expected);

    const explanation = await users.explain(MATCH_DOC);
    assert.strictEqual(explanation.residual, null,
      'the hatch made the whole plan native');
    assert.strictEqual(explanation.udfs.length, 1);
    assert.match(explanation.udfs[0], /^jaren_p_/);
    assert.match(explanation.sql, new RegExp(`${explanation.udfs[0]}\\(json\\("doc"\\)\\)`));
    // and strict mode ACCEPTS it — nothing runs outside the database
    const strict = await Promise.resolve(users.execute(MATCH_DOC, { strict: true }));
    assert.deepStrictEqual(strict, expected);
    await store.close();
  });

  it('identical fragments share one registration across documents', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await seed(store);
    const users = store.collection('users');
    await users.execute(MATCH_DOC);
    assert.strictEqual(store.stats().udfRegistrations, 1);
    // a different document carrying the SAME fragment re-uses it
    const reordered = {
      $for: { it: '$[*]' },
      $where: { $and: [{ $match: ['$it.name', 'a.*'] }, { $gt: ['$it.age', 0] }] },
      $return: '$it.id',
    };
    await users.execute(reordered);
    assert.strictEqual(store.stats().udfRegistrations, 1,
      'contentKey-shared registration');
    // a different fragment registers separately
    await users.execute({
      $for: { it: '$[*]' },
      $where: { $match: ['$it.name', '.*nn.*'] },
      $return: '$it.id',
    });
    assert.strictEqual(store.stats().udfRegistrations, 2);
    await store.close();
  });

  it('a fragment referencing an external is NOT deterministic and never registers', async () => {
    assert.strictEqual(
      deterministicFragment({ $match: ['$it.name', '$pat'] }), null);
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await seed(store);
    const users = store.collection('users');
    const document = {
      $for: { it: '$[*]' },
      $where: { $match: ['$it.name', '$pat'] },
      $return: '$it.id',
    };
    const actual = await Promise.resolve(
      users.execute(document, { externals: { pat: 'a.*' } }));
    const expected = compileJsonQuery(document)(structuredClone(DATA), { pat: 'a.*' });
    assert.deepStrictEqual(actual, expected);
    assert.strictEqual(store.stats().udfRegistrations, 0);
    const explanation = await users.explain(document, { externals: { pat: 'a.*' } });
    assert.strictEqual(explanation.residual.mode, 'set');
    await store.close();
  });

  it('a qualified fragment answers 1/0 over the row document', () => {
    const fragment = deterministicFragment({ $match: ['$it.name', 'a.*'] });
    assert.notStrictEqual(fragment, null);
    const predicate = fragment.compile();
    assert.strictEqual(predicate(JSON.stringify({ name: 'ada' })), 1);
    assert.strictEqual(predicate(JSON.stringify({ name: 'kid' })), 0);
    assert.strictEqual(predicate(JSON.stringify({})), 0);
    assert.strictEqual(sqliteDialect.jsonText('"doc"'), 'json("doc")',
      'the hatch call site reads the doc as text');
  });
});

describe('the planner is correct WITHOUT the capability', () => {
  it('the Bun adapter (no UDF hatch by construction) answers through the residual', async () => {
    const bunLike = {
      name: 'bun-adapter',
      dialect: sqliteDialect,
      open: (path) => fromBunModule({ Database: BunShapedDatabase }, path),
    };
    const store = await openStore(MODEL, { driver: bunLike });
    assert.strictEqual(store.capabilities.userFunctions, false);
    await seed(store);
    const users = store.collection('users');

    const actual = await Promise.resolve(users.execute(MATCH_DOC));
    const expected = compileJsonQuery(MATCH_DOC)(structuredClone(DATA));
    assert.deepStrictEqual(actual, expected, 'same answer, no hatch');

    const explanation = await users.explain(MATCH_DOC);
    assert.strictEqual(explanation.residual.mode, 'set');
    assert.deepStrictEqual(explanation.udfs, []);
    assert.strictEqual(store.stats().udfRegistrations, 0);
    // and strict mode refuses, naming the construct
    await assert.rejects(
      async () => users.execute(MATCH_DOC, { strict: true }),
      (error) => {
        assert.strictEqual(error.code, 'JD0010');
        assert.match(error.message, /\$match/);
        return true;
      });
    await store.close();
  });
});

// The hatch reads the caller's fragment, which references the caller's
// binding. Wrapping it under a name the document never chose makes every
// reference read as an external — and the determinism rule then rejects
// the fragment. That failure is SILENT: no error, no reason in
// `explain()`, just a capability that quietly is not there.
describe('the hatch under a binding the document named itself', () => {
  const MATCH_AS = (/** @type {string} */ name) => ({
    $for: { [name]: '$[*]' },
    $where: { $and: [{ $gt: [`$${name}.age`, 10] }, { $match: [`$${name}.name`, 'a.*'] }] },
    $return: `$${name}`,
  });

  for (const name of ['it', 'user', 'row']) {
    it(`promotes the conjunct when the binding is '${name}'`, async () => {
      const store = await openStore(MODEL, { driver: nodeDriver() });
      await seed(store);
      const users = store.collection('users');
      const document = MATCH_AS(name);

      const actual = await Promise.resolve(users.execute(document));
      assert.deepStrictEqual(actual, compileJsonQuery(document)(structuredClone(DATA)));

      const explanation = await users.explain(document);
      assert.strictEqual(explanation.udfs.length, 1,
        'the hatch engages whatever the binding is called');
      assert.strictEqual(explanation.residual, null);
      await store.close();
    });
  }

  it('keys two bindings of the same predicate as two fragments', async () => {
    // the fragment text carries the binding, so the identities differ —
    // sharing one registration would run the wrong predicate
    const a = deterministicFragment({ $match: ['$it.name', 'a.*'] }, null, 'it');
    const b = deterministicFragment({ $match: ['$user.name', 'a.*'] }, null, 'user');
    assert.notStrictEqual(a, null);
    assert.notStrictEqual(b, null);
    assert.notStrictEqual(a?.key, b?.key);
  });

  it('still refuses a fragment with a real external, under any binding', async () => {
    assert.strictEqual(
      deterministicFragment({ $match: ['$user.name', '$pat'] }, null, 'user'), null,
      'an external is not deterministic no matter what the binding is called');
  });
});
