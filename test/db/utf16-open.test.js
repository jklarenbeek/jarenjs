//@ts-check
/**
 * @file The text encoding of a SQLite file, checked when a store opens. Every
 * native text comparison, order and page assumes SQLite's BINARY collation is
 * code point order, which only a UTF-8 file makes true: over a UTF-16 file
 * `$lt` against U+FFFD answered an astral character the engine excludes, and
 * an ordered load put `Ā, U+E000, 😀` before `a, z`. Opening such a file is
 * refused (`JD0002`) and the connection it opened is closed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const MODEL = { $model: '0.1', entities: { T: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, s: { type: 'string' } } } } } };
const WORDS = ['z', 'a', 'Ā', '', '\u{1F600}'];

/** A file whose text encoding is `encoding`. @param {string} dbPath @param {string} encoding */
function fileIn(dbPath, encoding) {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`PRAGMA encoding = '${encoding}'; CREATE TABLE _fixture(a)`);
  assert.equal(/** @type {any} */ (raw.prepare('PRAGMA encoding').get()).encoding, encoding);
  raw.close();
}

describe('a store opened over a SQLite file checks its text encoding', () => {
  for (const encoding of ['UTF-16le', 'UTF-16be']) {
    it(`a ${encoding} file is refused JD0002, as a plain, an adopted and a read-only store`, async () => {
      const { dbPath, cleanup } = tempDbPath();
      try {
        fileIn(dbPath, encoding);
        const expected = { code: 'JD0002', message: new RegExp(`a store compares and orders text by code point, which a ${encoding} database does not; use a UTF-8 database`) };
        await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: dbPath }), expected);
        await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: dbPath, adopt: true }), expected);
        await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: dbPath, readOnly: true }), expected);
      }
      finally { cleanup(); }
    });
  }

  it('the refused open closes the connection it opened', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      fileIn(dbPath, 'UTF-16le');
      const driver = nodeDriver();
      let closes = 0;
      let opens = 0;
      const recording = { ...driver, open: async (/** @type {any[]} */ ...args) => {
        opens++;
        const connection = await /** @type {any} */ (driver.open)(...args);
        return Object.create(connection, { close: { value: (/** @type {any[]} */ ...rest) => { closes++; return connection.close(...rest); } } });
      } };
      await assert.rejects(openStore(MODEL, { driver: recording, path: dbPath }), { code: 'JD0002' });
      assert.equal(opens, 1);
      assert.equal(closes, 1);
    }
    finally { cleanup(); }
  });

  it('the refusal comes before the owner lease: the file is left as it was', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      fileIn(dbPath, 'UTF-16le');
      await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: dbPath, owner: { id: 'first', leaseMs: 1000 } }), { code: 'JD0002', message: /UTF-16le database/ });
      const raw = new DatabaseSync(dbPath);
      try {
        const names = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
        assert.deepEqual(names, ['_fixture']);
      }
      finally { raw.close(); }
    }
    finally { cleanup(); }
  });

  it('an in-memory database switched to UTF-16 before the open is refused the same way', async () => {
    const connection = await nodeDriver().open(':memory:');
    connection.exec("PRAGMA encoding = 'UTF-16le'");
    await assert.rejects(openStore(MODEL, { driver: { ...nodeDriver(), open: async () => connection } }),
      { code: 'JD0002', message: /UTF-16le database/ });
  });

  it('a UTF-8 file opens and orders and compares text by code point', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      fileIn(dbPath, 'UTF-8');
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try {
        let id = 0;
        for (const s of WORDS) await store.entity('T').create({ id: ++id, s });
        assert.deepEqual((await store.entity('T').load({ orderBy: '$it.s' })).map((row) => row.s), ['a', 'z', 'Ā', '', '\u{1F600}']);
        assert.deepEqual((await store.entity('T').load({ where: { $lt: ['$it.s', '�'] } })).map((row) => row.s).sort(), ['a', 'z', 'Ā', ''].sort());
      }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });
});
