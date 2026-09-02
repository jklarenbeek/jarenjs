//@ts-check
/**
 * @file The closed pragma configuration and its read-back: every
 * supported connection pragma is an `openStore` option, an option
 * naming any other pragma is a coded refusal, a pragma the driver or
 * the store kind cannot apply is refused rather than skipped, and the
 * capability report carries the values the connection reads back —
 * proven with a binding that lies about what it applied.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore, PRAGMA_NAMES, sqliteDialect } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { wasmDriver } from '@jarenjs/db/wasm';
import {
  PRAGMAS, resolvePragmaRequests, refuseUnsupportedPragmaKeys,
} from '../../packages/db/src/pragmas.js';

import { declaringWasmHandle, tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } } },
      key: '/id',
    },
  },
};

/** A driver over ONE DatabaseSync the test also holds, so a per-connection
 * pragma can be read on the very connection the store configured. */
function sharedDriver(db) {
  return {
    name: 'node-sqlite',
    dialect: sqliteDialect,
    open: () => adaptNodeDatabase(db),
  };
}

/**
 * A wasm-shaped handle over `node:sqlite` whose `PRAGMA <name>` read
 * answers what the caller says instead of the engine — a binding that
 * applied nothing and claims otherwise, or the reverse.
 * @param {Record<string, any>} lies - pragma name → the row the read answers
 * @param {any} [declares]
 */
function lyingHandle(lies, declares = undefined) {
  return {
    synchronous: true,
    declares,
    open: (dbPath) => {
      const db = new DatabaseSync(dbPath);
      return {
        exec: (sql) => db.exec(sql),
        prepare: (sql) => {
          const match = /^PRAGMA ([a-z_]+)$/.exec(sql);
          if (match !== null && Object.hasOwn(lies, match[1])) {
            const row = lies[match[1]];
            return { run: () => ({}), get: () => row, all: () => [row], iterate: () => [row][Symbol.iterator]() };
          }
          const statement = db.prepare(sql);
          return {
            run: (params = []) => statement.run(...params),
            get: (params = []) => statement.get(...params),
            all: (params = []) => statement.all(...params),
            iterate: (params = []) => statement.iterate(...params),
          };
        },
        close: () => db.close(),
        registerFunction: (name, options, fn) => db.function(name, options, fn),
      };
    },
  };
}

describe('the closed pragma table', () => {
  it('names eight options, in application order, and is frozen', () => {
    assert.deepStrictEqual([...PRAGMA_NAMES], ['busyTimeout', 'journalMode', 'synchronous',
      'walAutocheckpoint', 'journalSizeLimit', 'cacheSize', 'mmapSize', 'tempStore']);
    assert.ok(Object.isFrozen(PRAGMA_NAMES));
    assert.ok(Object.isFrozen(PRAGMAS));
    for (const name of PRAGMA_NAMES) assert.ok(Object.isFrozen(PRAGMAS[name]), name);
  });

  it('resolves the two defaults and normalizes every explicit value', () => {
    const file = { memory: false, readOnly: false };
    assert.deepStrictEqual([...resolvePragmaRequests({}, file)],
      [['busyTimeout', { value: 5000, explicit: false }], ['journalMode', { value: 'wal', explicit: false }]]);
    const requests = resolvePragmaRequests({
      busyTimeout: 250, journalMode: 'DELETE', synchronous: 'Normal', walAutocheckpoint: 0,
      journalSizeLimit: -1, cacheSize: -8000, mmapSize: 1048576, tempStore: 'MEMORY',
    }, file);
    assert.deepStrictEqual([...requests].map(([name, r]) => [name, r.value]), [
      ['busyTimeout', 250], ['journalMode', 'delete'], ['synchronous', 'normal'],
      ['walAutocheckpoint', 0], ['journalSizeLimit', -1], ['cacheSize', -8000],
      ['mmapSize', 1048576], ['tempStore', 'memory']]);
    assert.ok([...requests.values()].every((r) => r.explicit === true));
  });

  it('refuses a value outside a pragma\'s closed set or integer bound before any SQL exists', () => {
    const file = { memory: false, readOnly: false };
    for (const bad of [
      { synchronous: 'bogus' }, { synchronous: 1 }, { tempStore: 'disk' },
      { journalMode: 'wal; DROP TABLE x' }, { busyTimeout: -1 }, { busyTimeout: 1.5 },
      { busyTimeout: '5000' }, { walAutocheckpoint: -1 }, { journalSizeLimit: -2 },
      { mmapSize: -1 }, { cacheSize: Number.NaN }, { cacheSize: 2 ** 40 },
    ]) {
      assert.throws(() => resolvePragmaRequests(bad, file), TypeError, JSON.stringify(bad));
    }
  });

  it('JD0006: an option naming a pragma outside the set is refused by name', () => {
    for (const [key, fragment] of [
      ['page_size', 'does not configure'], ['pageSize', 'does not configure'],
      ['foreign_keys', 'requires ON'], ['foreignKeys', 'requires ON'],
      ['journal_mode', "spelled 'journalMode'"], ['wal_autocheckpoint', "spelled 'walAutocheckpoint'"],
      ['locking_mode', 'does not configure'],
    ]) {
      assert.throws(() => refuseUnsupportedPragmaKeys({ [key]: 1 }),
        (error) => error.code === 'JD0006' && error.message.includes(`'${key}'`)
          && error.message.includes(fragment), key);
    }
    // the store's own members are not pragmas and pass untouched
    assert.doesNotThrow(() => refuseUnsupportedPragmaKeys(
      { driver: {}, path: 'x', capture: true, jobs: true, synchronous: 'normal' }));
  });

  it('JD0007: an explicit journal mode on a read-only store; the default keeps the file\'s mode', () => {
    assert.throws(() => resolvePragmaRequests({ journalMode: 'wal' }, { memory: false, readOnly: true }),
      (error) => error.code === 'JD0007' && error.message.includes('journalMode'));
    assert.deepStrictEqual([...resolvePragmaRequests({}, { memory: false, readOnly: true })],
      [['busyTimeout', { value: 5000, explicit: false }]]);
  });

  it('a :memory: store does not write the pragmas its engine cannot take', () => {
    const requests = resolvePragmaRequests({ journalMode: 'wal', mmapSize: 4096, cacheSize: -64 },
      { memory: true, readOnly: false });
    assert.deepStrictEqual([...requests],
      [['busyTimeout', { value: 5000, explicit: false }], ['cacheSize', { value: -64, explicit: true }]]);
  });
});

