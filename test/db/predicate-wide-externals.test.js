//@ts-check
/**
 * @file A store profile predicate comparing a member with an external
 * integer past ±(2^53 − 1) keeps the rows the engine keeps. The engine
 * compares the doubles both sides are; a document spells such a double by
 * its shortest digits (2^60 is `1152921504606847000`, 2^60 + 24), which
 * SQLite reads as the exact integer they name, so there the external binds
 * as the integer its own shortest digits spell: the digits the document
 * holds for the same number, which order as the doubles do. A column that
 * holds the double (a `number` member's) compares with the number as it is,
 * and PostgreSQL compares both as the engine does. The statement is the one
 * a safe integer binds, so a seek stays a seek. A store run is SQLite
 * always, PostgreSQL where JAREN_PG_URL names a server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { queryJson } from '@jarenjs/json/query';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const MODEL = {
  $model: '0.1',
  collections: {
    big: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, u: { type: 'integer' }, v: { type: 'integer' }, n: { type: 'number' } } },
      indexes: [{ name: 'by_v', path: '$.v' }, { name: 'by_n', path: '$.n' }],
    },
  },
};
// 2^60 and its neighbouring doubles (the spacing is 128 below it and 256
// above), 2^53 and the one above it, a safe integer, and a negative
const NUMBERS = [2 ** 60 - 128, 2 ** 60, 2 ** 60 + 256, 2 ** 53, 2 ** 53 + 2, 5, -(2 ** 62)];
const DOCS = NUMBERS.map((value, i) => ({ id: `r${i}`, u: value, v: value, n: value }));
const ALL = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' };
/** The ids a predicate keeps, as a `$where` over the documents. @param {any} predicate */
const kept = (predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $orderby: ['$it.id'], $return: '$it.id' });
const OPERATORS = ['$eq', '$ne', '$lt', '$le', '$gt', '$ge'];
// the externals: integers past 2^53 a document spells by digits within the
// 64-bit integers, one past them (2^64), and 2^53 itself
const EXTERNALS = [2 ** 60, 2 ** 60 - 128, 2 ** 53, -(2 ** 62), 2 ** 64];

for (const engine of ENGINES) {
  describe(`a profile predicate's external past 2^53, ${engine}`, { skip: skipFor(engine) }, () => {
    it('keeps the rows the engine keeps, on a member read by its digits and on a column of doubles', async () => {
      await withStore(engine, MODEL, async (store) => {
        const big = store.collection('big');
        for (const doc of DOCS) await big.insert(doc);
        const differ = [];
        for (const member of ['u', 'v', 'n']) {
          for (const op of OPERATORS) {
            const predicate = { [op]: [`$it.${member}`, '$x'] };
            const profile = { externals: ['x'], predicates: { big: predicate } };
            for (const x of EXTERNALS) {
              const expected = queryJson(kept(predicate), DOCS, { x });
              const answered = await big.execute(ALL, { externals: { x }, profile });
              if (JSON.stringify(answered) !== JSON.stringify(expected)) differ.push({ member, op, x, answered, expected });
            }
          }
        }
        assert.deepEqual(differ, []);
        // on SQLite the document's own such external sends the call to the
        // full scan, which binds the predicate's the same way
        const document = kept({ $ge: ['$it.v', '$y'] });
        const both = { externals: { x: 2 ** 60, y: 2 ** 60 }, profile: { externals: ['x', 'y'], predicates: { big: { $eq: ['$it.u', '$x'] } } } };
        assert.equal((await big.explain(document, both)).mode, engine === 'sqlite' ? 'set' : 'native');
        assert.deepEqual(await big.execute(document, both),
          queryJson(kept({ $and: [{ $eq: ['$it.u', '$x'] }, { $ge: ['$it.v', '$y'] }] }), DOCS, both.externals));
        assert.deepEqual(await big.execute(document, both), 'r1');
        // a point read is judged by the engine, as before
        const profile = { externals: ['x'], predicates: { big: { $eq: ['$it.u', '$x'] } } };
        assert.deepEqual(await big.get('r1', { externals: { x: 2 ** 60 }, profile }), DOCS[1]);
      });
    });

    it('binds into the statement a safe integer binds, which still seeks', async () => {
      await withStore(engine, MODEL, async (store) => {
        const big = store.collection('big');
        for (const doc of DOCS) await big.insert(doc);
        const profile = { externals: ['x'], predicates: { big: { $eq: ['$it.v', '$x'] } } };
        const [safe, wide] = await Promise.all([5, 2 ** 60].map((x) => big.explain(ALL, { externals: { x }, profile })));
        assert.equal(wide.sql, safe.sql);
        assert.deepEqual(wide.params, safe.params);
        assert.equal(wide.mode, 'native');
        if (engine === 'sqlite') assert.match(wide.scanNarrative, /SEARCH big USING INDEX big_by_v \(gx_v=\?\)/);
        assert.deepEqual(await big.execute(ALL, { externals: { x: 2 ** 60 }, profile }), 'r1');
      });
    });
  });
}
