//@ts-check
/**
 * @file Compare-and-set on a plain collection (MODEL-FORMAT §5): `patch`
 * reads and writes in ONE write transaction, so a leading `test`, an
 * `expect` and the validator all judge the very document the write
 * replaces; `put`, `patch` and `delete` take `expect` (one `{ path,
 * value }` or a list) as a closed last argument; a patch that changes
 * nothing writes nothing. Two stores racing a leading-`test` patch on one
 * file used to lose every other update, and a rival write between the
 * read and the translated update could store a document the validator
 * never saw.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { JarenValidator } from '@jarenjs/validate';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: { schema: { type: 'object' }, key: '/id', indexes: [] },
  },
};

/** @param {string} code */
const coded = (code) => (/** @type {any} */ error) => error?.code === code;

describe('expect: a precondition on the stored document', () => {
  it('put, patch and delete write when the stored document holds it, and refuse JD2040 — writing nothing — when not', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      const docs = store.collection('docs');
      await docs.put({ id: 'a', revision: 3, name: 'x' });
      // put
      await assert.rejects(docs.put({ id: 'a', revision: 5 }, undefined, { expect: { path: '/revision', value: 4 } }), coded('JD2040'));
      assert.strictEqual((await docs.get('a'))?.revision, 3, 'nothing was written');
      assert.strictEqual(await docs.put({ id: 'a', revision: 4, name: 'x' }, undefined, { expect: { path: '/revision', value: 3 } }), 'a');
      assert.strictEqual((await docs.get('a'))?.revision, 4);
      // patch
      await assert.rejects(docs.patch('a', [{ op: 'replace', path: '/name', value: 'y' }], { expect: { path: '/revision', value: 3 } }),
        (/** @type {any} */ error) => error.code === 'JD2040' && /'\/revision'/.test(error.message) && error.key === 'a');
      assert.deepStrictEqual(await docs.patch('a', [{ op: 'replace', path: '/revision', value: 5 }],
        { expect: [{ path: '/revision', value: 4 }, { path: '/name', value: 'x' }] }), { id: 'a', revision: 5, name: 'x' });
      // delete
      await assert.rejects(docs.delete('a', { expect: { path: '/name', value: 'z' } }), coded('JD2040'));
      assert.notStrictEqual(await docs.get('a'), undefined);
      assert.strictEqual(await docs.delete('a', { expect: { path: '/revision', value: 5 } }), true);
      assert.strictEqual(await docs.get('a'), undefined);
      // a value is compared as JSON: structure, not identity or key order
      await docs.put({ id: 'b', tags: { x: [1, { y: null }] } });
      await docs.patch('b', [{ op: 'add', path: '/seen', value: true }], { expect: { path: '/tags', value: { x: [1, { y: null }] } } });
      await assert.rejects(docs.patch('b', [], { expect: { path: '/tags/x', value: [1] } }), coded('JD2040'));
      await assert.rejects(docs.patch('b', [], { expect: { path: '/missing', value: null } }), coded('JD2040'),
        'a member that is absent is not null');
    }
    finally { await store.close(); }
  });

  it('nothing stored holds no precondition: put and delete refuse JD2040, patch keeps JD2006', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      const docs = store.collection('docs');
      const expect = { path: '/revision', value: 1 };
      await assert.rejects(docs.put({ id: 'new', revision: 1 }, undefined, { expect }), coded('JD2040'));
      assert.strictEqual(await docs.get('new'), undefined);
      await assert.rejects(docs.delete('new', { expect }), coded('JD2040'));
      await assert.rejects(docs.patch('new', [], { expect }), coded('JD2006'));
    }
    finally { await store.close(); }
  });

  it('the options are a closed set, refused JD0013 before any statement — insert reads none', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      const docs = store.collection('docs');
      await docs.put({ id: 'a', revision: 4 });
      for (const options of ['x', null, [], { expct: {} }, { expect: [] }, { expect: 'r' }, { expect: { value: 999 } },
        { expect: { path: 'revision', value: 4 } }, { expect: { path: '/revision' } }, { expect: { path: '/revision', value: 4, op: 'eq' } }]) {
        await assert.rejects(docs.patch('a', [{ op: 'replace', path: '/revision', value: 9 }], /** @type {any} */ (options)),
          coded('JD0013'), `patch ${JSON.stringify(options)}`);
        await assert.rejects(docs.put({ id: 'a', revision: 9 }, undefined, /** @type {any} */ (options)), coded('JD0013'));
        await assert.rejects(docs.delete('a', /** @type {any} */ (options)), coded('JD0013'));
      }
      assert.strictEqual((await docs.get('a'))?.revision, 4, 'nothing ran');
      await assert.rejects(docs.insert({ id: 'c' }, /** @type {any} */ ({ expect: { path: '/x', value: 1 } })),
        (/** @type {any} */ error) => error.code === 'JD0013' && /'expect' is not one insert reads/.test(error.message));
      assert.strictEqual(await docs.get('c'), undefined);
      await assert.rejects(docs.patch('a', [], /** @type {any} */ ({ expct: {} })),
        (/** @type {any} */ error) => /'expect'/.test(error.message), 'the nearest member is named');
    }
    finally { await store.close(); }
  });

  it('an expected value compares as the JSON it is written as; one no JSON document holds is JD0013', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      const docs = store.collection('docs');
      const profile = { name: 'ann', nickname: undefined };
      const updatedAt = new Date('2026-10-01T00:00:00.000Z');
      await docs.put({ id: 'a', revision: 1, profile, updatedAt, n: Number.NaN });
      // the stored document is the JSON of what was put: the same values expected hold
      for (const expect of [{ path: '/profile', value: profile }, { path: '/updatedAt', value: updatedAt },
        { path: '/n', value: Number.NaN }, { path: '', value: { id: 'a', revision: 1, profile, updatedAt, n: Number.NaN } }]) {
        assert.deepStrictEqual(await docs.patch('a', [], { expect }), await docs.get('a'), JSON.stringify(expect));
      }
      assert.strictEqual(await docs.delete('a', { expect: { path: '/profile', value: profile } }), true);
      await docs.put({ id: 'b', big: 1 });
      for (const value of [1n, () => 1, Symbol('x')]) {
        await assert.rejects(async () => docs.patch('b', [], { expect: { path: '/big', value } }),
          (/** @type {any} */ error) => error.code === 'JD0013' && /which no JSON document holds/.test(error.message), typeof value);
      }
      const cycle = /** @type {any} */ ({});
      cycle.self = cycle;
      await assert.rejects(async () => docs.put({ id: 'b' }, undefined, { expect: { path: '/big', value: cycle } }), coded('JD0013'));
      assert.deepStrictEqual(await docs.get('b'), { id: 'b', big: 1 }, 'nothing ran');
    }
    finally { await store.close(); }
  });

  it('on a capturing store the options are refused before its capture transaction begins', async () => {
    for (const mode of /** @type {const} */ (['journal', 'session'])) {
      const { dbPath, cleanup } = tempDbPath();
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, busyTimeout: 2_000, capture: { mode, log: true } });
      const other = new DatabaseSync(dbPath);
      try {
        await store.collection('docs').put({ id: 'a', revision: 1 });
        // another connection holds the write lock the capture transaction would wait for
        other.exec('BEGIN IMMEDIATE');
        const started = Date.now();
        for (const call of [
          () => store.collection('docs').put({ id: 'a' }, undefined, /** @type {any} */ ({ expct: {} })),
          () => store.collection('docs').patch('a', [], /** @type {any} */ ({ expct: {} })),
          () => store.collection('docs').insert({ id: 'b' }, /** @type {any} */ ({ expect: { path: '/x', value: 1 } })),
          () => store.collection('docs').delete('a', /** @type {any} */ ({ expect: [] })),
        ]) await assert.rejects(async () => call(), coded('JD0013'), mode);
        assert.ok(Date.now() - started < 1_000, `${mode}: refused at once, not after a busy wait`);
        other.exec('ROLLBACK');
      }
      finally {
        other.close();
        await store.close();
        cleanup();
      }
    }
  });

  it('the synchronous twin and a transaction take the same options', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      store.sync?.collection('docs').put({ id: 's', revision: 1 });
      assert.throws(() => store.sync?.collection('docs').patch('s', [], { expect: { path: '/revision', value: 2 } }), coded('JD2040'));
      assert.deepStrictEqual(store.sync?.collection('docs').patch('s', [{ op: 'replace', path: '/revision', value: 2 }],
        { expect: { path: '/revision', value: 1 } }), { id: 's', revision: 2 });
      await store.transaction(async (tx) => {
        await assert.rejects(tx.collection('docs').delete('s', { expect: { path: '/revision', value: 1 } }), coded('JD2040'));
        assert.strictEqual(await tx.collection('docs').delete('s', { expect: { path: '/revision', value: 2 } }), true);
      });
      assert.strictEqual(await store.collection('docs').get('s'), undefined);
    }
    finally { await store.close(); }
  });
});

