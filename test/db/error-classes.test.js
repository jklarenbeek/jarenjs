//@ts-check
/**
 * @file One classification of SQLite driver failures, consulted by
 * every path: the query path no longer leaks a raw driver error (the
 * pushed `SUM` that overflows int64 becomes a coded residual re-run in
 * the engine, answering the double), a locked, read-only, corrupt or
 * unopenable database arrives under a stable `class` with a
 * `retryable` verdict from the write, entity, job, maintenance and
 * open paths alike, the duplicate-key `JD2001` is a row of the same
 * table, and a pushed user function's engine error carries the
 * caller's document path, not the hatch's wrapper path.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore, classifyDriverError, wrapDriverError, DbRuntimeError, sqliteDialect } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { queryJson } from '@jarenjs/json/query';

import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    m: {
      schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' }, s: { type: 'string' } } },
      key: '/id',
      indexes: [{ name: 'by_n', path: '$.n' }],
    },
  },
  entities: {
    Item: {
      schema: { type: 'object', properties: {
        id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'integer' } } },
    },
  },
};

/** A driver over ONE DatabaseSync the test also holds. */
const sharedDriver = (db) => ({ name: 'node-sqlite', dialect: sqliteDialect, open: () => adaptNodeDatabase(db) });

describe('the table', () => {
  it('classes every primary result code the store meets, extended codes by their low byte', () => {
    const cases = [
      [{ errcode: 5, message: 'database is locked' }, 'busy', 'JD2005', true],
      [{ errcode: 261, message: 'database is locked' }, 'busy', 'JD2005', true],
      [{ errcode: 6, message: 'database table is locked' }, 'busy', 'JD2005', true],
      [{ errcode: 13, message: 'database or disk is full' }, 'full', 'JD2082', false],
      [{ errcode: 8, message: 'attempt to write a readonly database' }, 'readonly', 'JD2083', false],
      [{ errcode: 1032, message: 'attempt to write a readonly database' }, 'readonly', 'JD2083', false],
      [{ errcode: 10, message: 'disk I/O error' }, 'io', 'JD2084', false],
      [{ errcode: 3850, message: 'disk I/O error' }, 'io', 'JD2084', false],
      [{ errcode: 11, message: 'database disk image is malformed' }, 'corrupt', 'JD2085', false],
      [{ errcode: 26, message: 'file is not a database' }, 'corrupt', 'JD2085', false],
      [{ errcode: 14, message: 'unable to open database file' }, 'cantopen', 'JD2005', false],
      [{ errcode: 787, message: 'FOREIGN KEY constraint failed' }, 'constraint', 'JD2005', false],
      [{ errcode: 1, message: 'integer overflow' }, 'overflow', null, false],
      [{ errcode: 1, message: 'no such table: nope' }, 'error', 'JD2005', false],
      // bun:sqlite and the wasm build spell the code differently
      [{ errno: 5, code: 'SQLITE_BUSY', message: 'database is locked' }, 'busy', 'JD2005', true],
      [{ resultCode: 11, message: 'database disk image is malformed' }, 'corrupt', 'JD2085', false],
      // a binding that attaches no code at all
      [{ message: 'database is locked' }, 'busy', 'JD2005', true],
    ];
    for (const [error, cls, code, retryable] of cases) {
      const out = classifyDriverError(error);
      assert.deepStrictEqual({ class: out.class, code: out.code, retryable: out.retryable },
        { class: cls, code, retryable }, JSON.stringify(error));
    }
  });

  it('a unique-key collision on the named column is the duplicate row; on another column it stays a constraint', () => {
    const dup = { errcode: 1555, message: 'UNIQUE constraint failed: m.key' };
    assert.strictEqual(classifyDriverError(dup, { table: 'm', column: 'key' }).class, 'duplicate');
    assert.strictEqual(classifyDriverError(dup, { table: 'm', column: 'key' }).code, 'JD2001');
    assert.strictEqual(classifyDriverError(dup).class, 'constraint');
    const other = { errcode: 2067, message: 'UNIQUE constraint failed: m.gx_email' };
    assert.strictEqual(classifyDriverError(other, { table: 'm', column: 'key' }).class, 'constraint',
      'a unique INDEX over another column is a constraint failure, not the key collision');
    const keyed = { errcode: 2067, message: 'UNIQUE constraint failed: m.key' };
    assert.strictEqual(classifyDriverError(keyed, { table: 'm', column: 'key' }).class, 'duplicate');
  });

  it('wrapDriverError attaches class, retryable and cause, keeps a lifecycle code, and passes non-driver errors through', () => {
    const wrapped = wrapDriverError({ errcode: 8, message: 'attempt to write a readonly database' },
      { docPath: '/collections/m', collection: 'm', key: 'k' });
    assert.ok(wrapped instanceof DbRuntimeError);
    assert.strictEqual(wrapped.code, 'JD2083');
    assert.strictEqual(wrapped.class, 'readonly');
    assert.strictEqual(wrapped.retryable, false);
    assert.strictEqual(wrapped.cause.errcode, 8);
    assert.strictEqual(wrapped.collection, 'm');
    const kept = wrapDriverError({ errcode: 11, message: 'malformed' }, { code: 'JD2078' });
    assert.strictEqual(kept.code, 'JD2078');
    assert.strictEqual(kept.class, 'corrupt');
    const coded = new DbRuntimeError('JD2063', 'closed');
    assert.strictEqual(wrapDriverError(coded), coded);
    const engine = Object.assign(new Error('JQ2001: bad at /$where'), { code: 'JQ2001', docPath: '/$where' });
    assert.strictEqual(wrapDriverError(engine), engine);
    const misuse = new TypeError('nope');
    assert.strictEqual(wrapDriverError(misuse), misuse);
  });

  it('exactly one module reads result codes or the overflow text', () => {
    const root = path.resolve('packages/db/src');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(file); continue; }
        if (!entry.name.endsWith('.js') || entry.name === 'errors.js') continue;
        const code = fs.readFileSync(file, 'utf8').split('\n')
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
        if (code.some((line) => /\berrcode\b|\berrno\b|\bresultCode\b|integer overflow|UNIQUE constraint/.test(line)))
          offenders.push(path.relative(root, file));
      }
    };
    walk(root);
    assert.deepStrictEqual(offenders, []);
  });
});

