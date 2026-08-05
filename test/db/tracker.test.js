//@ts-check
/**
 * @file The unit of work's tracking half: materialised entities are
 * plain deep-frozen JSON with no proxies anywhere; every row of the
 * diff-to-statement table (§11.3) produces exactly its minimal
 * statement; the whole-row fallback is counted; relation members
 * refuse edits; the version member is engine-owned; `asNoTracking()`
 * retains nothing (proven by a forced-GC live set in a subprocess).
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as util from 'node:util';
import { spawnSync } from 'node:child_process';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          name: { type: 'string' },
          age: { type: 'integer' },
          active: { type: 'boolean' },
          joined: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } },
          ver: { type: 'integer', 'x-entity': { version: true } },
          profile: { type: 'object', properties: {
            bio: { type: 'string' }, tags: { type: 'array' } } },
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
          labels: { 'x-entity': { relation: { to: 'Label', many: true } } },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        required: ['pid', 'authorId'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } },
          title: { type: 'string' },
          authorId: { type: 'string' },
        },
      },
    },
    Label: {
      schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', 'x-entity': { key: true } } },
      },
    },
  },
};

const BASE = {
  id: 'u1', name: 'ada', age: 36, active: true, ver: 0,
  joined: '2026-01-05T10:00:00Z',
  profile: { bio: 'x', tags: ['a', 'b'] },
};

/** @type {any} */
let store = null;
before(async () => {
  store = await openStore(MODEL, { driver: nodeDriver() });
  await store.entity('User').create(BASE);
  for (const name of ['admin', 'dev']) await store.entity('Label').create({ name });
});
after(async () => {
  if (store !== null) await store.close();
});

const users = () => store.entity('User');
const saveAfterPut = async (next) => {
  users().put(next);
  return store.saveChanges();
};

describe('materialised entities are plain frozen JSON', () => {
  it('reads are deep-frozen, unproxied, and retained once', async () => {
    const doc = await users().get('u1');
    assert.strictEqual(Object.isFrozen(doc), true);
    assert.strictEqual(Object.isFrozen(doc.profile), true);
    assert.strictEqual(Object.isFrozen(doc.profile.tags), true);
    assert.strictEqual(util.types.isProxy(doc), false);
    assert.strictEqual(util.types.isProxy(doc.profile), false);
    assert.strictEqual(Object.getPrototypeOf(doc), Object.prototype,
      'a plain object, not an instrumented instance');
    assert.strictEqual(store.stats().tracker.tracked >= 1, true);
    const again = await users().get('u1');
    assert.strictEqual(store.stats().tracker.tracked,
      (await (async () => store.stats().tracker.tracked)()),
      'a re-read refreshes, never duplicates');
    assert.deepStrictEqual(again, doc);
  });

  it('a no-op replacement writes nothing — stamps never invent a write', async () => {
    const doc = await users().get('u1');
    const report = await saveAfterPut(structuredClone(doc));
    assert.strictEqual(report.statements.length, 0);
    assert.strictEqual(report.updated, 0);
  });
});

