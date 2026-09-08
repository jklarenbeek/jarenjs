//@ts-check
/**
 * @file Migrations without a database: an array of documents and a
 * Store carrying the same documents answer the same migration
 * identically — the same output, the same counts, the same refusal on
 * the same step; a step that needs tables refuses before the first
 * document is read; and a source that can only be walked once is walked
 * once, holding one batch.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  openStore, migrate, migrateDocuments, streamDocuments, planMigration, sqliteDialect,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { tempDbPath } from './helpers.js';

const M0 = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' } },
      },
      key: '/id',
      indexes: [],
    },
  },
};
const M1 = {
  $model: '0.1',
  collections: {
    users: M0.collections.users,
    events: { schema: { type: 'object' }, key: null, identity: 'integer' },
  },
};

/** A migration carrying exactly the given document steps. */
function documentMigration(id, steps) {
  const { migration } = planMigration(M0, M1, { dialect: sqliteDialect, id });
  migration.steps.push(...steps);
  return migration;
}

/** The migration with its PHYSICAL steps stripped: the document half. */
function documentHalf(migration) {
  return { ...migration, steps: migration.steps.filter((step) => step.kind === 'jslt' || step.kind === 'query') };
}

const SPLIT_NAME = {
  kind: 'jslt',
  collection: 'users',
  stylesheet: [{
    match: '$',
    body: {
      id: '$.id',
      name: { $concat: [{ $default: ['$.first', ''] }, ' ', { $default: ['$.last', ''] }] },
    },
  }],
};

const seedUsers = (n) => Array.from({ length: n }, (_, i) => ({
  id: `u${String(i).padStart(3, '0')}`,
  first: `First${i}`,
  last: `Last${i}`,
}));

describe('collection names that also name object members', () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    it(`preserves '${name}' documents and counters in both execution modes`, async () => {
      const input = { [name]: [{ id: 'u1' }] };
      const migration = documentHalf(documentMigration('0001-identity', [
        { kind: 'jslt', collection: name, stylesheet: [] },
      ]));
      const unchanged = await migrateDocuments(input, []);
      assert.deepStrictEqual(unchanged.documents, input);
      const materialized = await migrateDocuments(input, [migration]);
      assert.deepStrictEqual(materialized.documents, input);
      assert.deepStrictEqual(materialized.report.counts,
        { [name]: { read: 1, transformed: 1, asserted: 0 } });
      assert.deepStrictEqual(materialized.report.strategy, { [name]: 'materialized' });
      const written = [];
      const streamed = await streamDocuments(input, [migration], {
        write: (collection, document) => written.push([collection, document]),
      });
      assert.deepStrictEqual(written, [[name, { id: 'u1' }]]);
      assert.deepStrictEqual(streamed.counts, materialized.report.counts);
      assert.deepStrictEqual(streamed.strategy, { [name]: 'streamed' });
    });
  }
});

/** Run one migration through a real Store and read the documents back. */
async function throughStore(documents, migration) {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const store = await openStore(M0, { driver: nodeDriver(), path: dbPath });
    await store.transaction(async (tx) => {
      for (const document of documents) await tx.collection('users').insert(document);
    });
    await store.close();
    let failure = null;
    let report = null;
    try {
      report = await migrate({ driver: nodeDriver(), path: dbPath }, [migration],
        { baseline: M0, model: M1, shadow: false, batchSize: 500 });
    }
    catch (error) {
      failure = { code: error.code, message: error.message };
    }
    const reopened = await openStore(M1, { driver: nodeDriver(), path: dbPath });
    const stored = [];
    for await (const row of reopened.collection('users')
      .query({ $for: { it: '$[*]' }, $return: '$it' })) stored.push(row);
    await reopened.close();
    return { report, failure, documents: stored };
  }
  finally {
    cleanup();
  }
}

