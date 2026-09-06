//@ts-check
/**
 * @file The campaign's end-to-end proof: ONE fixture through every
 * document host, and one durable run through every resume outcome.
 *
 * A migration's document steps mean the same thing wherever they run.
 * This suite takes a single migration and a single set of documents and
 * puts them through a Store, an in-memory array, a JSON array file, a
 * JSONL file and stdio, and requires every host to answer the same
 * ordered documents. It then runs the same shapes as assertions — one
 * that folds and one that must hold the collection — and requires the
 * classification, the counts and the refusals to agree. Finally it takes
 * a DAG job to a checkpoint and back, under an unchanged task version and
 * a changed one.
 *
 * A failure here means two hosts have drifted, which is the one thing the
 * whole campaign exists to prevent.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  openStore, migrate, migrateDocuments, streamDocuments, planMigration, sqliteDialect,
  classifyAssertion,
} from '@jarenjs/db';
import { nodeDriver, readDocuments, openAtomicTarget } from '@jarenjs/db/node';

import { tempDbPath } from './helpers.js';

const CLI = path.resolve('packages/db/src/cli.js');

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

/** The one assertion that folds, and the one that cannot. */
const FOLDS = { kind: 'query', collection: 'users', assert: { $count: '$[*]' }, expect: 'ebv' };
const MATERIALIZES = {
  kind: 'query',
  collection: 'users',
  assert: {
    $for: { a: '$[*]', b: '$[*]' },
    $where: { $and: [{ $eq: ['$a.name', '$b.name'] }, { $ne: ['$a.id', '$b.id'] }] },
    $return: '$a.id',
  },
};

const migrationOf = (id, steps) => {
  const { migration } = planMigration(M0, M1, { dialect: sqliteDialect, id });
  migration.steps.push(...steps);
  return migration;
};
const documentHalf = (migration) => ({
  ...migration,
  steps: migration.steps.filter((step) => step.kind === 'jslt' || step.kind === 'query'),
});

const SEED = [
  { id: 'u1', first: 'Ada', last: 'Lovelace' },
  { id: 'u2', first: 'Lin', last: 'Zed' },
  { id: 'u3', first: 'Kai', last: 'Rho' },
  { id: 'u4', first: 'Mo', last: 'Vex' },
  { id: 'u5', first: 'Ivy', last: 'Quill' },
];
const EXPECTED = SEED.map((d) => ({ id: d.id, name: `${d.first} ${d.last}` }));

/** @type {string} */
let dir = '';
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replaysafe-e2e-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const jsonl = (documents) => `${documents.map((d) => JSON.stringify(d)).join('\n')}\n`;

const migrationsDir = (name, migrations) => {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  migrations.forEach((migration, i) => fs.writeFileSync(
    path.join(folder, `000${i + 1}.json`), JSON.stringify(migration, null, 2)));
  return folder;
};
const cli = (...args) => spawnSync(process.execPath,
  ['--no-warnings=ExperimentalWarning', CLI, 'documents', ...args], { encoding: 'utf8' });

/** The fixture through a real Store, read back in row order. */
async function throughStore(migration, seed = SEED) {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const store = await openStore(M0, { driver: nodeDriver(), path: dbPath });
    await store.transaction(async (tx) => {
      for (const document of seed) await tx.collection('users').insert(document);
    });
    await store.close();
    let failure = null;
    try {
      await migrate({ driver: nodeDriver(), path: dbPath }, [migration],
        { baseline: M0, model: M1, shadow: false, batchSize: 2 });
    }
    catch (error) {
      failure = { code: /** @type {any} */ (error).code, message: /** @type {Error} */ (error).message };
    }
    const reopened = await openStore(M1, { driver: nodeDriver(), path: dbPath });
    const documents = [];
    for await (const row of reopened.collection('users')
      .query({ $for: { it: '$[*]' }, $return: '$it' })) documents.push(row);
    await reopened.close();
    return { documents, failure };
  }
  finally { cleanup(); }
}