describe('the query path', () => {
  it('a pushed SUM past int64 answers the engine\'s double as a coded residual, and explain records the fallback', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const m = store.collection('m');
    await m.insert({ id: 'a', n: 2 ** 62 });
    await m.insert({ id: 'b', n: 2 ** 62 });
    const document = { $sum: { $for: { it: '$[*]' }, $return: '$it.n' } };
    const engine = queryJson(document, [{ n: 2 ** 62 }, { n: 2 ** 62 }]);
    assert.strictEqual(engine, 9223372036854776000);
    assert.strictEqual(await m.execute(document), engine);
    assert.strictEqual(await m.execute(document, { pushdown: false }), engine);
    const explained = await m.explain(document);
    assert.strictEqual(explained.mode, 'native', 'the plan still pushes the aggregate');
    assert.deepStrictEqual(explained.fallback, {
      construct: 'overflow', runs: 1,
      reason: 'the pushed aggregate overflowed int64; the engine answered the document over the fetched rows',
    });
    // the cursor form answers the same single item
    const items = [];
    for await (const item of m.query(document)) items.push(item);
    assert.deepStrictEqual(items, [engine]);
    assert.strictEqual((await m.explain(document)).fallback.runs, 2);
    // a document that never overflowed records no fallback
    assert.strictEqual((await m.explain({ $count: { $for: { it: '$[*]' }, $return: '$it' } })).fallback, null);
    await store.close();
  });

  it('a corrupt page met by a query arrives as JD2085 corrupt, never a raw driver error', async () => {
    const source = tempDbPath();
    const copy = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: source.dbPath });
      for (let i = 0; i < 300; i++) await store.collection('m').insert({ id: `k${i}`, n: i, s: 'x'.repeat(300) });
      await store.checkpoint({ mode: 'truncate' });
      await store.close();
      fs.copyFileSync(source.dbPath, copy.dbPath);
      // page 1 (the schema) stays intact so the store opens; the root
      // page of the table gets an impossible header, which every read of
      // the table meets as SQLITE_CORRUPT
      const fd = fs.openSync(copy.dbPath, 'r+');
      fs.writeSync(fd, Buffer.alloc(8, 0xff), 0, 8, 4096);
      fs.closeSync(fd);
      const corrupted = await openStore(MODEL, { driver: nodeDriver(), path: copy.dbPath });
      const rows = corrupted.collection('m');
      const read = async () => {
        const out = [];
        for await (const row of rows.query({ $for: { it: '$[*]' }, $return: '$it' })) out.push(row);
        return out;
      };
      await assert.rejects(read(), (error) => error.code === 'JD2085' && error.class === 'corrupt'
        && error.retryable === false && error.cause?.errcode === 11);
      // a synchronous driver's execute throws synchronously: the async
      // function is what turns that into a rejection to assert on
      await assert.rejects(async () => rows.execute({ $for: { it: '$[*]' }, $return: '$it' }),
        (error) => error.code === 'JD2085' && error.class === 'corrupt');
      await corrupted.close();
    }
    finally {
      source.cleanup();
      copy.cleanup();
    }
  });

  it('a pushed user function\'s engine error names the caller\'s path in both modes', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const m = store.collection('m');
    await m.insert({ id: 'a', n: 7 });
    const single = { $for: { it: '$[*]' }, $where: { $match: ['$it.n', 'x'] }, $return: '$it' };
    assert.deepStrictEqual((await m.explain(single)).udfs.length, 1, 'the conjunct rides the hatch');
    // execute on a synchronous driver throws synchronously; the async
    // function turns that into the rejection to assert on
    for (const options of [undefined, { pushdown: false }]) {
      await assert.rejects(async () => m.execute(single, options),
        (error) => error.code === 'JQ2001' && error.docPath === '/$where/$match/0'
          && error.message.endsWith(' at /$where/$match/0'), JSON.stringify(options));
    }
    const conjoined = { $for: { it: '$[*]' },
      $where: { $and: [{ $gt: ['$it.n', 0] }, { $match: ['$it.n', 'x'] }] }, $return: '$it' };
    for (const options of [undefined, { pushdown: false }]) {
      await assert.rejects(async () => m.execute(conjoined, options),
        (error) => error.code === 'JQ2001' && error.docPath === '/$where/$and/1/$match/0', JSON.stringify(options));
    }
    // one registration serves both documents: the mount rides the call
    assert.strictEqual(store.stats().udfRegistrations, 1);
    await store.close();
  });
});