/** The same migration's document half, over the same documents, in arrays. */
async function throughArrays(documents, migration, options = {}) {
  let failure = null;
  let out = null;
  try {
    out = await migrateDocuments({ users: documents }, [documentHalf(migration)], options);
  }
  catch (error) {
    failure = { code: error.code, message: error.message };
  }
  return { failure, documents: out?.documents.users ?? [], report: out?.report ?? null };
}

describe('a migration without a database', () => {
  it('array mode answers exactly what the Store answers, for a transform', async () => {
    const seed = seedUsers(7);
    const migration = documentMigration('0001-split', [SPLIT_NAME]);
    const store = await throughStore(seed, migration);
    const arrays = await throughArrays(seed, migration);
    assert.strictEqual(store.failure, null);
    assert.strictEqual(arrays.failure, null);
    assert.deepStrictEqual(arrays.documents, store.documents);
    assert.deepStrictEqual(arrays.documents[0], { id: 'u000', name: 'First0 Last0' });
  });

  it('array mode answers what the Store answers for a transform then an assertion', async () => {
    const seed = seedUsers(5);
    const migration = documentMigration('0001-split-assert', [SPLIT_NAME, {
      kind: 'query',
      collection: 'users',
      assert: { $for: { it: '$[*]' }, $where: { $empty: '$it.name' }, $return: '$it.id' },
    }]);
    const store = await throughStore(seed, migration);
    const arrays = await throughArrays(seed, migration);
    assert.strictEqual(store.failure, null);
    assert.strictEqual(arrays.failure, null);
    assert.deepStrictEqual(arrays.documents, store.documents);
    assert.strictEqual(arrays.report.counts.users.asserted, 5);
  });

  it('a per-document assertion refuses with the Store\'s own words, naming the same step', async () => {
    const seed = seedUsers(4);
    const migration = documentMigration('0001-assert-fails', [{
      kind: 'query',
      collection: 'users',
      assert: { $for: { it: '$[*]' }, $where: { $eq: ['$it.id', 'u002'] }, $return: '$it.id' },
    }]);
    const store = await throughStore(seed, migration);
    const arrays = await throughArrays(seed, migration);
    assert.strictEqual(store.failure?.code, 'JD0023');
    assert.strictEqual(arrays.failure?.code, 'JD0023');
    // the step index differs by the physical steps the document half
    // drops, so compare the part that describes the FAILURE
    assert.match(store.failure.message, /\(query\) failed: the assertion expected an empty sequence, got 1 item\(s\)$/);
    assert.match(arrays.failure.message, /\(query\) failed: the assertion expected an empty sequence, got 1 item\(s\)$/);
  });

  it('a cross-document assertion answers as it does on a Store, over the whole array', async () => {
    const seed = seedUsers(3);
    const migration = documentMigration('0001-count', [{
      kind: 'query', collection: 'users', assert: { $count: '$[*]' }, expect: 'ebv',
    }]);
    const store = await throughStore(seed, migration);
    const arrays = await throughArrays(seed, migration);
    assert.strictEqual(store.failure, null);
    assert.strictEqual(arrays.failure, null);

    // and on an EMPTY collection both refuse, with one message
    const emptyStore = await throughStore([], migration);
    const emptyArrays = await throughArrays([], migration);
    assert.match(emptyStore.failure.message, /the EBV assertion answered false$/);
    assert.match(emptyArrays.failure.message, /the EBV assertion answered false$/);
  });

  it('an empty collection migrates to an empty collection', async () => {
    const migration = documentMigration('0001-split-empty', [SPLIT_NAME]);
    const arrays = await throughArrays([], migration);
    assert.strictEqual(arrays.failure, null);
    assert.deepStrictEqual(arrays.documents, []);
  });

  it('the report carries the applied ids, the target shape and per-collection counts', async () => {
    const seed = seedUsers(1200);
    const migration = documentMigration('0001-split-batched', [SPLIT_NAME]);
    const { report } = await migrateDocuments({ users: seed },
      [documentHalf(migration)], { batchSize: 500 });
    assert.deepStrictEqual(report.applied, ['0001-split-batched']);
    assert.deepStrictEqual(report.skipped, []);
    assert.strictEqual(report.shape, migration.to);
    assert.deepStrictEqual(report.counts.users,
      { read: 1200, transformed: 1200, asserted: 0 });
    assert.strictEqual(report.strategy.users, 'materialized');
  });

  it('a transform that produces a non-document is refused, naming the row', async () => {
    const migration = documentMigration('0001-bad', [{
      kind: 'jslt', collection: 'users', stylesheet: [{ match: '$', body: '$.id' }],
    }]);
    await assert.rejects(() => migrateDocuments({ users: seedUsers(2) }, [documentHalf(migration)]),
      (error) => /** @type {any} */ (error).code === 'JD0023'
        && /the transform produced a non-document for row 0/.test(/** @type {Error} */ (error).message));
  });

  it('a declared key member a transform moves is refused', async () => {
    const migration = documentMigration('0001-move-key', [{
      kind: 'jslt', collection: 'users', stylesheet: [{ match: '$', body: { id: 'moved' } }],
    }]);
    await assert.rejects(() => migrateDocuments({ users: seedUsers(2) },
      [documentHalf(migration)], { keys: { users: ['id'] } }),
    (error) => /** @type {any} */ (error).code === 'JD0023'
      && /changed the key member 'id' of row 0/.test(/** @type {Error} */ (error).message));
  });
});