describe('the diff-to-statement table (§11.3)', () => {
  it('a scalar column member is one column write, no document touch', async () => {
    const doc = await users().get('u1');
    const report = await saveAfterPut({ ...doc, age: doc.age + 1 });
    assert.strictEqual(report.statements.length, 1);
    assert.match(report.statements[0].sql, /SET "age" = \?, "ver" = \?/);
    assert.doesNotMatch(report.statements[0].sql, /jsonb_set|"doc" =/);
  });

  it('a boolean column encodes 1/0; a removed member writes NULL', async () => {
    const doc = await users().get('u1');
    const flipped = await saveAfterPut({ ...doc, active: false });
    assert.match(flipped.statements[0].sql, /SET "active" = \?/);
    const doc2 = await users().get('u1');
    const dropped = { ...doc2 };
    delete dropped.age;
    const report = await saveAfterPut(dropped);
    assert.match(report.statements[0].sql, /SET "age" = \?/);
    const stored = await users().asNoTracking().get('u1');
    assert.strictEqual(stored.age, undefined, 'absent, per §9.3');
    assert.strictEqual(stored.active, false);
  });

  it('a document path is a jsonb_set chain; a removal is jsonb_remove', async () => {
    const doc = await users().get('u1');
    const set = await saveAfterPut({
      ...doc, profile: { ...doc.profile, bio: 'longer text' } });
    assert.strictEqual(set.statements.length, 1);
    assert.match(set.statements[0].sql,
      /"doc" = jsonb_set\("doc", '\$\."profile"\."bio"'/);
    assert.doesNotMatch(set.statements[0].sql, /SET "age"|"name" =/);

    const doc2 = await users().get('u1');
    const next = { ...doc2, profile: { tags: doc2.profile.tags } };
    const removed = await saveAfterPut(next);
    assert.match(removed.statements[0].sql, /jsonb_remove\("doc", '\$\."profile"\."bio"'\)/);
  });

  it('an instant member writes the epoch column AND the document string', async () => {
    const doc = await users().get('u1');
    const report = await saveAfterPut({ ...doc, joined: '2026-06-01T00:00:00Z' });
    const sql = report.statements[0].sql;
    assert.match(sql, /SET "joined" = \?/);
    assert.match(sql, /jsonb_set\("doc", '\$\."joined"'/);
    const stored = await users().asNoTracking().get('u1');
    assert.strictEqual(stored.joined, '2026-06-01T00:00:00Z');
  });

  it('a many-to-many member synchronises the join table by key sets', async () => {
    const doc = await users().get('u1');
    const grew = await saveAfterPut({ ...doc, labels: ['admin', 'dev'] });
    assert.strictEqual(grew.joinInserted, 2);
    assert.strictEqual(grew.updated, 0, 'no row write for a join-only change');
    assert.match(grew.statements[0].sql, /INSERT INTO "Label_User"/);

    // element docs work too, and removal deletes exactly the difference
    const loaded = await users().load({ include: { labels: true } });
    const withDocs = loaded[0];
    const shrunk = await saveAfterPut({
      ...withDocs, labels: withDocs.labels.filter((l) => l.name === 'dev') });
    assert.strictEqual(shrunk.joinDeleted, 1);
    assert.match(shrunk.statements[0].sql, /DELETE FROM "Label_User"/);
  });

  it('an untranslatable operation falls back to a whole-row write, counted', async () => {
    const doc = await users().get('u1');
    // a mid-array insert has no single JSON-function spelling
    const report = await saveAfterPut({
      ...doc, profile: { ...doc.profile, tags: ['z', ...doc.profile.tags] } });
    assert.strictEqual(report.fallbacks, 1);
    assert.match(report.statements[0].sql, /"doc" = jsonb\(\?\)/,
      'the whole document ships once');
    const stored = await users().asNoTracking().get('u1');
    assert.deepStrictEqual(stored.profile.tags, ['z', 'a', 'b']);
  });

  it('the version member is engine-owned: edits to it are overwritten', async () => {
    const doc = await users().get('u1');
    const report = await saveAfterPut({ ...doc, name: 'ada2', ver: 999 });
    assert.strictEqual(report.updated, 1);
    const stored = await users().asNoTracking().get('u1');
    assert.strictEqual(stored.ver, doc.ver + 1, 'snapshot version + 1, never 999');
  });

  it('a one-to-many relation member refuses edits — projections are not state', async () => {
    const doc = await users().get('u1');
    users().put({ ...doc, posts: [{ pid: 99, title: 'ghost', authorId: 'u1' }] });
    await assert.rejects(() => store.saveChanges(), (error) => {
      assert.strictEqual(/** @type {any} */ (error).code, 'JD2003');
      assert.match(/** @type {any} */ (error).message, /relation member/);
      return true;
    });
    users().discard('u1');
  });

  it('put() refuses untracked keys and non-documents', async () => {
    assert.throws(() => users().put({ id: 'nobody', name: 'x' }),
      (error) => /** @type {any} */ (error).code === 'JD2006');
    assert.throws(() => users().put('u1'),
      (error) => /** @type {any} */ (error).code === 'JD2003');
  });
});

describe('asNoTracking retains nothing', () => {
  it('untracked reads register no snapshot', async () => {
    const before_ = store.stats().tracker.tracked;
    const plain = await users().asNoTracking().get('u1');
    assert.strictEqual(Object.isFrozen(plain), false,
      'an untracked read is plain data, yours to mutate');
    assert.strictEqual(store.stats().tracker.tracked, before_);
  });

  it('a large untracked read shows a bounded live set after forced GC', () => {
    const script = `
      const { openStore } = await import(${JSON.stringify(new URL('../../packages/db/src/index.js', import.meta.url).href)});
      const { nodeDriver } = await import(${JSON.stringify(new URL('../../packages/db/src/drivers/node.js', import.meta.url).href)});
      const model = { $model: '0.1', entities: { Row: { schema: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'integer', 'x-entity': { key: true } },
          blob: { type: 'object' } } } } } };
      const store = await openStore(model, { driver: nodeDriver() });
      const rows = store.entity('Row');
      for (let i = 0; i < 2000; i++)
        await rows.create({ id: i, blob: { text: 'x'.repeat(500), i } });
      // drop creation tracking so only the mode under test retains
      for (let i = 0; i < 2000; i++) rows.discard(i);
      globalThis.gc();
      const baseline = process.memoryUsage().heapUsed;
      const mode = process.argv[2];
      for (let round = 0; round < 5; round++) {
        const reader = mode === 'tracked' ? rows : rows.asNoTracking();
        for (let i = 0; i < 2000; i++) await reader.get(i);
        if (mode === 'tracked') for (let i = 0; i < 2000; i++) rows.discard(i);
      }
      globalThis.gc();
      console.log(JSON.stringify({
        delta: process.memoryUsage().heapUsed - baseline,
        tracked: store.stats().tracker.tracked,
      }));
      await store.close();
    `;
    const run = (mode) => {
      const out = spawnSync(process.execPath,
        ['--expose-gc', '--no-warnings=ExperimentalWarning',
          '--input-type=module', '-e', script, mode],
        { encoding: 'utf8' });
      assert.strictEqual(out.status, 0, out.stderr);
      return JSON.parse(out.stdout.trim().split('\n').pop());
    };
    const untracked = run('untracked');
    assert.strictEqual(untracked.tracked, 0, 'nothing retained');
    // 10k reads of ~500-byte docs: the live set stays far below the
    // ~1 MB a single retained generation would cost
    assert.ok(untracked.delta < 1_500_000,
      `untracked live set grew ${untracked.delta} bytes`);
  });
});