describe('configuration on the node driver', () => {
  it('every pragma applies and the report equals what the same connection reads back', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const db = new DatabaseSync(dbPath);
    try {
      const store = await openStore(MODEL, {
        driver: sharedDriver(db), path: dbPath,
        busyTimeout: 1234, synchronous: 'normal', cacheSize: -8000, tempStore: 'memory',
        walAutocheckpoint: 250, journalSizeLimit: 1048576, mmapSize: 1048576,
      });
      const read = (name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];
      assert.deepStrictEqual(store.capabilities.pragmas, {
        busyTimeout: 1234, journalMode: 'wal', synchronous: 'normal', walAutocheckpoint: 250,
        journalSizeLimit: 1048576, cacheSize: -8000, mmapSize: 1048576, tempStore: 'memory',
      });
      assert.strictEqual(read('busy_timeout'), 1234);
      assert.strictEqual(read('journal_mode'), 'wal');
      assert.strictEqual(read('synchronous'), 1);
      assert.strictEqual(read('wal_autocheckpoint'), 250);
      assert.strictEqual(read('journal_size_limit'), 1048576);
      assert.strictEqual(read('cache_size'), -8000);
      assert.strictEqual(read('mmap_size'), 1048576);
      assert.strictEqual(read('temp_store'), 2);
      assert.strictEqual(store.capabilities.busyTimeoutMs, 1234);
      assert.strictEqual(store.capabilities.journalMode, 'wal');
      assert.deepStrictEqual([...store.capabilities.configurablePragmas], [...PRAGMA_NAMES]);
      assert.ok(Object.isFrozen(store.capabilities.pragmas));
      await store.close();
    }
    finally {
      cleanup();
    }
  });

  it('a :memory: store reports what the engine answers: the busy timeout, journal mode memory, no mmap', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), journalMode: 'wal', mmapSize: 4096 });
    assert.deepStrictEqual(store.capabilities.pragmas, {
      busyTimeout: 5000, journalMode: 'memory', synchronous: 'full', walAutocheckpoint: 1000,
      journalSizeLimit: -1, cacheSize: -2000, mmapSize: null, tempStore: 'default',
    });
    assert.strictEqual(store.capabilities.busyTimeoutMs, 5000);
    assert.strictEqual(store.capabilities.journalMode, 'memory');
    await store.close();
  });

  it('a read-only store reports the file\'s journal mode and refuses an explicit one (JD0007)', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const writer = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, journalMode: 'delete' });
      assert.strictEqual(writer.capabilities.journalMode, 'delete');
      await writer.close();
      const reader = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, readOnly: true });
      assert.strictEqual(reader.capabilities.journalMode, 'delete');
      assert.strictEqual(reader.capabilities.pragmas.busyTimeout, 5000);
      await reader.close();
      await assert.rejects(
        openStore(MODEL, { driver: nodeDriver(), path: dbPath, readOnly: true, journalMode: 'wal' }),
        (error) => error.code === 'JD0007');
    }
    finally {
      cleanup();
    }
  });

  it('JD0006 and a bad value reject before the driver opens', async () => {
    let opens = 0;
    const counting = { name: 'x', dialect: sqliteDialect,
      open: (...args) => { opens++; return nodeDriver().open(...args); } };
    await assert.rejects(openStore(MODEL, { driver: counting, page_size: 4096 }),
      (error) => error.code === 'JD0006');
    await assert.rejects(openStore(MODEL, { driver: counting, synchronous: 'bogus' }), TypeError);
    await assert.rejects(openStore(MODEL, { driver: counting, foreign_keys: false }),
      (error) => error.code === 'JD0006' && error.message.includes('requires ON'));
    assert.strictEqual(opens, 0);
  });
});

