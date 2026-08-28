//@ts-check
/**
 * @file Entity sets: the three identity strategies (plus composite
 * keys), defaults applied in JavaScript with the returned object equal
 * to storage, `updated` stamps, real foreign keys with all three
 * on-delete behaviours observed, the strip-`x-entity` proof, and the
 * phase-A compatibility proof.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { JarenValidator } from '@jarenjs/validate';
import { dateTimeFormats } from '@jarenjs/formats';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true, default: 'uuid' } },
          email: { type: 'string', 'x-entity': { unique: true } },
          role: { type: 'string', enum: ['admin', 'user'], 'x-entity': { default: { value: 'user' } } },
          slug: { type: 'string', 'x-entity': { default: { query: { $lower: '$.email' } } } },
          created: { type: 'string', format: 'date-time', 'x-entity': { default: 'now', column: 'integer', index: true } },
          touched: { type: 'string', format: 'date-time', 'x-entity': { default: 'updated', column: 'integer' } },
          profile: { type: 'object' },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        required: ['pid', 'title'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } },
          title: { type: 'string' },
          authorId: { type: 'string' },
        },
      },
    },
  },
};
MODEL.entities.User.schema.properties.posts = {
  'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } },
};

describe('identity and defaults', () => {
  it('uuid and auto keys allocate; the returned object equals storage', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const users = store.entity('User');
    const created = await users.create({ email: 'Ada@X.Test', profile: { bio: 'hi' } });
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.strictEqual(created.role, 'user', 'the literal default');
    assert.strictEqual(created.slug, 'ada@x.test', 'the query-derived default');
    assert.match(created.created, /^\d{4}-\d{2}-\d{2}T/);
    const stored = await users.get(created.id);
    assert.deepStrictEqual(stored, created,
      'the value the application sees IS the value stored');

    const posts = store.entity('Post');
    const first = await posts.create({ title: 'one', authorId: created.id });
    const second = await posts.create({ title: 'two', authorId: created.id });
    assert.strictEqual(typeof first.pid, 'number');
    assert.strictEqual(second.pid, first.pid + 1, 'auto allocation');
    await store.close();
  });

  it('composite keys read, update and delete by their full shape', async () => {
    const model = {
      $model: '0.1',
      entities: {
        Grade: {
          schema: {
            type: 'object',
            properties: {
              student: { type: 'string', 'x-entity': { key: true } },
              course: { type: 'string', 'x-entity': { key: true } },
              score: { type: 'integer' },
            },
          },
        },
      },
    };
    const store = await openStore(model, { driver: nodeDriver() });
    const grades = store.entity('Grade');
    await grades.create({ student: 'ada', course: 'math', score: 90 });
    await grades.create({ student: 'ada', course: 'poetry', score: 100 });
    assert.strictEqual((await grades.get({ student: 'ada', course: 'math' })).score, 90);
    const updated = await grades.update({ student: 'ada', course: 'math' }, { score: 95 });
    assert.strictEqual(updated.score, 95);
    assert.strictEqual(await grades.delete({ student: 'ada', course: 'poetry' }), true);
    assert.strictEqual(await grades.get({ student: 'ada', course: 'poetry' }), undefined);
    // the promise-free twin mirrors every entity operation
    const sync = store.sync.entity('Grade');
    const made = sync.create({ student: 'lin', course: 'math', score: 70 });
    assert.strictEqual(made.score, 70);
    assert.strictEqual(sync.update({ student: 'lin', course: 'math' }, { score: 71 }).score, 71);
    assert.strictEqual(sync.get({ student: 'lin', course: 'math' }).score, 71);
    assert.strictEqual(sync.delete({ student: 'lin', course: 'math' }), true);
    await assert.rejects(async () => store.sync === undefined
      ? undefined : store.sync.entity('Grade').get('ada'),
    (error) => error.code === 'JD2002', 'a bare scalar is not a composite key');
    await store.close();
  });

  it("an 'updated' stamp changes on every update; validation sees completed documents", async () => {
    // the model stamps `updated` as format: 'date-time' — registering the
    // compilers means the test verifies the stamp, not just its presence
    const validator = new JarenValidator({ collectErrors: true, skipErrors: false })
      .addFormats(dateTimeFormats);
    const store = await openStore(MODEL, {
      driver: nodeDriver(),
      compileSchema: (schema) => validator.compile(schema),
    });
    const users = store.entity('User');
    const created = await users.create({ email: 'lin@x.test' });
    await new Promise((resolve) => setTimeout(resolve, 3));
    const after = await users.update(created.id, { profile: { bio: 'new' } });
    assert.notStrictEqual(after.touched, created.touched);
    assert.strictEqual(after.created, created.created, "'now' stamps only on insert");
    assert.deepStrictEqual(await users.get(created.id), after);

    await assert.rejects(() => users.create({ profile: {} }),
      (error) => error.code === 'JD2003', 'required email missing');
    await store.close();
  });

  it('a store-allocated key is exempt from a write\'s required list under validation', async () => {
    // the Post schema REQUIRES `pid`, and the database allocates it after
    // the hook runs — a write is validated with the key exempt, on both
    // paths; the read shape keeps it, and every other member still binds
    const validator = new JarenValidator({ collectErrors: true });
    const store = await openStore(MODEL, {
      driver: nodeDriver(),
      compileSchema: (schema) => validator.compile(schema),
    });
    const ada = await store.entity('User').create({ email: 'ada@x.test' });
    const posts = store.entity('Post');
    const created = await posts.create({ title: 'one', authorId: ada.id });
    assert.strictEqual(typeof created.pid, 'number');
    posts.add({ title: 'two', authorId: ada.id });
    assert.strictEqual((await store.saveChanges()).inserted, 1);
    await assert.rejects(() => posts.create({ authorId: ada.id }),
      (error) => error.code === 'JD2003'
        && error.errors.some((e) => /'title'/.test(e.message)), 'the other required members still bind');
    await store.close();
  });
});

describe('referential integrity (real foreign keys)', () => {
  it('a violating write fails; cascade removes children', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const users = store.entity('User');
    const posts = store.entity('Post');
    const ada = await users.create({ email: 'ada@x.test' });
    const post = await posts.create({ title: 'kept', authorId: ada.id });
    await assert.rejects(() => posts.create({ title: 'orphan', authorId: 'nobody' }),
      (error) => {
        assert.strictEqual(error.code, 'JD2005');
        assert.match(/** @type {any} */ (error.cause).message, /FOREIGN KEY/);
        return true;
      });
    await users.delete(ada.id);
    assert.strictEqual(await posts.get(post.pid), undefined, 'ON DELETE CASCADE observed');
    await store.close();
  });

  it('restrict refuses the parent delete; setNull orphans gracefully', async () => {
    const variant = (onDelete) => ({
      $model: '0.1',
      entities: {
        Team: {
          schema: {
            type: 'object',
            properties: { id: { type: 'string', 'x-entity': { key: true } } },
          },
        },
        Member: {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string', 'x-entity': { key: true } },
              teamId: { type: 'string' },
              team: { 'x-entity': { relation: { to: 'Team', via: 'teamId', onDelete } } },
            },
          },
        },
      },
    });

    const restrictStore = await openStore(variant('restrict'), { driver: nodeDriver() });
    await restrictStore.entity('Team').create({ id: 't1' });
    await restrictStore.entity('Member').create({ id: 'm1', teamId: 't1' });
    await assert.rejects(() => restrictStore.entity('Team').delete('t1'),
      (error) => error.code === 'JD2005', 'RESTRICT refuses');
    await restrictStore.close();

    const setNullStore = await openStore(variant('setNull'), { driver: nodeDriver() });
    await setNullStore.entity('Team').create({ id: 't1' });
    await setNullStore.entity('Member').create({ id: 'm1', teamId: 't1' });
    await setNullStore.entity('Team').delete('t1');
    const orphan = await setNullStore.entity('Member').get('m1');
    assert.strictEqual(orphan.teamId, undefined,
      'SET NULL: the column nulled, the property reads back absent (§9.3)');
    await setNullStore.close();
  });
});

