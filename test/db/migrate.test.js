//@ts-check
/**
 * @file The migration runner: a three-migration evolution read back
 * from the data, the shadow database protecting the real store, the
 * all-or-nothing rollback, the real-data widening/narrowing rule, the
 * dry run writing nothing, and bounded-memory batching.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';

import { JarenValidator } from '@jarenjs/validate';
import { openStore, planMigration, migrate, sqliteDialect } from '@jarenjs/db';
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
const M2 = {
  $model: '0.1',
  collections: {
    users: { ...M0.collections.users, indexes: [{ name: 'by_first', path: '$.first' }] },
    events: M1.collections.events,
  },
};
const M3 = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        required: ['id', 'name'],
        properties: { id: { type: 'string' }, name: { type: 'string' } },
      },
      key: '/id',
      indexes: [{ name: 'by_name', path: '$.name' }],
    },
    events: M1.collections.events,
  },
};

const validator = new JarenValidator({ collectErrors: true, skipErrors: false });
const compileSchema = (schema) => validator.compile(schema);
const driver = () => nodeDriver();

/** The three-step chain: add a collection, add an index, split a field. */
function chainFor() {
  const m1 = planMigration(M0, M1, { dialect: sqliteDialect, id: '0001-add-events' }).migration;
  const m2 = planMigration(M1, M2, { dialect: sqliteDialect, id: '0002-index-first' }).migration;
  const m3 = planMigration(M2, M3, { dialect: sqliteDialect, id: '0003-split-name' }).migration;
  const jslt = m3.steps.find((step) => step.kind === 'jslt');
  delete jslt.draft;
  jslt.stylesheet = [{
    match: '$',
    body: {
      id: '$.id',
      name: { $concat: [{ $default: ['$.first', ''] }, ' ', { $default: ['$.last', ''] }] },
    },
  }];
  m3.steps.push({
    kind: 'query',
    collection: 'users',
    assert: { $for: { it: '$[*]' }, $where: { $empty: '$it.name' }, $return: '$it.id' },
    note: 'every user must carry a name after the split',
  });
  return [m1, m2, m3];
}

async function seeded() {
  const { dbPath, cleanup } = tempDbPath();
  const store = await openStore(M0, { driver: driver(), path: dbPath });
  await store.collection('users').insert({ id: 'u1', first: 'Ada', last: 'Lovelace' });
  await store.collection('users').insert({ id: 'u2', first: 'Lin', last: 'Zed' });
  await store.close();
  return { dbPath, cleanup };
}

describe('a three-migration evolution', () => {
  it('applies, and the data reads back exactly as the transforms specify', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      const migrations = chainFor();
      const progress = [];
      const out = await migrate({ driver: driver(), path: dbPath }, migrations, {
        baseline: M0, model: M3, compileSchema,
        onProgress: (record) => progress.push(record),
      });
      assert.deepStrictEqual(out.applied,
        ['0001-add-events', '0002-index-first', '0003-split-name']);

      const store = await openStore(M3, { driver: driver(), path: dbPath });
      assert.deepStrictEqual(await store.collection('users').get('u1'),
        { id: 'u1', name: 'Ada Lovelace' });
      assert.deepStrictEqual(await store.collection('users').get('u2'),
        { id: 'u2', name: 'Lin Zed' });
      const viaIndex = await store.collection('users').execute(
        { $for: { it: '$[*]' }, $where: { $eq: ['$it.name', 'Lin Zed'] }, $return: '$it.id' });
      assert.strictEqual(viaIndex, 'u2', 'the new index answers');
      assert.strictEqual(progress.length > 0, true, 'batch progress reported');
      await store.close();

      // idempotent: a second run applies nothing
      const again = await migrate({ driver: driver(), path: dbPath }, migrations,
        { baseline: M0, model: M3 });
      assert.strictEqual(again.upToDate, true);
      assert.deepStrictEqual(again.applied, []);
    }
    finally {
      cleanup();
    }
  });
});

