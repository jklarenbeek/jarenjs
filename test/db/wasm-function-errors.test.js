//@ts-check
/**
 * @file An exception thrown inside a function the hatch registers reaches
 * the caller as itself on the wasm host, as it does on `node:sqlite`: one
 * query raises one code on both.
 */
import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';

/** @type {any} */
let sqlite3 = null;
before(async () => { sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} }); });

const DOCS = [{ id: 'a', mx: 'ada' }, { id: 'c', mx: 7 }];
const MODEL = { $model: '0.1', collections: { rows: {
  schema: { type: 'object', properties: { id: { type: 'string' }, mx: { type: ['string', 'integer'] } } },
  key: '/id' } } };
const QUERY = { $for: { it: '$[*]' }, $where: { '$starts-with': ['$it.mx', 'ad'] }, $return: '$it.id' };

/** @param {() => any} driver @param {(rows: any) => Promise<void>} run */
async function withRows(driver, run) {
  const store = await openStore(MODEL, { driver: driver() });
  try {
    const rows = store.collection('rows');
    for (const doc of DOCS) await rows.insert(doc);
    await run(rows);
  }
  finally { await store.close(); }
}

describe('a registered function that raises, on each host', () => {
  const hosts = /** @type {[string, () => any][]} */ ([
    ['node:sqlite', () => nodeDriver()],
    ['wasm', () => wasmDriver(sqlite3Handle(sqlite3))],
  ]);
  for (const [name, driver] of hosts) {
    it(`${name}: a string operator over a stored number raises JQ2001 through execute`, () => withRows(driver, async (rows) => {
      const expected = { code: 'JQ2001', message: 'JQ2001: expected a string, got a number at /$where/$starts-with/0' };
      await assert.rejects(async () => rows.execute(QUERY), expected);
      await assert.rejects(async () => rows.execute(QUERY, { pushdown: undefined }), expected);
      assert.equal(await rows.execute({ ...QUERY, $where: { '$starts-with': ['$it.id', 'a'] } }), 'a');
    }));
  }

  it('the wasm adapter throws the function\'s own exception, not a result-code error', async () => {
    const db = new sqlite3.oo1.DB(':memory:');
    const { adaptOo1Database } = await import('@jarenjs/db/wasm');
    const raw = adaptOo1Database(sqlite3, db);
    const own = new RangeError('mine');
    raw.registerFunction('boom', {}, () => { throw own; });
    raw.exec('CREATE TABLE t(x)');
    raw.exec('INSERT INTO t VALUES (1)');
    for (const call of [
      () => raw.exec('SELECT boom(x) FROM t'),
      () => raw.prepare('SELECT boom(x) FROM t').get(),
      () => raw.prepare('SELECT boom(x) FROM t').all(),
      () => raw.prepare('SELECT boom(x) FROM t').run(),
      () => raw.prepare('SELECT boom(x) FROM t').iterate().next(),
    ]) assert.throws(call, (e) => e === own);
    assert.throws(() => raw.exec('SELECT * FROM missing'), (e) => e !== own && /missing/.test(e.message));
    assert.deepEqual(raw.prepare('SELECT x FROM t').all(), [{ x: 1 }]);
    raw.close();
  });
});