describe('the two standing proofs', () => {
  it('stripping every x-entity leaves a schema with identical verdicts', () => {
    const strip = (node) => {
      if (Array.isArray(node)) return node.map(strip);
      if (node === null || typeof node !== 'object') return node;
      const out = {};
      for (const key of Object.keys(node)) {
        if (key === 'x-entity') continue;
        out[key] = strip(node[key]);
      }
      return out;
    };
    const validator = new JarenValidator().addFormats(dateTimeFormats);
    const withVocabulary = validator.compile(MODEL.entities.User.schema);
    const stripped = validator.compile(strip(MODEL.entities.User.schema));
    const corpus = [
      { id: 'a', email: 'a@x', role: 'admin' },
      { id: 'a', email: 'a@x', role: 'emperor' },
      { id: 'a' },
      { email: 7 },
      { id: 'a', email: 'a@x', profile: { any: ['thing'] } },
      null,
      [],
      'text',
    ];
    for (const value of corpus) {
      assert.strictEqual(withVocabulary(value), stripped(value),
        `verdicts must agree for ${JSON.stringify(value)}`);
    }
  });

  it('a phase-A store document opens unchanged under the entity engine', async () => {
    const phaseA = {
      $model: '0.1',
      collections: {
        users: {
          schema: {
            type: 'object',
            properties: { id: { type: 'string' }, age: { type: 'integer' } },
          },
          key: '/id',
          indexes: [{ name: 'by_age', path: '$.age' }],
        },
      },
    };
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(phaseA, { driver: nodeDriver(), path: dbPath });
      const users = store.collection('users');
      assert.strictEqual(await users.insert({ id: 'u1', age: 30 }), 'u1');
      assert.deepStrictEqual(await users.get('u1'), { id: 'u1', age: 30 });
      const patched = await users.patch('u1', [{ op: 'replace', path: '/age', value: 31 }]);
      assert.strictEqual(patched.age, 31);
      assert.strictEqual(
        await users.execute({ $count: { $for: { it: '$[*]' }, $return: '$it' } }), 1);
      await store.close();
      const reopened = await openStore(phaseA, { driver: nodeDriver(), path: dbPath });
      assert.strictEqual((await reopened.collection('users').get('u1')).age, 31);
      await reopened.close();
    }
    finally {
      cleanup();
    }
  });

  it('a model may declare both kinds side by side', async () => {
    const both = {
      $model: '0.1',
      collections: {
        events: { schema: { type: 'object' }, key: null, identity: 'integer' },
      },
      entities: {
        User: {
          schema: {
            type: 'object',
            properties: { id: { type: 'string', 'x-entity': { key: true } } },
          },
        },
      },
    };
    const store = await openStore(both, { driver: nodeDriver() });
    await store.collection('events').insert({ what: 'boot' });
    await store.entity('User').create({ id: 'u1' });
    assert.deepStrictEqual(await store.entity('User').get('u1'), { id: 'u1' });
    assert.throws(() => store.entity('events'), (error) => error.code === 'JD2004');
    await store.close();
  });
});

describe('the epoch column is index-friendly (EQP-verified)', () => {
  it('a range predicate over the derived epoch uses its index', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      await store.entity('User').create({ email: 'e@x.test' });
      await store.close();
      const raw = new DatabaseSync(dbPath);
      const row = raw.prepare('SELECT created FROM "User" LIMIT 1').get();
      assert.strictEqual(typeof row.created, 'number', 'epoch milliseconds stored');
      const plan = raw.prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM "User" WHERE created >= ?').all(0);
      assert.match(plan.map((r) => String(r.detail)).join('; '),
        /USING INDEX User_created/);
      raw.close();
    }
    finally {
      cleanup();
    }
  });
});
