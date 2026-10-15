//@ts-check
/**
 * @file A many-to-many join table as a root of the client: each
 * many-to-many member of an entity handle holds the read-only handle of
 * its join table (`client.entities.User.memberships.labels`), one handle
 * per table, whose rows are the table's two key columns. A membership is
 * filtered, counted and joined to an entity in ONE document, and each such
 * document runs as one native statement on SQLite and on PostgreSQL that
 * answers what the engine answers (`pushdown: false`). The handle is a
 * chain source of its own (a chain over another source is `JL0005`), it
 * maintains a live query, and a transaction client carries it too.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { fromAsync } from '@jarenjs/linq';
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { nodeDriver } from '@jarenjs/db/node';

import { ENGINES, skipFor, withPostgres } from '../db/store-core-engines.js';

const User = m.object({
  id: m.string().key(),
  name: m.string(),
  labels: m.rel.belongsToMany('Label'),
  posts: m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade' }),
});
const Label = m.object({ name: m.string().key(), color: m.string(), users: m.rel.belongsToMany('User') });
const Post = m.object({ pid: m.integer().key(), authorId: m.string() });
const model = m.defineModel({ entities: { User, Label, Post } });

/**
 * A client over `engine` — a SQLite file in a fresh directory, or a fresh
 * PostgreSQL schema — handed to `fn` with what reads the database beside it.
 * @template T
 * @param {string} engine
 * @param {(client: any, db: { path?: string, pool?: any, schema?: string }) => Promise<T>} fn
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<T>}
 */