describe('a step that needs a database', () => {
  for (const kind of ['ddl', 'sql', 'rebuild', 'derive']) {
    it(`refuses a '${kind}' step before the first document is read`, async () => {
      let read = 0;
      const source = { *[Symbol.iterator]() { read++; yield { id: 'u1' }; } };
      const step = {
        ddl: { kind: 'ddl', sql: 'CREATE TABLE t (a)' },
        sql: { kind: 'sql', sql: 'UPDATE users SET x = 1' },
        rebuild: { kind: 'rebuild', table: 'users', create: ['CREATE TABLE x (a)'], copy: 'INSERT INTO x SELECT * FROM users', indexes: [] },
        derive: { kind: 'derive', collection: 'users', columns: [{ name: 'c', segments: ['c'] }] },
      }[kind];
      const migration = { ...documentMigration(`0001-${kind}`, []), steps: [step] };
      await assert.rejects(() => migrateDocuments({ users: [{ id: 'u1' }] }, [migration]),
        (error) => /** @type {any} */ (error).code === 'JD0023'
          && new RegExp(`step 0 \\(${kind}\\) needs a database`).test(/** @type {Error} */ (error).message));
      await assert.rejects(() => streamDocuments({ users: source }, [migration],
        { write: () => { throw new Error('nothing may be written'); } }),
      (error) => /** @type {any} */ (error).code === 'JD0023');
      assert.strictEqual(read, 0, 'the source was never asked for a document');
    });
  }

  it('a step naming a collection nobody supplied refuses before reading', async () => {
    const migration = documentMigration('0001-absent', [{ ...SPLIT_NAME, collection: 'ghosts' }]);
    await assert.rejects(() => migrateDocuments({ users: [] }, [documentHalf(migration)]),
      (error) => /** @type {any} */ (error).code === 'JD0023'
        && /names collection 'ghosts', which was not supplied/.test(/** @type {Error} */ (error).message));
  });
});