describe('a patch reads and writes in one transaction', () => {
  it('two stores (worker threads, one file) racing a leading-test patch for 300 rounds lose no update', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const a = await openStore(MODEL, { driver: nodeWorkerDriver(), path: dbPath });
    const b = await openStore(MODEL, { driver: nodeWorkerDriver(), path: dbPath });
    try {
      await a.collection('docs').put({ id: 'r', revision: 0, log: [] });
      let committed = 0;
      let refused = 0;
      /** @param {any} store @param {string} entry */
      const round = async (store, entry) => {
        const seen = await store.collection('docs').get('r');
        try {
          await store.collection('docs').patch('r', [
            { op: 'test', path: '/revision', value: seen.revision },
            { op: 'replace', path: '/revision', value: seen.revision + 1 },
            { op: 'add', path: '/log/-', value: entry }]);
          committed++;
        }
        catch (error) {
          assert.strictEqual(/** @type {any} */ (error).code, 'JP2004', 'the only refusal is the failed test');
          refused++;
        }
      };
      for (let i = 0; i < 300; i++) await Promise.all([round(a, `a${i}`), round(b, `b${i}`)]);
      const end = await a.collection('docs').get('r');
      assert.strictEqual(committed + refused, 600);
      assert.strictEqual(end.revision, committed, 'every committed patch advanced the revision');
      assert.strictEqual(end.log.length, committed, 'and none of them was written over');
      assert.ok(refused > 0, 'the race was real: some tests lost');
    }
    finally {
      await a.close();
      await b.close();
      cleanup();
    }
  });

  it('the document validated is the document written: a rival write can no longer slip a doc the validator refuses', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const schemaModel = { $model: '0.1', collections: { docs: {
      schema: { type: 'object', not: { required: ['a', 'b'] } }, key: '/id', indexes: [] } } };
    const validator = new JarenValidator({ collectErrors: true });
    const options = () => ({ driver: nodeWorkerDriver(), path: dbPath, compileSchema: (/** @type {any} */ s) => validator.compile(s) });
    const a = await openStore(schemaModel, options());
    const b = await openStore(schemaModel, options());
    try {
      let refused = 0;
      for (let i = 0; i < 100; i++) {
        const id = `x${i}`;
        await a.collection('docs').put({ id });
        const settled = await Promise.allSettled([
          a.collection('docs').patch(id, [{ op: 'add', path: '/a', value: 1 }]),
          b.collection('docs').patch(id, [{ op: 'add', path: '/b', value: 2 }])]);
        refused += settled.filter((s) => s.status === 'rejected' && /** @type {any} */ (s.reason).code === 'JD2003').length;
        const stored = await a.collection('docs').get(id);
        assert.ok(!('a' in stored && 'b' in stored), `round ${i} stored a document the schema refuses`);
      }
      assert.strictEqual(refused, 100, 'the second patch of every round was validated against the first one\'s result');
    }
    finally {
      await a.close();
      await b.close();
      cleanup();
    }
  });
});