describe('a binding that declares less, or lies', () => {
  it('JD0007: a pragma the driver does not declare is refused, not skipped', async () => {
    const driver = wasmDriver(declaringWasmHandle(
      { userFunctions: true, pragmas: ['busyTimeout', 'journalMode'] }));
    await assert.rejects(openStore(MODEL, { driver, synchronous: 'normal' }),
      (error) => error.code === 'JD0007' && error.message.includes("'synchronous'")
        && error.message.includes("'busyTimeout'"));
    // the declared ones apply and the undeclared ones report null
    const store = await openStore(MODEL, { driver, busyTimeout: 42 });
    assert.deepStrictEqual([...store.capabilities.configurablePragmas], ['busyTimeout', 'journalMode']);
    assert.deepStrictEqual(store.capabilities.pragmas, {
      busyTimeout: 42, journalMode: 'memory', synchronous: null, walAutocheckpoint: null,
      journalSizeLimit: null, cacheSize: null, mmapSize: null, tempStore: null,
    });
    await store.close();
  });

  it('JD0008: a requested value the connection does not read back refuses the open', async () => {
    const driver = wasmDriver(lyingHandle({ synchronous: { synchronous: 2 } }));
    await assert.rejects(openStore(MODEL, { driver, synchronous: 'normal' }),
      (error) => error.code === 'JD0008' && error.message.includes("'synchronous'")
        && error.message.includes('"normal"') && error.message.includes('"full"'));
  });

  it('a DEFAULT the engine cannot take opens and reports the read value; the same value asked for is JD0008', async () => {
    // a binding on a file system with no shared memory answers `delete`
    // to the store's WAL default — the wasm build's case
    const { dbPath, cleanup } = tempDbPath();
    try {
      const driver = wasmDriver(lyingHandle({ journal_mode: { journal_mode: 'delete' } }));
      const store = await openStore(MODEL, { driver, path: dbPath });
      assert.strictEqual(store.capabilities.journalMode, 'delete');
      assert.strictEqual(store.capabilities.pragmas.journalMode, 'delete');
      await store.close();
      await assert.rejects(openStore(MODEL, { driver, path: dbPath, journalMode: 'wal' }),
        (error) => error.code === 'JD0008' && error.message.includes('"delete"'));
    }
    finally {
      cleanup();
    }
  });

  it('the report is the read-back, not the request: an unrequested lie shows through', async () => {
    // nothing asked for a journal mode on this memory store, so the
    // report carries whatever the connection answers — here a binding
    // that claims `delete`
    const driver = wasmDriver(lyingHandle({ journal_mode: { journal_mode: 'delete' }, busy_timeout: { timeout: 5000 } }));
    const store = await openStore(MODEL, { driver });
    assert.strictEqual(store.capabilities.journalMode, 'delete');
    assert.strictEqual(store.capabilities.pragmas.journalMode, 'delete');
    await store.close();
  });

  it('a binding whose read-back is empty reports null and cannot be asked for that pragma', async () => {
    const driver = wasmDriver(lyingHandle({ temp_store: undefined }));
    const store = await openStore(MODEL, { driver });
    assert.strictEqual(store.capabilities.pragmas.tempStore, null);
    await store.close();
    await assert.rejects(openStore(MODEL, { driver, tempStore: 'memory' }),
      (error) => error.code === 'JD0008');
  });
});

describe('no pragma text is spelled outside the dialect', () => {
  it('a string literal beginning with PRAGMA exists only in the SQLite dialect', () => {
    // a message may NAME a pragma ("PRAGMA foreign_keys stayed off");
    // statement text begins with the keyword, and that spelling has one
    // home
    const root = path.resolve('packages/db/src');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(file); continue; }
        if (!entry.name.endsWith('.js') || file.endsWith(path.join('dialects', 'sqlite.js'))) continue;
        const code = fs.readFileSync(file, 'utf8').split('\n')
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
        if (code.some((line) => /["'`]PRAGMA\b/.test(line))) offenders.push(path.relative(root, file));
      }
    };
    walk(root);
    assert.deepStrictEqual(offenders, []);
  });
});