describe('the write, entity, job, maintenance and open paths', () => {
  it('a locked database is JD2005 class busy, retryable, from the collection, entity and job paths', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, busyTimeout: 30, jobs: true });
      const holder = new DatabaseSync(dbPath);
      holder.exec('BEGIN EXCLUSIVE');
      const expectBusy = (error) => error.code === 'JD2005' && error.class === 'busy'
        && error.retryable === true && error.cause?.errcode !== undefined;
      await assert.rejects(store.collection('m').insert({ id: 'x', n: 1 }), expectBusy);
      await assert.rejects(store.entity('Item').create({ id: 'i1', n: 1 }), expectBusy);
      await assert.rejects(store.jobs.enqueue('kind', {}), expectBusy);
      holder.exec('ROLLBACK');
      holder.close();
      assert.strictEqual(await store.collection('m').insert({ id: 'x', n: 1 }), 'x');
      await store.close();
    }
    finally {
      cleanup();
    }
  });

  it('a read-only database is JD2083 class readonly from the collection and entity paths', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const writer = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      await writer.close();
      const reader = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, readOnly: true });
      const expectReadonly = (error) => error.code === 'JD2083' && error.class === 'readonly'
        && error.retryable === false;
      await assert.rejects(reader.collection('m').insert({ id: 'x', n: 1 }), expectReadonly);
      await assert.rejects(reader.entity('Item').create({ id: 'i1', n: 1 }), expectReadonly);
      await reader.close();
    }
    finally {
      cleanup();
    }
  });

  it('a duplicate key is still JD2001 from both write paths, unchanged', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.collection('m').insert({ id: 'a', n: 1 });
    await assert.rejects(store.collection('m').insert({ id: 'a', n: 2 }),
      (error) => error.code === 'JD2001' && error.class === 'duplicate' && error.key === 'a');
    await store.entity('Item').create({ id: 'i', n: 1 });
    await assert.rejects(store.entity('Item').create({ id: 'i', n: 2 }),
      (error) => error.code === 'JD2001' && error.class === 'duplicate');
    await store.close();
  });

  it('a maintenance failure keeps JD2078 and carries the class', async () => {
    const db = new DatabaseSync(':memory:');
    const store = await openStore(MODEL, { driver: sharedDriver(db) });
    db.close();
    await assert.rejects(store.integrityCheck(),
      (error) => error.code === 'JD2078' && typeof error.class === 'string' && error.cause instanceof Error);
  });

  it('a driver error during open is JD0002 carrying class and retryable', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      fs.writeFileSync(dbPath, 'this is a file, not a directory');
      await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: path.join(dbPath, 'child.db') }),
        (error) => error.code === 'JD0002' && error.class === 'cantopen' && error.retryable === false
          && error.cause?.errcode === 14);
      // a corrupt file met by the shape probe is the same code, classed
      fs.writeFileSync(dbPath, Buffer.alloc(8192, 0x7f));
      await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: dbPath }),
        (error) => error.code === 'JD0002' && error.class === 'corrupt');
    }
    finally {
      cleanup();
    }
  });
});

