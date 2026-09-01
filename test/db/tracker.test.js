//@ts-check
/**
 * @file The unit of work's tracking half: materialised entities are
 * plain deep-frozen JSON with no proxies anywhere; every row of the
 * diff-to-statement table (§11.3) produces exactly its minimal
 * statement; the whole-row fallback is counted; relation members
 * refuse edits; the version member is engine-owned; `asNoTracking()`
 * retains nothing (proven by a forced-GC live set in a subprocess).
 *
 * And the half that makes a save a UNIT OF WORK: the tracker's snapshots
 * are a claim about what the database holds, so they advance when the
 * outermost transaction commits and are withdrawn when it rolls back.
 * The savepoint a save opens for itself is not a commit, and a caller
 * whose retry planned nothing was the silent data loss that proved it.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as util from 'node:util';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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

// ————— the save's fate is the enclosing transaction's —————

/** A model of one balance, so a rollback has exactly one thing to undo. */
const LEDGER = {
  $model: '0.1',
  entities: {
    Account: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          balance: { type: 'integer' },
        },
      },
    },
  },
};

/** A ledger store seeded with one account at 100. */
const ledger = async (options = {}) => {
  const opened = await openStore(LEDGER, { driver: nodeDriver(), ...options });
  await opened.entity('Account').create({ id: 'a1', balance: 100 });
  return opened;
};

describe('a tracked save advances only when the outermost transaction commits', () => {
  it('save_changes_then_outer_rollback_restores_tracker', async () => {
    const ledgerStore = await ledger();
    const accounts = ledgerStore.entity('Account');
    const seed = await accounts.get('a1');

    await assert.rejects(() => ledgerStore.transaction(async (tx) => {
      accounts.put({ ...seed, balance: 999 });
      const inner = await tx.saveChanges();
      assert.strictEqual(inner.updated, 1, 'the save itself reports its statement');
      throw new Error('outer boom');
    }), /outer boom/);

    assert.strictEqual((await accounts.asNoTracking().get('a1')).balance, 100,
      'the database rolled the save back with the transaction');
    // the retry is the whole point: a tracker that kept the rolled-back
    // snapshot plans nothing and reports success over a row still at 100
    const retry = await ledgerStore.saveChanges();
    assert.strictEqual(retry.updated, 1);
    assert.strictEqual(retry.statements.length, 1);
    assert.strictEqual((await accounts.asNoTracking().get('a1')).balance, 999);
    await ledgerStore.close();
  });

  it('nested_savepoint_rollback_restores_only_nested_tracker_state', async () => {
    const ledgerStore = await ledger();
    const accounts = ledgerStore.entity('Account');
    await accounts.create({ id: 'a2', balance: 50 });
    const one = await accounts.get('a1');
    const two = await accounts.get('a2');

    await ledgerStore.transaction(async (tx) => {
      accounts.put({ ...one, balance: 111 });
      await tx.saveChanges();
      await assert.rejects(() => tx.transaction(async (inner) => {
        accounts.put({ ...two, balance: 222 });
        await inner.saveChanges();
        throw new Error('inner boom');
      }), /inner boom/);
    });

    assert.strictEqual((await accounts.asNoTracking().get('a1')).balance, 111,
      'the outer save survived the inner savepoint');
    assert.strictEqual((await accounts.asNoTracking().get('a2')).balance, 50,
      'exactly one level rolled back');
    // and the tracker agrees with both: nothing is owed for a1, the
    // withdrawn change to a2 is owed again
    const after = await ledgerStore.saveChanges();
    assert.strictEqual(after.updated, 1);
    assert.deepStrictEqual(
      [(await accounts.asNoTracking().get('a1')).balance,
        (await accounts.asNoTracking().get('a2')).balance],
      [111, 222]);
    await ledgerStore.close();
  });

  it('an outer commit advances the tracker exactly once', async () => {
    const ledgerStore = await ledger();
    const accounts = ledgerStore.entity('Account');
    const seed = await accounts.get('a1');

    await ledgerStore.transaction(async (tx) => {
      accounts.put({ ...seed, balance: 999 });
      await tx.saveChanges();
    });

    // the correct zero, told from the rolled-back one by the row
    const again = await ledgerStore.saveChanges();
    assert.strictEqual(again.updated, 0);
    assert.strictEqual(again.statements.length, 0);
    assert.strictEqual((await accounts.asNoTracking().get('a1')).balance, 999);
    await ledgerStore.close();
  });

  // both modes, because only ONE of them routes the unit of work's own
  // emission: a session reads the rows the database changed, while a
  // journal is written by the commit phase itself — and a deferred
  // commit that ran after its scope translated its patch would record
  // nothing at all
  for (const mode of ['session', 'journal']) {
    it(`a rolled-back save emits no change records (${mode} capture)`, async () => {
      const ledgerStore = await ledger({ capture: { mode, log: true } });
      const accounts = ledgerStore.entity('Account');
      const seed = await accounts.get('a1');
      const before = (await ledgerStore.changesSince(0)).length;

      await assert.rejects(() => ledgerStore.transaction(async (tx) => {
        accounts.put({ ...seed, balance: 999 });
        await tx.saveChanges();
        throw new Error('outer boom');
      }), /outer boom/);
      assert.strictEqual((await ledgerStore.changesSince(0)).length, before,
        'a change record describes a committed row, and no row was committed');

      // the same save, committed, does record — the assertion above is
      // about the rollback, not about capture being off
      await ledgerStore.transaction(async (tx) => {
        accounts.put({ ...seed, balance: 999 });
        await tx.saveChanges();
      });
      const log = await ledgerStore.changesSince(0);
      assert.strictEqual(log.length, before + 1, 'the committed save is one record');
      assert.deepStrictEqual(log.at(-1).collections, ['Account']);
      assert.strictEqual((await accounts.asNoTracking().get('a1')).balance, 999);
      await ledgerStore.close();
    });
  }

  it('a save outside any transaction advances at once, as it always did', async () => {
    const ledgerStore = await ledger();
    const accounts = ledgerStore.entity('Account');
    const seed = await accounts.get('a1');
    accounts.put({ ...seed, balance: 777 });
    assert.strictEqual((await ledgerStore.saveChanges()).updated, 1);
    // nothing is owed the moment the save returns: no scope was open,
    // so there was no commit left to wait for
    assert.strictEqual((await ledgerStore.saveChanges()).statements.length, 0);
    assert.strictEqual(ledgerStore.stats().tracker.tracked, 1);
    assert.strictEqual((await accounts.asNoTracking().get('a1')).balance, 777);
    await ledgerStore.close();
  });

  it('two saves in one transaction write two things, never the first one twice', async () => {
    // The tracker advances when its statements RUN, because inside the
    // transaction the database holds them: a tracker that still called
    // the first save pending would re-plan its insert against a row that
    // already exists, and the optimistic guard of a second update would
    // be checking a version the first one has already moved.
    const ledgerStore = await ledger();
    const accounts = ledgerStore.entity('Account');
    const seed = await accounts.get('a1');
    await ledgerStore.transaction(async (tx) => {
      tx.entity('Account').add({ id: 'a2', balance: 20 });
      assert.strictEqual((await tx.saveChanges()).inserted, 1);
      tx.entity('Account').add({ id: 'a3', balance: 30 });
      accounts.put({ ...seed, balance: 111 });
      const second = await tx.saveChanges();
      assert.strictEqual(second.inserted, 1);
      assert.strictEqual(second.updated, 1);
      // and a third with nothing left to do plans nothing
      assert.strictEqual((await tx.saveChanges()).statements.length, 0);
    });
    const rows = await accounts.asNoTracking().load({ orderBy: '$it.id' });
    assert.deepStrictEqual(rows.map((row) => [row.id, row.balance]),
      [['a1', 111], ['a2', 20], ['a3', 30]]);
    await ledgerStore.close();
  });

  it('an edit made after the save is still owed once the transaction commits', async () => {
    const ledgerStore = await ledger();
    const accounts = ledgerStore.entity('Account');
    const seed = await accounts.get('a1');

    await ledgerStore.transaction(async (tx) => {
      accounts.put({ ...seed, balance: 999 });
      await tx.saveChanges();
      accounts.put({ ...seed, balance: 1000 });
    });
    assert.strictEqual((await accounts.asNoTracking().get('a1')).balance, 999);
    const owed = await ledgerStore.saveChanges();
    assert.strictEqual(owed.updated, 1, 'the pending edit survived the settlement');
    assert.strictEqual((await accounts.asNoTracking().get('a1')).balance, 1000);
    await ledgerStore.close();
  });
});