async function withClient(engine, fn, options = {}) {
  if (engine === 'sqlite') {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-join-root-'));
    const path = join(dir, 'store.db');
    const client = await open(model, { driver: nodeDriver(), path, validator: null, ...options });
    try { return await fn(client, { path }); }
    finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return withPostgres(async ({ pool, schema, driver }) => {
    const client = await open(model, { driver: driver(), validator: null, ...options });
    try { return await fn(client, { pool, schema }); }
    finally { await client.close(); }
  });
}

/** Three users, three labels; u1 holds admin and dev, u2 dev, u3 none. @param {any} client */
async function seed(client) {
  await client.transaction(async (/** @type {any} */ tx) => {
    for (const [id, name] of [['u1', 'Ann'], ['u2', 'Bob'], ['u3', 'Cy']]) await tx.store.entity('User').create({ id, name });
    for (const [name, color] of [['admin', 'red'], ['dev', 'blue'], ['ops', 'green']]) {
      await tx.store.entity('Label').create({ name, color });
    }
  });
  const users = client.entities.User;
  users.link('u1', 'labels', 'admin');
  users.link('u1', 'labels', 'dev');
  users.link('u2', 'labels', 'dev');
  await client.saveChanges();
}

/** An engine answer as rows: none is `undefined`, one row is the row itself. @param {any} answer */
const rowsOf = (answer) => (answer === undefined ? [] : Array.isArray(answer) ? answer : [answer]);

/**
 * The chain answers `expected`, the engine answers the same for the chain's
 * document, and the store runs that document as one native statement.
 * @param {any} client
 * @param {any} handle - the handle the chain was built from
 * @param {any} chain
 * @param {unknown[]} expected
 */
async function agrees(client, handle, chain, expected) {
  const document = chain.toDocument();
  const externals = chain.explain().bindings;
  assert.deepStrictEqual(await chain.toArray(), expected);
  assert.deepStrictEqual(rowsOf(await client.store.execute(document, { externals, pushdown: false })), expected);
  const plan = await handle.explain(chain);
  assert.strictEqual(plan.mode, 'native', JSON.stringify(plan.reasons));
  return plan;
}

for (const engine of ENGINES) {
  describe(`the join table as a client root on ${engine}`, { skip: skipFor(engine) }, () => {
    it('a membership is filtered on either key, natively', () => withClient(engine, async (client) => {
      await seed(client);
      const memberships = client.entities.User.memberships.labels;
      await agrees(client, memberships,
        memberships.where((j) => j.User_key.eq('u1')).orderBy((j) => j.Label_key).select((j) => j.Label_key),
        ['admin', 'dev']);
      await agrees(client, memberships,
        memberships.where((j) => j.Label_key.eq('dev')).orderBy((j) => j.User_key).select((j) => j.User_key),
        ['u1', 'u2']);
      assert.deepStrictEqual(await memberships.toArray(), [
        { Label_key: 'admin', User_key: 'u1' }, { Label_key: 'dev', User_key: 'u1' }, { Label_key: 'dev', User_key: 'u2' },
      ]);
    }));

    it('a membership is counted per label and in total, natively', () => withClient(engine, async (client) => {
      await seed(client);
      const memberships = client.entities.Label.memberships.users;
      const labels = client.entities.Label;
      await agrees(client, labels,
        labels.groupJoin(fromAsync(memberships), (l) => l.name, (j) => j.Label_key, (l, g) => ({ label: l.name, n: g.count() })),
        [{ label: 'admin', n: 1 }, { label: 'dev', n: 2 }, { label: 'ops', n: 0 }]);
      const dev = memberships.where((j) => j.Label_key.eq('dev'));
      assert.strictEqual(await dev.count(), 2);
      const counted = { $count: dev.toDocument() };
      assert.strictEqual(await client.store.execute(counted, { externals: dev.explain().bindings, pushdown: false }), 2);
      assert.strictEqual((await memberships.explain(counted, { externals: dev.explain().bindings })).mode, 'native');
    }));

    it('a membership joins an entity in one document: the pairs whose label is blue, natively', () => withClient(engine, async (client) => {
      await seed(client);
      const memberships = client.entities.User.memberships.labels;
      const pairs = memberships.join(fromAsync(client.entities.Label), (j) => j.Label_key, (l) => l.name, (j, l) => ({ j, l }))
        .where((x) => x.l.color.eq('blue')).select((x) => ({ user: x.j.User_key, label: x.l.name }));
      const plan = await agrees(client, memberships, pairs, [{ user: 'u1', label: 'dev' }, { user: 'u2', label: 'dev' }]);
      // one statement over the join table and the entity table
      assert.match(plan.sql, /FROM "Label_User" AS "t0" JOIN "Label" AS "t1"/);
    }));

    it('the users who hold no label: a document over the root, handed to the handle, natively', () => withClient(engine, async (client) => {
      await seed(client);
      const memberships = client.entities.User.memberships.labels;
      const document = { $for: { u: '$.User[*]' },
        $where: { $not: { $exists: { $for: { j: '$.Label_User[*]' }, $where: { $eq: ['$j.User_key', '$u.id'] }, $return: '$j' } } },
        $return: '$u.id' };
      assert.strictEqual(await memberships.execute(document), 'u3');
      assert.strictEqual(await client.store.execute(document, { pushdown: false }), 'u3');
      assert.strictEqual((await memberships.explain(document)).mode, 'native');
    }));

    it('a hop read for its count or existence is one native statement, from either side', () => withClient(engine, async (client) => {
      await seed(client);
      const users = client.entities.User;
      const labels = client.entities.Label;
      const plan = await agrees(client, users, users.where((u) => u.labels.all().exists()).select((u) => u.id), ['u1', 'u2']);
      // the join row, then the target row it names, as an existence test inside it
      assert.match(plan.sql, /EXISTS \(SELECT 1 FROM "Label_User" AS "h0" WHERE "h0"\."User_key" = "t0"\."id" AND EXISTS \(SELECT 1 FROM "Label" AS "h1" WHERE "h1"\."name" = "h0"\."Label_key"\)\)/);
      await agrees(client, users, users.where((u) => u.labels.all().exists().not()).select((u) => u.id), ['u3']);
      await agrees(client, users, users.where((u) => u.labels.all().count().ge(2)).select((u) => u.id), ['u1']);
      await agrees(client, users, users.select((u) => ({ id: u.id, n: u.labels.count() })),
        [{ id: 'u1', n: 2 }, { id: 'u2', n: 1 }, { id: 'u3', n: 0 }]);
      await agrees(client, labels, labels.orderBy((l) => l.name).select((l) => ({ name: l.name, n: l.users.all().count() })),
        [{ name: 'admin', n: 1 }, { name: 'dev', n: 2 }, { name: 'ops', n: 0 }]);
      // read as a value, the related rows still run on the engine's set path
      assert.strictEqual((await users.explain(users.select((u) => u.labels))).mode, 'set');
    }));

    it('any hop read for its count through a second hop that reaches one row is one statement; one that reaches several is not', () => withClient(engine, async (client) => {
      await seed(client);
      await client.transaction(async (/** @type {any} */ tx) => {
        await tx.store.entity('Post').create({ pid: 1, authorId: 'u1' });
        await tx.store.entity('Post').create({ pid: 2, authorId: 'u1' });
        await tx.store.entity('Post').create({ pid: 3, authorId: 'u2' });
      });
      /** @param {any} reached */
      const counted = (reached) => ({ $for: { u: '$.User[*]' }, $return: { id: '$u.id', n: { $count: { $for: { r1: '$.Post[*]' },
        $where: { $eq: ['$r1.authorId', '$u.id'] }, $return: reached } } } });
      // each post, then the one user it names
      const keyed = counted({ $for: { r2: '$.User[*]' }, $where: { $eq: ['$r2.id', '$r1.authorId'] }, $return: '$r2' });
      // each post, then every post of its author: several rows each
      const fanned = counted({ $for: { r2: '$.Post[*]' }, $where: { $eq: ['$r2.authorId', '$r1.authorId'] }, $return: '$r2' });
      for (const [document, expected, mode] of /** @type {const} */ ([
        [keyed, [{ id: 'u1', n: 2 }, { id: 'u2', n: 1 }, { id: 'u3', n: 0 }], 'native'],
        [fanned, [{ id: 'u1', n: 4 }, { id: 'u2', n: 1 }, { id: 'u3', n: 0 }], 'set']])) {
        assert.deepStrictEqual(await client.store.execute(document), expected);
        assert.deepStrictEqual(await client.store.execute(document, { pushdown: false }), expected);
        assert.strictEqual((await client.store.explain(document)).mode, mode);
      }
      // a second hop over the join root reaches one row only where both its keys are bound
      /** @param {any} where */
      const throughJoin = (where) => ({ $for: { u: '$.User[*]' }, $return: { id: '$u.id', n: { $count: { $for: { r1: '$.User[*]' },
        $where: { $eq: ['$r1.id', '$u.id'] }, $return: { $for: { r2: '$.Label_User[*]' }, $where: where, $return: '$r2' } } } } });
      for (const [document, expected, mode] of /** @type {const} */ ([
        [throughJoin({ $eq: ['$r2.User_key', '$r1.id'] }), [{ id: 'u1', n: 2 }, { id: 'u2', n: 1 }, { id: 'u3', n: 0 }], 'set'],
        [throughJoin({ $and: [{ $eq: ['$r2.User_key', '$r1.id'] }, { $eq: ['$r2.Label_key', '$r1.name'] }] }),
          [{ id: 'u1', n: 0 }, { id: 'u2', n: 0 }, { id: 'u3', n: 0 }], 'native']])) {
        assert.deepStrictEqual(await client.store.execute(document), expected);
        assert.deepStrictEqual(await client.store.execute(document, { pushdown: false }), expected);
        assert.strictEqual((await client.store.explain(document)).mode, mode);
      }
    }));

    it('a join row whose target row is gone is not counted, natively, as the engine does not count it', (t) => withClient(engine, async (client, db) => {
      await seed(client);
      // a writer that does not enforce the foreign key removes the label
      // 'dev' and leaves its two join rows behind
      if (engine === 'sqlite') {
        const raw = new DatabaseSync(/** @type {string} */ (db.path), { enableForeignKeyConstraints: false });
        try { raw.exec('DELETE FROM "Label" WHERE "name" = \'dev\''); }
        finally { raw.close(); }
      }
      else {
        // only a superuser turns the foreign key's triggers off
        const role = await db.pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
        if (role.rows[0]?.rolsuper !== true) {
          t.skip('the PostgreSQL role is no superuser, so it cannot leave a join row behind its target');
          return;
        }
        const admin = await db.pool.connect();
        try {
          await admin.query('BEGIN');
          await admin.query(`SET LOCAL search_path TO "${db.schema}"`);
          await admin.query('SET LOCAL session_replication_role = replica');
          await admin.query('DELETE FROM "Label" WHERE "name" = \'dev\'');
          await admin.query('COMMIT');
        }
        finally { admin.release(); }
      }
      const users = client.entities.User;
      assert.strictEqual(await client.entities.User.memberships.labels.count(), 3, 'the join rows stay');
      await agrees(client, users, users.select((u) => ({ id: u.id, n: u.labels.all().count() })),
        [{ id: 'u1', n: 1 }, { id: 'u2', n: 0 }, { id: 'u3', n: 0 }]);
      await agrees(client, users, users.where((u) => u.labels.all().exists()).select((u) => u.id), ['u1']);
      await agrees(client, users, users.where((u) => u.labels.all().count().eq(0)).select((u) => u.id), ['u2', 'u3']);
    }));

    it('a filter on the leading key of the join table seeks its primary key', () => withClient(engine, async (client, db) => {
      await seed(client);
      const memberships = client.entities.User.memberships.labels;
      const chain = memberships.where((j) => j.Label_key.eq('dev')).select((j) => j.User_key);
      const { sql } = await memberships.explain(chain);
      if (engine === 'sqlite') {
        const raw = new DatabaseSync(/** @type {string} */ (db.path), { readOnly: true });
        try {
          const details = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('dev').map((/** @type {any} */ row) => row.detail);
          assert.match(details.join('\n'), /SEARCH t0 USING COVERING INDEX sqlite_autoindex_Label_User_1 \(Label_key=\?\)/);
        }
        finally { raw.close(); }
        return;
      }
      const admin = await db.pool.connect();
      try {
        // costed with sequential scans off: the index is usable, not merely unchosen
        await admin.query('BEGIN');
        await admin.query(`SET LOCAL search_path TO "${db.schema}"`);
        await admin.query('SET LOCAL enable_seqscan = off');
        const rows = (await admin.query({ text: `EXPLAIN ${sql}`, values: ['dev'] })).rows;
        const text = rows.map((/** @type {any} */ row) => row['QUERY PLAN']).join('\n');
        // PostgreSQL 16 reaches the key through a bitmap over the same index,
        // its condition beside the column's IS NOT NULL
        assert.match(text, /(Index (Only )?Scan (using|on)|Bitmap Index Scan on) "Label_User_pkey"/);
        assert.match(text, /Index Cond: \((\("Label_key" IS NOT NULL\) AND \()?"Label_key" = /);
      }
      finally {
        await admin.query('ROLLBACK');
        admin.release();
      }
    }));
  });
}

describe('a hop counted through a second hop under a profile that bounds the second hop\'s entity', () => {
  for (const engine of ENGINES) {
    it(`reads that entity as the engine does, natively, on ${engine}`, { skip: skipFor(engine) }, () => withClient(engine, async (client) => {
      await seed(client);
      await client.transaction(async (/** @type {any} */ tx) => {
        await tx.store.entity('Post').create({ pid: 1, authorId: 'u1' });
        await tx.store.entity('Post').create({ pid: 2, authorId: 'u1' });
        await tx.store.entity('Post').create({ pid: 3, authorId: 'u2' });
      });
      // each post: the posts of its author whose author the profile admits
      const document = { $for: { p: '$.Post[*]' }, $return: { pid: '$p.pid', n: { $count: { $for: { r1: '$.Post[*]' },
        $where: { $eq: ['$r1.authorId', '$p.authorId'] },
        $return: { $for: { r2: '$.User[*]' }, $where: { $eq: ['$r2.id', '$r1.authorId'] }, $return: '$r2' } } } } };
      const expected = [{ pid: 1, n: 2 }, { pid: 2, n: 2 }, { pid: 3, n: 0 }];
      assert.deepStrictEqual(await client.store.execute(document), expected);
      assert.deepStrictEqual(await client.store.execute(document, { pushdown: false }), expected);
      assert.strictEqual((await client.store.explain(document)).mode, 'native');
    }, { profile: { predicates: { User: { $eq: ['$it.name', 'Ann'] } } } }));
  }
});

describe('the join handle', () => {
  it('both inverse members hold one handle over the join table; only many-to-many members have one', () => withClient('sqlite', async (client) => {
    const memberships = client.entities.User.memberships.labels;
    assert.strictEqual(client.entities.Label.memberships.users, memberships);
    assert.strictEqual(memberships.root, '$.Label_User[*]');
    assert.strictEqual(memberships.scope, client.entities.User.scope);
    assert.deepStrictEqual(Object.keys(client.entities.User.memberships), ['labels']);
    assert.deepStrictEqual(Object.keys(client.entities.Post.memberships), []);
    assert.ok(Object.isFrozen(memberships) && Object.isFrozen(client.entities.User.memberships));
  }));

  it('a transaction client carries the join handles of its own view', () => withClient('sqlite', async (client) => {
    await seed(client);
    const counted = await client.transaction(async (/** @type {any} */ tx) => {
      tx.entities.User.link('u3', 'labels', 'ops');
      await tx.saveChanges();
      assert.strictEqual(tx.entities.Label.memberships.users, tx.entities.User.memberships.labels);
      return tx.entities.User.memberships.labels.where((j) => j.User_key.eq('u3')).select((j) => j.Label_key).toArray();
    });
    assert.deepStrictEqual(counted, ['ops']);
    assert.strictEqual(await client.entities.User.memberships.labels.count(), 4);
  }));

  it('a chain over another source is JL0005 naming the join table', () => withClient('sqlite', async (client) => {
    const memberships = client.entities.User.memberships.labels;
    assert.throws(() => memberships.execute(client.entities.User.where((u) => u.id.eq('u1'))),
      (/** @type {any} */ error) => error.code === 'JL0005' && error.message.startsWith(
        "JL0005: execute() on join table 'Label_User' was handed a chain built over entity 'User' — "));
    await assert.rejects(client.entities.User.explain(memberships.where((j) => j.User_key.eq('u1'))),
      (/** @type {any} */ error) => error.code === 'JL0005'
        && error.message.includes("explain() on entity 'User' was handed a chain built over join table 'Label_User'"));
  }));

  it('maintains a live query over a counted many-to-many hop, now one statement, as a fresh run answers', () => withClient('sqlite', async (client) => {
    await seed(client);
    const users = client.entities.User;
    const chain = users.select((u) => ({ id: u.id, n: u.labels.count() }));
    const held = users.where((u) => u.labels.all().exists()).select((u) => u.id);
    for (const read of [chain, held]) assert.strictEqual((await users.explain(read)).mode, 'native');
    const live = await users.live(chain);
    const liveHeld = await users.live(held);
    try {
      const fresh = async () => {
        assert.deepStrictEqual(live.result.rows, await chain.toArray());
        assert.deepStrictEqual([...liveHeld.result.rows].sort(), [await held.toArray()].flat().sort());
      };
      await fresh();
      users.link('u3', 'labels', 'ops');
      users.unlink('u1', 'labels', 'dev');
      await client.saveChanges();
      await fresh();
      assert.deepStrictEqual(live.result.rows, [{ id: 'u1', n: 1 }, { id: 'u2', n: 1 }, { id: 'u3', n: 1 }]);
      // a label deleted takes its memberships with it
      await client.transaction(async (/** @type {any} */ tx) => { await tx.store.entity('Label').delete('ops'); });
      await fresh();
      assert.deepStrictEqual([...liveHeld.result.rows].sort(), ['u1', 'u2']);
    }
    finally {
      await live.close();
      await liveHeld.close();
    }
  }, { capture: true }));

  it('maintains a live query over the membership as links and unlinks are saved', () => withClient('sqlite', async (client) => {
    await seed(client);
    const memberships = client.entities.User.memberships.labels;
    const live = await memberships.live(memberships.where((j) => j.Label_key.eq('dev')).select((j) => j.User_key));
    const every = await memberships.live();
    try {
      assert.deepStrictEqual(live.result.rows, ['u1', 'u2']);
      assert.strictEqual(every.result.rows.length, 3);
      client.entities.User.link('u3', 'labels', 'dev');
      client.entities.User.unlink('u1', 'labels', 'dev');
      await client.saveChanges();
      assert.deepStrictEqual([...live.result.rows].sort(), ['u2', 'u3']);
      assert.deepStrictEqual(every.result.rows.map((/** @type {any} */ row) => `${row.Label_key}:${row.User_key}`).sort(),
        ['admin:u1', 'dev:u2', 'dev:u3']);
    }
    finally {
      await live.close();
      await every.close();
    }
  }, { capture: true }));
});