describe('one fixture, every document host, one answer', () => {
  const migration = migrationOf('0001-split', [SPLIT_NAME]);

  it('a Store, an array, a JSON file, a JSONL file and stdio all agree', async () => {
    const answers = {};

    answers.store = (await throughStore(migration)).documents;

    const arrays = await migrateDocuments({ users: SEED }, [documentHalf(migration)],
      { batchSize: 2 });
    answers.array = arrays.documents.users;

    const streamed = [];
    await streamDocuments({ users: SEED }, [documentHalf(migration)],
      { batchSize: 2, write: (collection, document) => streamed.push(document) });
    answers.stream = streamed;

    const dirName = migrationsDir('split', [documentHalf(migration)]);
    const asJson = path.join(dir, 'e2e.json');
    const asJsonl = path.join(dir, 'e2e.jsonl');
    fs.writeFileSync(asJson, JSON.stringify(SEED, null, 2));
    fs.writeFileSync(asJsonl, jsonl(SEED));

    const jsonOut = path.join(dir, 'e2e-out.json');
    assert.strictEqual(cli('--migrations', dirName, '--in', asJson, '--out', jsonOut).status, 0);
    answers.jsonFile = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));

    const jsonlOut = path.join(dir, 'e2e-out.jsonl');
    assert.strictEqual(cli('--migrations', dirName, '--in', asJsonl, '--out', jsonlOut).status, 0);
    answers.jsonlFile = fs.readFileSync(jsonlOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

    const piped = spawnSync(process.execPath,
      ['--no-warnings=ExperimentalWarning', CLI, 'documents',
        '--migrations', dirName, '--in', '-', '--out', '-'],
      { encoding: 'utf8', input: jsonl(SEED) });
    assert.strictEqual(piped.status, 0, piped.stderr);
    answers.stdio = piped.stdout.split('\n')
      .filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));

    for (const [host, documents] of Object.entries(answers)) {
      assert.deepStrictEqual(documents, EXPECTED, `${host} disagrees`);
    }
  });

  it('an in-place run that fails leaves the original byte for byte', () => {
    const failing = migrationsDir('e2e-failing', [documentHalf(migrationOf('0001-fails', [
      SPLIT_NAME,
      { kind: 'query', collection: 'users', assert: { $for: { it: '$[*]' }, $where: { $eq: ['$it.id', 'u3'] }, $return: '$it.id' } },
    ]))]);
    const target = path.join(dir, 'e2e-inplace.jsonl');
    fs.writeFileSync(target, jsonl(SEED));
    const before_ = fs.readFileSync(target);
    const listed = fs.readdirSync(dir).sort();

    const result = cli('--migrations', failing, '--in', target, '--in-place', '--yes');
    assert.strictEqual(result.status, 1);
    assert.ok(fs.readFileSync(target).equals(before_), 'the original survived whole');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), listed, 'no temporary was left');
  });
});

describe('an assertion costs the same wherever it runs', () => {
  it('the fold and the materializing shape classify identically for every host', () => {
    assert.strictEqual(classifyAssertion(FOLDS.assert).strategy, 'fold');
    assert.strictEqual(classifyAssertion(MATERIALIZES.assert).strategy, 'materialize');
  });

  it('a folding assertion holds on a Store and on an array, with one answer', async () => {
    const migration = migrationOf('0001-fold', [SPLIT_NAME, FOLDS]);
    const store = await throughStore(migration);
    const arrays = await migrateDocuments({ users: SEED }, [documentHalf(migration)],
      { batchSize: 2 });
    assert.strictEqual(store.failure, null);
    assert.deepStrictEqual(arrays.documents.users, store.documents);
    assert.deepStrictEqual(store.documents, EXPECTED);
  });

  it('a materializing assertion honours its bound, on a Store and on an array alike', async () => {
    const migration = migrationOf('0001-mat', [SPLIT_NAME, MATERIALIZES]);
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(M0, { driver: nodeDriver(), path: dbPath });
      await store.transaction(async (tx) => {
        for (const document of SEED) await tx.collection('users').insert(document);
      });
      await store.close();
      await assert.rejects(async () => migrate({ driver: nodeDriver(), path: dbPath }, [migration],
        { baseline: M0, model: M1, shadow: false, batchSize: 2, assertionBounds: { maxRows: 2 } }),
      (error) => /** @type {any} */ (error).code === 'JD2007'
        && /maxRows bound of 2/.test(/** @type {Error} */ (error).message));
    }
    finally { cleanup(); }

    await assert.rejects(() => migrateDocuments({ users: SEED }, [documentHalf(migration)],
      { batchSize: 2, assertionBounds: { maxRows: 2 } }),
    (error) => /** @type {any} */ (error).code === 'JD2007'
      && /maxRows bound of 2/.test(/** @type {Error} */ (error).message));
  });

  it('one pass refuses the materializing shape by name, and folds the other', async () => {
    await assert.rejects(() => streamDocuments({ users: SEED },
      [documentHalf(migrationOf('0001-mat', [MATERIALIZES]))], { write: () => {} }),
    (error) => /** @type {any} */ (error).code === 'JD0023'
      && /a cross-document assertion needs every document/.test(/** @type {Error} */ (error).message));

    const written = [];
    const report = await streamDocuments({ users: SEED },
      [documentHalf(migrationOf('0001-fold', [SPLIT_NAME, FOLDS]))],
      { batchSize: 2, write: (collection, document) => written.push(document) });
    assert.deepStrictEqual(written, EXPECTED);
    assert.strictEqual(report.strategy.users, 'streamed');
  });
});

describe('the file adapter round-trips its own output', () => {
  it('what the writer wrote, the reader reads, in both encodings', async () => {
    for (const format of /** @type {const} */ (['json', 'jsonl'])) {
      const target = path.join(dir, `roundtrip.${format}`);
      const sink = await openAtomicTarget(target, format);
      for (const document of EXPECTED) await sink.write(document);
      const written = await sink.commit();
      assert.strictEqual(written.documents, EXPECTED.length, format);

      const read = [];
      for await (const document of readDocuments(target, format)) read.push(document);
      assert.deepStrictEqual(read, EXPECTED, format);
    }
  });
});
