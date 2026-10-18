//@ts-check
/**
 * @file SQLite converts a JSON number it does not hold as an integer (a
 * fraction, an exponent, an integer past the 64-bit ones) to a double by its
 * own conversion, which keeps the significant digits that fit its 64-bit
 * accumulator (19 or 20) and drops the rest, where the engine (`JSON.parse`)
 * rounds every digit. A decimal another writer spelled past those digits and
 * just past a tie between two doubles therefore reads in SQL as the double
 * nearer zero: a native read, comparison, ordering or grouping of the member
 * sees that double, and a document read whole is the engine's. The README's
 * "Two backends, frankly" documents the loss; these pin it on node:sqlite and
 * the wasm build (Bun in its own file), and fail once a build rounds every
 * digit — then narrow that documentation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DatabaseSync } from 'node:sqlite';
import init from '@sqlite.org/sqlite-wasm';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { tempDbPath } from './helpers.js';
import { conversionReport, convertedByJson, nearTies } from './sqlite-decimal-cases.js';

const TEXTS = nearTies(300);
const CONVERTED = TEXTS.filter(convertedByJson);
const GONE = 'this SQLite build rounds every digit of a decimal: narrow the README\'s "Two backends, frankly" row and its ARCHITECTURE paragraph';

/** The summary a host's reading must match: the loss is there, described exactly, and toward zero alone.
 * @param {ReturnType<typeof conversionReport>} report */
const assertDescribed = (report) => {
  assert.ok(report.differ > 0, GONE);
  assert.deepEqual({ notDescribed: report.notDescribed, notNeighbour: report.notNeighbour, keptAllYetDiffer: report.keptAllYetDiffer },
    { notDescribed: [], notNeighbour: [], keptAllYetDiffer: [] });
};

describe('SQLite reads a decimal past the digits it keeps as the double nearer zero', () => {
  it('on node:sqlite, by CAST and by jsonb_extract alike', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const cast = db.prepare('SELECT CAST(? AS REAL) AS "v"');
      const extract = db.prepare('SELECT jsonb_extract(jsonb(?), \'$\') AS "v"');
      assertDescribed(conversionReport(TEXTS, TEXTS.map((text) => cast.get(text)?.v)));
      assertDescribed(conversionReport(CONVERTED, CONVERTED.map((text) => extract.get(text)?.v)));
      // the two the documentation names: just past the tie between 2^60 and 2^60 + 256, and between 2^53 and 2^53 + 2
      assert.deepEqual(['1152921504606847104.0000000000000001', '9007199254740993.0000000000000001'].map((text) => [cast.get(text)?.v, JSON.parse(text)]),
        [[2 ** 60, 2 ** 60 + 256], [2 ** 53, 2 ** 53 + 2]], GONE);
    }
    finally { db.close(); }
  });

  it('on the wasm build', async () => {
    const sqlite3 = await init();
    const db = new sqlite3.oo1.DB(':memory:');
    try {
      assertDescribed(conversionReport(TEXTS, TEXTS.map((text) => db.selectValue('SELECT CAST(? AS REAL)', [text]))));
    }
    finally { db.close(); }
  });
});

describe('a store over a decimal another writer spelled just past a tie', () => {
  it('reads the document whole as the engine does, and the member in SQL as the double nearer zero', async () => {
    const model = { $model: '0.1', collections: { t: { key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'number' }, m: { type: 'number' } } },
      indexes: [{ name: 'by_n', path: '$.n' }] } } };
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(model, { driver: nodeDriver(), path: dbPath });
      try {
        const t = store.collection('t');
        await t.insert({ id: 'a', n: 2 ** 60, m: 2 ** 60 });
        await t.insert({ id: 'b', n: 2 ** 60 + 256, m: 2 ** 60 + 256 });
        const raw = new DatabaseSync(dbPath);
        try {
          const text = '1152921504606847104.0000000000000001';
          raw.prepare('INSERT INTO "t" ("key", "doc") VALUES (?, jsonb(?))').run('f', `{"id":"f","n":${text},"m":${text}}`);
        }
        finally { raw.close(); }
        assert.deepEqual(await t.get('f'), { id: 'f', n: 2 ** 60 + 256, m: 2 ** 60 + 256 });
        const whole = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' };
        assert.deepEqual(await t.execute(whole), await t.execute(whole, { pushdown: false }));
        for (const member of ['n', 'm']) {
          const projected = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: `$it.${member}` };
          const equal = { $for: { it: '$[*]' }, $where: { $eq: [`$it.${member}`, 2 ** 60 + 256] }, $orderby: ['$it.id'], $return: '$it.id' };
          assert.equal((await t.explain(projected)).mode, 'native');
          assert.equal((await t.explain(equal)).mode, 'native');
          assert.deepEqual([await t.execute(projected), await t.execute(projected, { pushdown: false })],
            [[2 ** 60, 2 ** 60 + 256, 2 ** 60], [2 ** 60, 2 ** 60 + 256, 2 ** 60 + 256]], `${member}: ${GONE}`);
          assert.deepEqual([[await t.execute(equal)].flat(), await t.execute(equal, { pushdown: false })], [['b'], ['b', 'f']], `${member}: ${GONE}`);
        }
      }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });
});