describe('the widening/narrowing rule runs against real data', () => {
  it('a narrowing with only an identity transform is JD0021 and rolls back', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      // the author "filled in" the draft with the identity — the real
      // data (no `name` member) fails the target schema and the run
      // refuses; deleting draft is not enough, the FACTS must pass
      const migrations = chainFor();
      const jslt = migrations[2].steps.find((step) => step.kind === 'jslt');
      jslt.stylesheet = [];
      migrations[2].steps = migrations[2].steps.filter((step) => step.kind !== 'query');
      await assert.rejects(
        () => migrate({ driver: driver(), path: dbPath }, migrations,
          { baseline: M0, model: M3, compileSchema }),
        (error) => {
          assert.strictEqual(error.code, 'JD0021');
          assert.match(error.message, /does not validate/);
          return true;
        });
      // the failing migration rolled back whole: the store still opens
      // at M2's shape (the first two applied), data untouched
      const store = await openStore(M2, { driver: driver(), path: dbPath });
      assert.deepStrictEqual(await store.collection('users').get('u1'),
        { id: 'u1', first: 'Ada', last: 'Lovelace' });
      await store.close();
    }
    finally {
      cleanup();
    }
  });

  it('a pure widening runs with NO transform, proven on the stored documents', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      const widened = structuredClone(M0);
      widened.collections.users.schema.properties.nick = { type: 'string' };
      const { migration } = planMigration(M0, widened,
        { dialect: sqliteDialect, id: '0001-widen' });
      // the planner drafted a transform; the author DELETES it — a
      // widening needs none, and the real-data validation proves it
      migration.steps = migration.steps.filter((step) => step.kind !== 'jslt');
      const out = await migrate({ driver: driver(), path: dbPath }, [migration],
        { baseline: M0, model: widened, compileSchema });
      assert.deepStrictEqual(out.applied, ['0001-widen']);
      const store = await openStore(widened, { driver: driver(), path: dbPath });
      assert.deepStrictEqual(await store.collection('users').get('u1'),
        { id: 'u1', first: 'Ada', last: 'Lovelace' });
      await store.close();
    }
    finally {
      cleanup();
    }
  });
});

describe('failure semantics', () => {
  it('a failing step rolls back the entire migration, including earlier steps', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      const migration = {
        $migration: '0.1',
        id: '0001-doomed',
        from: planMigration(M0, M0, { dialect: sqliteDialect }).migration.from,
        to: 'anywhere',
        steps: [
          {
            kind: 'jslt',
            collection: 'users',
            stylesheet: [{ match: '$.first', body: { $upper: '$' } }],
          },
          {
            kind: 'query',
            collection: 'users',
            assert: { $for: { it: '$[*]' }, $return: '$it.id' },
            note: 'always fails: every user is returned',
          },
        ],
      };
      await assert.rejects(
        () => migrate({ driver: driver(), path: dbPath }, [migration],
          { baseline: M0, shadow: false }),
        (error) => {
          assert.strictEqual(error.code, 'JD0023');
          assert.match(error.message, /expected an empty sequence/);
          return true;
        });
      const store = await openStore(M0, { driver: driver(), path: dbPath });
      assert.strictEqual((await store.collection('users').get('u1')).first, 'Ada',
        'the earlier successful jslt step rolled back too');
      await store.close();
    }
    finally {
      cleanup();
    }
  });

  it('a shadow failure leaves the real store untouched, history empty', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      const migration = {
        $migration: '0.1',
        id: '0001-bad-ddl',
        from: planMigration(M0, M0, { dialect: sqliteDialect }).migration.from,
        to: 'nowhere',
        steps: [{ kind: 'ddl', sql: 'CREATE INDEX "nope" ON "ghosts" ("gone")' }],
      };
      await assert.rejects(
        () => migrate({ driver: driver(), path: dbPath }, [migration], { baseline: M0 }),
        (error) => error.code === 'JD0023');
      // untouched: M0 still opens, data intact, nothing recorded
      const store = await openStore(M0, { driver: driver(), path: dbPath });
      assert.strictEqual((await store.collection('users').get('u1')).first, 'Ada');
      await store.close();
      const rerun = await migrate({ driver: driver(), path: dbPath }, [], { baseline: M0 });
      assert.deepStrictEqual(rerun.skipped, [], 'the history recorded nothing');
    }
    finally {
      cleanup();
    }
  });

  it('dryRun prints every statement and affected count and writes nothing', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      const migrations = chainFor();
      const dry = await migrate({ driver: driver(), path: dbPath }, migrations,
        { baseline: M0, model: M3, dryRun: true });
      assert.strictEqual(dry.dryRun, true);
      assert.deepStrictEqual(dry.pending,
        ['0001-add-events', '0002-index-first', '0003-split-name']);
      assert.ok(dry.statements.some((sql) => /^CREATE TABLE "events"/.test(sql)));
      assert.ok(dry.statements.some((line) => /jslt transform over 'users'/.test(line)));
      assert.strictEqual(dry.counts.users, 2, 'the affected count is real');
      assert.strictEqual(dry.shadowValidated, true);
      // nothing written: the M0 store still opens and reads
      const store = await openStore(M0, { driver: driver(), path: dbPath });
      assert.strictEqual((await store.collection('users').get('u2')).last, 'Zed');
      await store.close();
      const rerun = await migrate({ driver: driver(), path: dbPath }, migrations,
        { baseline: M0, model: M3, dryRun: true });
      assert.deepStrictEqual(rerun.pending.length, 3, 'still fully pending');
    }
    finally {
      cleanup();
    }
  });
});