describe('a patch that changes nothing writes nothing', () => {
  for (const capture of [undefined, { mode: /** @type {const} */ ('journal'), log: true }, { mode: /** @type {const} */ ('session'), log: true }]) {
    it(`no statement, no commit another connection sees, no capture record (${capture?.mode ?? 'no capture'})`, async () => {
      const { dbPath, cleanup } = tempDbPath();
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, ...(capture === undefined ? {} : { capture }) });
      const other = new DatabaseSync(dbPath);
      try {
        const docs = store.collection('docs');
        await docs.put({ id: 'a', n: 1, tags: ['x'] });
        /** @type {any[]} */
        const records = [];
        if (capture !== undefined) store.observe((record) => records.push(record));
        const version = () => other.prepare('PRAGMA data_version').get()?.data_version;
        const changes = async () => store.transaction(async (tx) =>
          Number((await tx.sql.prepare('SELECT total_changes() AS n', { access: 'read' }).get())?.n));
        for (const ops of [[], [{ op: 'test', path: '/n', value: 1 }], [{ op: 'replace', path: '/n', value: 1 }],
          [{ op: 'remove', path: '/tags/0' }, { op: 'add', path: '/tags/-', value: 'x' }],
          // a value counts as the JSON it is written as: an undefined member is no member
          [{ op: 'replace', path: '', value: { id: 'a', n: 1, tags: ['x'], note: undefined } }],
          [{ op: 'test', path: '', value: { id: 'a', n: 1, tags: ['x'], note: undefined } }]]) {
          const [v0, c0] = [version(), await changes()];
          assert.deepStrictEqual(await docs.patch('a', ops), { id: 'a', n: 1, tags: ['x'] });
          assert.strictEqual(await changes(), c0, `${JSON.stringify(ops)} issued a write`);
          assert.strictEqual(version(), v0, 'no commit reached another connection');
        }
        assert.deepStrictEqual(records, []);
        // two runs: the first changes the document, the second changes nothing
        const c0 = await changes();
        await docs.patch('a', [{ op: 'replace', path: '/n', value: 2 }]);
        const c1 = await changes();
        await docs.patch('a', [{ op: 'replace', path: '/n', value: 2 }]);
        assert.ok(c1 - c0 >= 1, 'the first run wrote (and, with capture, logged)');
        assert.strictEqual(await changes(), c1, 'the second run wrote nothing');
        assert.strictEqual(records.length, capture === undefined ? 0 : 1);
      }
      finally {
        other.close();
        await store.close();
        cleanup();
      }
    });
  }
});