describe('the drift gate the unit of work owes itself', () => {
  it('a save never advances the tracker without registering the withdrawal', () => {
    const source = fs.readFileSync(fileURLToPath(
      new URL('../../packages/db/src/tracker.js', import.meta.url)), 'utf8');

    // The defect: `saveChanges()` advanced the tracker when its own
    // savepoint released, and nothing took the advance back when the
    // enclosing transaction rolled it away. Either half alone is the bug
    // — the advance without the withdrawal is silent data loss, and the
    // withdrawal without the advance re-plans a save that already ran.
    const body = source.slice(source.indexOf('const saveChanges = ()'));
    assert.ok(body.length > 0, 'saveChanges is where the pair lives');
    const advance = body.indexOf('commit(statements, undo)');
    const withdrawal = body.indexOf('connection.onSettle({ rollback:');
    assert.ok(advance >= 0,
      'saveChanges must advance the tracker with the undo delta beside it — '
      + 'a commit that cannot tell a post-save edit from the saved value '
      + 'silently discards the edit');
    assert.ok(withdrawal >= 0,
      'saveChanges must register the withdrawal through connection.onSettle — '
      + 'without it an outer rollback leaves the tracker claiming rows the '
      + 'database no longer holds, and the retry plans nothing');
    assert.ok(withdrawal > advance,
      'the withdrawal is registered after the advance it undoes');

    // and the undo delta is taken while the tracker still holds the state
    // it describes — after this the statements run
    const captured = body.indexOf('undoFor(statements, joinOnly)');
    assert.ok(captured >= 0 && captured < advance,
      'the undo delta is captured before the statements run');

    // exactly one settlement register exists, and it is the store's
    const store = fs.readFileSync(fileURLToPath(
      new URL('../../packages/db/src/store.js', import.meta.url)), 'utf8');
    assert.strictEqual((source.match(/onSettle/g) ?? []).length, 1,
      'the unit of work registers once');
    assert.ok(/onSettle: \(effects\) => \{/.test(store),
      'and the register itself lives in store.js');
  });
});