describe('batching stays bounded', () => {
  it('a collection larger than one batch transforms correctly with a flat live set', () => {
    const script = `
      import { openStore, planMigration, migrate, sqliteDialect } from '@jarenjs/db';
      import { nodeDriver } from '@jarenjs/db/node';
      const M0 = { $model: '0.1', collections: { rows: {
        schema: { type: 'object', properties: { n: { type: 'integer' } } },
        key: null, identity: 'integer' } } };
      const M1 = structuredClone(M0);
      M1.collections.rows.schema.properties.twice = { type: 'integer' };
      const store = await openStore(M0, { driver: nodeDriver(), path: process.argv[1] });
      const rows = store.sync.collection('rows');
      for (let i = 0; i < 10000; i++) rows.insert({ n: i, pad: 'x'.repeat(64) });
      await store.close();
      const { migration } = planMigration(M0, M1, { dialect: sqliteDialect, id: 'twice' });
      const jslt = migration.steps.find((s) => s.kind === 'jslt');
      delete jslt.draft;
      jslt.stylesheet = [{ match: '$', body: { n: '$.n', pad: '$.pad', twice: { $mul: ['$.n', 2] } } }];
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      await migrate({ driver: nodeDriver(), path: process.argv[1] }, [migration],
        { baseline: M0, model: M1, batchSize: 200, shadow: false });
      globalThis.gc();
      const growthMb = (process.memoryUsage().heapUsed - before) / 1048576;
      const check = await openStore(M1, { driver: nodeDriver(), path: process.argv[1] });
      const hit = await check.collection('rows').execute(
        { $count: { $for: { it: '$[*]' }, $where: { $eq: ['$it.twice', 13106] }, $return: '$it' } });
      await check.close();
      console.log(JSON.stringify({ growthMb, hit }));
    `;
    const { dbPath, cleanup } = tempDbPath();
    try {
      const out = execFileSync(process.execPath,
        ['--no-warnings=ExperimentalWarning', '--expose-gc', '--input-type=module',
          '-e', script, dbPath],
        { encoding: 'utf8', cwd: process.cwd() });
      const { growthMb, hit } = JSON.parse(out.trim().split('\n').pop() ?? '{}');
      assert.strictEqual(hit, 1, 'row 6553 transformed to twice=13106');
      assert.strictEqual(growthMb < 8, true,
        `live set grew ${growthMb.toFixed(2)} MB over 10k transformed rows`);
    }
    finally {
      cleanup();
    }
  });
});