describe('the paths beside the query engines (the close-out quirk hunt)', () => {
  const ENTITIES = {
    $model: '0.1',
    collections: MODEL.collections,
    entities: MODEL.entities,
  };

  /** A store on a corrupt copy: the collection's root page overwritten. */
  async function corruptCopy(options = {}) {
    const source = tempDbPath();
    const copy = tempDbPath();
    const store = await openStore(ENTITIES, { driver: nodeDriver(), path: source.dbPath, ...options });
    for (let i = 0; i < 300; i++) await store.collection('m').insert({ id: `k${i}`, n: i, s: 'x'.repeat(300) });
    for (let i = 0; i < 300; i++) await store.entity('Item').create({ id: `i${i}`, n: i });
    await store.checkpoint({ mode: 'truncate' });
    await store.close();
    fs.copyFileSync(source.dbPath, copy.dbPath);
    return { source, copy };
  }
  const corruptPage = (file, page) => {
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.alloc(8, 0xff), 0, 8, 4096 * (page - 1));
    fs.closeSync(fd);
  };
  const rootPageOf = (file, table) => {
    const db = new DatabaseSync(file, { readOnly: true });
    const page = Number(db.prepare('SELECT rootpage FROM sqlite_schema WHERE name = ?').get(table).rootpage);
    db.close();
    return page;
  };

  it('a point read and every captured write arrive classed, never raw', async () => {
    const { source, copy } = await corruptCopy({ capture: { log: true } });
    try {
      corruptPage(copy.dbPath, rootPageOf(copy.dbPath, 'm'));
      const store = await openStore(ENTITIES, { driver: nodeDriver(), path: copy.dbPath, capture: { log: true } });
      const m = store.collection('m');
      const corrupt = (error) => error.code === 'JD2085' && error.class === 'corrupt' && error.cause?.errcode === 11;
      await assert.rejects(m.get('k1'), (error) => corrupt(error) && error.collection === 'm' && error.key === 'k1');
      await assert.rejects(m.insert({ id: 'zz', n: 1 }), corrupt);
      await assert.rejects(m.put({ id: 'k1', n: 1 }), corrupt);
      await assert.rejects(m.patch('k1', [{ op: 'replace', path: '/n', value: 2 }]), corrupt);
      await assert.rejects(m.delete('k1'), corrupt);
      // the change reader over an intact log still answers
      assert.strictEqual(typeof (await store.changes.bounds()).highWatermark, 'number');
      await store.close();
    }
    finally {
      source.cleanup();
      copy.cleanup();
    }
  });

  it('the change reader over a corrupt change log arrives classed', async () => {
    const { source, copy } = await corruptCopy({ capture: { log: true } });
    try {
      corruptPage(copy.dbPath, rootPageOf(copy.dbPath, '_jaren_changes'));
      const store = await openStore(ENTITIES, { driver: nodeDriver(), path: copy.dbPath, capture: { log: true } });
      const corrupt = (error) => error.code === 'JD2085' && error.class === 'corrupt' && error.docPath === '/capture';
      await assert.rejects(store.changes.bounds(), corrupt);
      await assert.rejects(store.changes.page({ after: 0 }), corrupt);
      await assert.rejects(store.changesSince(0), corrupt);
      await store.close();
    }
    finally {
      source.cleanup();
      copy.cleanup();
    }
  });

  it('an entity read over a corrupt entity table arrives classed', async () => {
    const { source, copy } = await corruptCopy();
    try {
      corruptPage(copy.dbPath, rootPageOf(copy.dbPath, 'Item'));
      const store = await openStore(ENTITIES, { driver: nodeDriver(), path: copy.dbPath });
      await assert.rejects(store.entity('Item').get('i1'),
        (error) => error.code === 'JD2085' && error.class === 'corrupt' && error.collection === 'Item');
      await assert.rejects(store.entity('Item').load({}), (error) => error.code === 'JD2085');
      await store.close();
    }
    finally {
      source.cleanup();
      copy.cleanup();
    }
  });
});