describe('a source walked once', () => {
  it('consumes the input exactly once and holds one batch, writing as it goes', async () => {
    const total = 2500;
    let produced = 0;
    let live = 0;
    let peak = 0;
    const source = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < total; i++) {
          produced++;
          live++;
          if (live > peak) peak = live;
          yield { id: `u${String(i).padStart(4, '0')}`, first: `First${i}`, last: `Last${i}` };
        }
      },
    };
    const written = [];
    const report = await streamDocuments({ users: source },
      [documentHalf(documentMigration('0001-split', [SPLIT_NAME]))], {
        batchSize: 100,
        write: (collection, document) => { live--; written.push(document); },
      });
    assert.strictEqual(produced, total, 'the source produced every document exactly once');
    assert.strictEqual(written.length, total);
    assert.deepStrictEqual(written[0], { id: 'u0000', name: 'First0 Last0' });
    assert.deepStrictEqual(written[total - 1],
      { id: `u${String(total - 1).padStart(4, '0')}`, name: `First${total - 1} Last${total - 1}` });
    assert.ok(peak <= 100, `held ${peak} documents at once, not one batch of 100`);
    assert.strictEqual(report.counts.users.read, total);
    assert.strictEqual(report.strategy.users, 'streamed');
  });

  it('answers a synchronous iterable as it answers an asynchronous one', async () => {
    const documents = seedUsers(5);
    const written = [];
    await streamDocuments({ users: documents },
      [documentHalf(documentMigration('0001-split', [SPLIT_NAME]))],
      { write: (collection, document) => written.push(document), batchSize: 2 });
    const { documents: arrays } = await migrateDocuments({ users: documents },
      [documentHalf(documentMigration('0001-split', [SPLIT_NAME]))]);
    assert.deepStrictEqual(written, arrays.users);
  });

  it('FOLDS an associative aggregate rather than refusing it — one pass, no buffer', async () => {
    const written = [];
    let held = 0;
    let peak = 0;
    const source = {
      *[Symbol.iterator]() {
        for (let i = 0; i < 1000; i++) { held++; if (held > peak) peak = held; yield { id: `u${i}` }; }
      },
    };
    const migration = documentHalf(documentMigration('0001-count', [{
      kind: 'query', collection: 'users', assert: { $count: '$[*]' }, expect: 'ebv',
    }]));
    const report = await streamDocuments({ users: source }, [migration], {
      batchSize: 100,
      write: (collection, document) => { held--; written.push(document); },
    });
    assert.strictEqual(written.length, 1000);
    assert.ok(peak <= 100, `held ${peak} documents at once`);
    assert.strictEqual(report.counts.users.read, 1000);

    // and its verdict is the total's: over an EMPTY source the count is
    // 0, whose effective boolean value is false, so it refuses
    await assert.rejects(() => streamDocuments({ users: [] }, [migration], { write: () => {} }),
      (error) => /** @type {any} */ (error).code === 'JD0023'
        && /EBV assertion answered false/.test(/** @type {Error} */ (error).message));
  });

  it('refuses a MATERIALIZING assertion by name rather than buffering the collection', async () => {
    let read = 0;
    const source = { *[Symbol.iterator]() { read++; yield { id: 'u1' }; } };
    const migration = documentHalf(documentMigration('0001-nested', [{
      kind: 'query',
      collection: 'users',
      assert: { $for: { a: '$[*]', b: '$[*]' }, $where: { $eq: ['$a.id', '$b.id'] }, $return: '$a.id' },
    }]));
    await assert.rejects(() => streamDocuments({ users: source }, [migration],
      { write: () => {} }),
    (error) => /** @type {any} */ (error).code === 'JD0023'
      && /a cross-document assertion needs every document of 'users' at once/
        .test(/** @type {Error} */ (error).message));
    assert.strictEqual(read, 0, 'nothing was read');
  });

  it('a per-document assertion still fails fast, before the whole source is drained', async () => {
    let produced = 0;
    const source = {
      *[Symbol.iterator]() {
        for (let i = 0; i < 5000; i++) {
          produced++;
          yield { id: `u${i}`, n: i };
        }
      },
    };
    const migration = documentHalf(documentMigration('0001-assert', [{
      kind: 'query',
      collection: 'users',
      assert: { $for: { it: '$[*]' }, $where: { $eq: ['$it.n', 150] }, $return: '$it.id' },
    }]));
    await assert.rejects(() => streamDocuments({ users: source }, [migration],
      { write: () => {}, batchSize: 100 }),
    (error) => /** @type {any} */ (error).code === 'JD0023');
    assert.ok(produced <= 200, `drained ${produced} documents past the violation`);
  });
});
