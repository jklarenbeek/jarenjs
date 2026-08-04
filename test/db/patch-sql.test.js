//@ts-check
/**
 * @file The patch translator, differentially: for EVERY RFC 6902
 * operation kind, the stored outcome through a real store equals
 * `applyJSONPatch` over the same document — whether the operation
 * translated to JSON-set primitives or fell back to a whole-document
 * write — and the stats counter says which route ran. Plus the
 * translation-decision unit rows (array-versus-object discrimination
 * against the live document) and the measured size argument for
 * translating at all.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { applyJSONPatch } from '@jarenjs/json/patch';
import { openStore, translatePatch, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: { schema: { type: 'object' }, key: '/id', indexes: [] },
  },
};

const BASE = {
  id: 'd1',
  name: 'ada',
  meta: { role: 'dev', '0': 'object-member-called-zero' },
  tags: ['x', 'y'],
  nested: [{ n: 1 }, { n: 2 }],
};

/**
 * Differential rows: [title, ops, expectedRoute]. The expected stored
 * document is always applyJSONPatch(BASE, ops) — never hand-written.
 */
const CASES = /** @type {[string, any[], 'translated' | 'fallback'][]} */ ([
  ['replace an object member', [{ op: 'replace', path: '/name', value: 'lin' }], 'translated'],
  ['replace a nested member', [{ op: 'replace', path: '/meta/role', value: 'ops' }], 'translated'],
  ['replace an array element', [{ op: 'replace', path: '/tags/1', value: 'z' }], 'translated'],
  ['replace inside an array of objects', [{ op: 'replace', path: '/nested/0/n', value: 9 }], 'translated'],
  ['add a new object member', [{ op: 'add', path: '/city', value: 'ams' }], 'translated'],
  ["add at an array's end ('-')", [{ op: 'add', path: '/tags/-', value: 'w' }], 'translated'],
  ['add at the index equal to length', [{ op: 'add', path: '/tags/2', value: 'w' }], 'translated'],
  ["add an object member spelled '0'", [{ op: 'add', path: '/meta/1', value: 'one' }], 'translated'],
  ['remove an object member', [{ op: 'remove', path: '/name' }], 'translated'],
  ['remove an array element (shifts)', [{ op: 'remove', path: '/tags/0' }], 'translated'],
  ['a chain across kinds', [
    { op: 'replace', path: '/name', value: 'lin' },
    { op: 'add', path: '/tags/-', value: 'w' },
    { op: 'remove', path: '/meta/role' },
  ], 'translated'],
  ['sequential appends see the advanced state', [
    { op: 'add', path: '/tags/-', value: 'a' },
    { op: 'add', path: '/tags/3', value: 'b' },
  ], 'translated'],
  ['a mid-array insert shifts: fallback', [{ op: 'add', path: '/tags/0', value: 'first' }], 'fallback'],
  ['move: fallback', [{ op: 'move', from: '/name', path: '/alias' }], 'fallback'],
  ['copy: fallback', [{ op: 'copy', from: '/name', path: '/alias' }], 'fallback'],
  ['test: fallback', [{ op: 'test', path: '/name', value: 'ada' }, { op: 'replace', path: '/name', value: 'lin' }], 'fallback'],
  ['a root replace: fallback', [{ op: 'replace', path: '', value: { id: 'd1', reborn: true } }], 'fallback'],
  ['a member name with an embedded quote: fallback', [{ op: 'add', path: '/we"ird', value: 1 }], 'fallback'],
]);

describe('patch translation, differentially against applyJSONPatch', () => {
  for (const [title, ops, route] of CASES) {
    it(`${title} (${route})`, async () => {
      const store = await openStore(MODEL, { driver: nodeDriver() });
      const docs = store.collection('docs');
      await docs.insert(structuredClone(BASE));
      const expected = applyJSONPatch(structuredClone(BASE), ops);

      const returned = await docs.patch('d1', ops);
      assert.deepStrictEqual(returned, expected, 'patch returns the result');
      assert.deepStrictEqual(await docs.get('d1'), expected, 'the database agrees');

      const stats = docs.stats();
      assert.deepStrictEqual(stats, {
        patchTranslated: route === 'translated' ? 1 : 0,
        patchFallback: route === 'fallback' ? 1 : 0,
      }, 'the route is counted, not assumed');
      await store.close();
    });
  }
});

describe('translation decisions (unit rows)', () => {
  it('null for the untranslatable, a builder otherwise', () => {
    assert.strictEqual(
      translatePatch([{ op: 'move', from: '/a', path: '/b' }], { a: 1 }, sqliteDialect),
      null);
    assert.strictEqual(
      translatePatch([{ op: 'add', path: '/tags/0', value: 'x' }], { tags: ['y'] }, sqliteDialect),
      null, 'mid-array insert');
    assert.strictEqual(
      translatePatch([{ op: 'replace', path: '/tags/nope', value: 'x' }], { tags: ['y'] }, sqliteDialect),
      null, 'a non-numeric segment against an array');
    assert.strictEqual(
      translatePatch([{ op: 'replace', path: '/a/b', value: 1 }], { a: 3 }, sqliteDialect),
      null, 'a scalar mid-path');
    assert.notStrictEqual(
      translatePatch([{ op: 'replace', path: '/a', value: 1 }], { a: 0 }, sqliteDialect),
      null);
  });

  it('builds the nested expression with ordered parameters', () => {
    const translated = translatePatch([
      { op: 'replace', path: '/name', value: 'lin' },
      { op: 'remove', path: '/meta/role' },
      { op: 'add', path: '/tags/-', value: 'w' },
    ], structuredClone(BASE), sqliteDialect);
    const { expression, params } = translated.build('"doc"', 1);
    assert.strictEqual(expression,
      'jsonb_insert('
      + 'jsonb_remove('
      + 'jsonb_set("doc", \'$."name"\', jsonb(?))'
      + ', \'$."meta"."role"\')'
      + ', \'$."tags"[#]\', jsonb(?))');
    assert.deepStrictEqual(params, ['"lin"', '"w"']);
  });

  it('a one-field update ships parameters, not the document (the size argument)', async () => {
    const large = {
      id: 'big',
      blob: Array.from({ length: 400 }, (_, i) => `filler-${i}-${'x'.repeat(48)}`),
      counter: 1,
    };
    const documentBytes = JSON.stringify(large).length;
    const translated = translatePatch(
      [{ op: 'replace', path: '/counter', value: 2 }], large, sqliteDialect);
    const { params } = translated.build('"doc"', 1);
    const shippedBytes = params.reduce((n, p) => n + p.length, 0);
    assert.strictEqual(documentBytes > 20000, true, 'the fixture is genuinely large');
    assert.strictEqual(shippedBytes, 1, 'one digit crosses the wire');
    assert.strictEqual(shippedBytes * 100 < documentBytes, true);

    // and the store route agrees end to end
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const docs = store.collection('docs');
    await docs.insert(large);
    await docs.patch('big', [{ op: 'replace', path: '/counter', value: 2 }]);
    assert.strictEqual((await docs.get('big')).counter, 2);
    assert.deepStrictEqual(docs.stats(), { patchTranslated: 1, patchFallback: 0 });
    await store.close();
  });
});
