//@ts-check
/**
 * @file A store profile (MODEL-FORMAT §8) applies to every read `execute`
 * makes: mandatory predicates and member allow-lists per root, engine
 * limits on every evaluation, the row and byte bounds, the declared
 * externals. No maintained live strategy repeats them: an inserted
 * document comes from the capture record, a changed row from a read by
 * key, a dependency from a read by token, and every per-row evaluation is
 * compiled without the limits. A normalized profile always carries limits
 * and bounds, so on a store opened with ANY profile every registration
 * re-runs, the reason named (LIVE-FORMAT §7); a demanded
 * `mode: 'incremental'` refuses it `JD0051`; after another tenant's writes
 * its rows equal a fresh `execute`; a document past `limits.steps` fails
 * with the code `execute` fails with; and a store without a profile keeps
 * the maintained strategy. On PostgreSQL every registration resnapshots
 * through the profile already.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { asyncLive } from '@jarenjs/db/async-live';
import { open } from '@jarenjs/linq/db';

const PROFILE_RERUN = "the store profile's predicates, member lists and limits apply to every read, which maintenance does not repeat";

const KEY = { 'x-entity': { key: true } };
const MODEL = {
  $model: '0.1',
  entities: {
    Author: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', ...KEY }, tenant: { type: 'string', 'x-entity': { index: true } },
      name: { type: 'string' }, secret: { type: 'string' },
      posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
    Post: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', ...KEY }, tenant: { type: 'string', 'x-entity': { index: true } },
      title: { type: 'string' } } } },
  },
  collections: {
    notes: { key: '/id', schema: { type: 'object', properties: {
      id: { type: 'string' }, tenant: { type: 'string' }, team: { type: 'string' }, n: { type: 'integer' } } } },
  },
};

const ACME = { $eq: ['$it.tenant', 'acme'] };
const TENANT = { predicates: { Author: ACME, Post: ACME, notes: ACME } };

/** Two tenants' authors, posts and notes, in one commit. */
async function seed(store) {
  await store.transaction(async (tx) => {
    await tx.entity('Author').create({ id: 'a1', tenant: 'acme', name: 'A1', secret: 's1' });
    await tx.entity('Author').create({ id: 'b1', tenant: 'other', name: 'B1', secret: 's2' });
    await tx.entity('Post').create({ id: 'p1', authorId: 'a1', tenant: 'acme', title: 'P1' });
    await tx.entity('Post').create({ id: 'q1', authorId: 'b1', tenant: 'other', title: 'Q1' });
    for (const [id, tenant, team, n] of [['n1', 'acme', 'x', 1], ['n2', 'acme', 'y', 2], ['m1', 'other', 'x', 3]]) {
      await tx.collection('notes').put({ id, tenant, team, n });
    }
  });
}

/** Entity writes, one commit each: the other tenant's author and post, an acme author, an acme post
 * under the other tenant's author, a rename, and an author moving to the other tenant. */
const ENTITY_WRITES = [
  (s) => s.entity('Author').create({ id: 'b2', tenant: 'other', name: 'B2' }),
  (s) => s.entity('Post').create({ id: 'q2', authorId: 'a1', tenant: 'other', title: 'Q2' }),
  (s) => s.entity('Author').create({ id: 'a2', tenant: 'acme', name: 'A2' }),
  (s) => s.entity('Post').create({ id: 'p2', authorId: 'b1', tenant: 'acme', title: 'P2' }),
  (s) => s.entity('Author').update('b1', { name: 'B1x' }),
  (s) => s.entity('Author').update('a1', { tenant: 'other' }),
];
/** Note writes, one commit each: the other tenant's note, an acme note, the other tenant's
 * note changed, an acme note moving to the other tenant, a delete. */
const NOTE_WRITES = [
  (s) => s.collection('notes').put({ id: 'm2', tenant: 'other', team: 'y', n: 0 }),
  (s) => s.collection('notes').put({ id: 'n3', tenant: 'acme', team: 'x', n: 5 }),
  (s) => s.collection('notes').put({ id: 'm1', tenant: 'other', team: 'y', n: 9 }),
  (s) => s.collection('notes').put({ id: 'n1', tenant: 'other', team: 'x', n: 1 }),
  (s) => s.collection('notes').delete('n2'),
];

const CHILD_IDS = [{ $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.authorId', '$a.id'] }, $return: '$p.id' }];

/** Each shape the maintenance table maintains, with the strategy it keeps without a profile. */
const SHAPES = [
  { name: 'entity rows', on: 'entity', maintained: 'join',
    document: [{ $for: { a: '$.Author[*]' }, $return: '$a.id' }] },
  { name: 'an entity join', on: 'entity', maintained: 'join',
    document: [{ $for: { p: '$.Post[*]', a: '$.Author[*]' }, $where: { $eq: ['$p.authorId', '$a.id'] },
      $return: { p: '$p.id', a: '$a.id' } }] },
  { name: 'an entity graph projection', on: 'entity', maintained: 'graph',
    document: [{ $for: { a: '$.Author[*]' }, $return: { id: '$a.id', posts: CHILD_IDS } }] },
  { name: 'collection rows', on: 'notes', maintained: 'rows',
    document: [{ $for: { it: '$[*]' }, $return: '$it.id' }] },
  { name: 'a window', on: 'notes', maintained: 'window',
    document: [{ $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.n', '$it.id'], $return: '$it.id' }, 0, 2] }] },
  { name: 'a count accumulator', on: 'notes', maintained: 'accumulator',
    document: [{ $count: { $for: { it: '$[*]' }, $return: '$it' } }] },
  { name: 'a max accumulator', on: 'notes', maintained: 'accumulator',
    document: [{ $max: { $for: { it: '$[*]' }, $return: '$it.n' } }] },
  { name: 'a group', on: 'notes', maintained: 'group',
    document: [{ $for: { it: '$[*]' }, $groupby: { g: '$it.team' }, $return: { key: '$g', n: { $count: '$it' } } }] },
  { name: 'a distinct projection', on: 'notes', maintained: 'distinct',
    document: [{ $distinct: { $for: { it: '$[*]' }, $return: '$it.team' } }] },
];

/** Register a shape on a store (or a transaction view), and run it fresh. */
const over = (store, shape) => ({
  register: (/** @type {any} */ options) => shape.on === 'entity'
    ? store.live(shape.document, options) : store.collection('notes').live(shape.document, options),
  run: () => shape.on === 'entity' ? store.execute(shape.document) : store.collection('notes').execute(shape.document),
});

/** After every write of the shape's root, the live rows equal a fresh run. */
async function followWrites(store, shape, live, run) {
  assert.deepEqual(live.result.rows, await run());
  for (const write of shape.on === 'entity' ? ENTITY_WRITES : NOTE_WRITES) {
    await write(store);
    assert.deepEqual(live.result.rows, await run(), `${shape.name} after a write`);
  }
}

/** Profiles that each shape a read: tenant predicates over every root; the safe defaults; predicates
 * and member lists over roots the shape does not read; engine limits alone. Each carries limits and
 * row bounds once normalized, so each re-runs. */
const profiles = (/** @type {any} */ shape) => [
  ['tenant predicates', TENANT],
  ["the 'safe' profile", 'safe'],
  ['predicates over other roots', shape.on === 'entity'
    ? { predicates: { notes: ACME }, members: { notes: ['$.id'] } }
    : { predicates: { Author: ACME, Post: ACME }, members: { Author: ['$.id'] } }],
  ['engine limits alone', { limits: { steps: 100_000 } }],
];

describe('a store opened with a profile re-runs every live registration', () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: re-runs, refuses a demanded incremental mode, and answers as execute after another tenant writes`, async () => {
      for (const [label, profile] of profiles(shape)) {
        const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, profile });
        try {
          await seed(store);
          const { register, run } = over(store, shape);
          const live = await register({});
          assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason: PROFILE_RERUN }, label);
          await assert.rejects(async () => register({ mode: 'incremental' }),
            { code: 'JD0051', message: `JD0051: the demanded incremental mode is unavailable: ${PROFILE_RERUN}` });
          await followWrites(store, shape, live, run);
          live.close();
        }
        finally { await store.close(); }
      }
    });
  }

  it('an explicit mode: rerun keeps its own reason, and a transaction view registers by the same rule', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, profile: TENANT });
    try {
      await seed(store);
      const [rows, entity] = [SHAPES[3], SHAPES[1]];
      const explicit = await store.collection('notes').live(rows.document, { mode: 'rerun' });
      assert.deepEqual(explicit.mode, { strategy: 'rerun', mode: 'rerun', reason: 'rerun was requested' });
      explicit.close();
      const [inView, entityInView] = await store.transaction(async (tx) => [
        await tx.collection('notes').live(rows.document), await tx.live(entity.document)]);
      for (const [live, shape] of [[inView, rows], [entityInView, entity]]) {
        assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason: PROFILE_RERUN });
        const { run } = over(store, shape);
        await followWrites(store, shape, live, run);
        live.close();
      }
    }
    finally { await store.close(); }
  });

  it('the @jarenjs/linq client registers its chains by the same rule', async () => {
    const client = await open(MODEL, { driver: nodeDriver(), capture: true, validator: null, profile: TENANT });
    try {
      await seed(client.store);
      const chain = client.entities.Author.where((/** @type {any} */ a) => a.name.ge('A'));
      const live = await client.live(chain);
      assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason: PROFILE_RERUN });
      // the registration packs the chain's phrase, as a fresh run must
      const run = () => client.store.execute([chain.toDocument()], { externals: chain.explain().bindings });
      assert.deepEqual(live.result.rows, await run());
      await ENTITY_WRITES[0](client.store);
      await ENTITY_WRITES[2](client.store);
      assert.deepEqual(live.result.rows, await run());
      assert.deepEqual(live.result.rows.map((/** @type {any} */ a) => a.id).sort(), ['a1', 'a2']);
      live.close();
    }
    finally { await client.close(); }
  });
});

describe('a store without a profile keeps the maintained strategy', () => {
  for (const shape of SHAPES) {
    it(`${shape.name} stays ${shape.maintained}`, async () => {
      const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
      try {
        await seed(store);
        const { register, run } = over(store, shape);
        const live = await register({ mode: 'incremental' });
        assert.deepEqual(live.mode, { strategy: shape.maintained, mode: 'incremental' });
        await followWrites(store, shape, live, run);
        live.close();
      }
      finally { await store.close(); }
    });
  }
});

describe('engine limits bind a live registration as they bind execute', () => {
  /** Per row, the sum of the squares up to the row's `n`: one evaluation per square. */
  const SQUARES = [{ $for: { it: '$[*]' }, $return: { id: '$it.id',
    squares: { $sum: { $for: { k: { $range: [1, '$it.n'] } }, $return: { $mul: ['$k', '$k'] } } } } }];
  const STEPS = { limits: { steps: 100 } };

  it('a row past limits.steps fails execute, a re-run and a registration the table would maintain with one code', async () => {
    const plain = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    try {
      await seed(plain);
      // without a profile the document is a maintained rows registration
      const live = await plain.collection('notes').live(SQUARES);
      assert.deepEqual(live.mode, { strategy: 'rows', mode: 'incremental' });
      live.close();
    }
    finally { await plain.close(); }

    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, profile: STEPS });
    try {
      await seed(store);
      await store.collection('notes').put({ id: 'h', tenant: 'acme', team: 'x', n: 200 });
      const notes = store.collection('notes');
      const refusal = { code: 'JQ2009', message: /limits\.steps \(100 expression evaluations\)/ };
      await assert.rejects(async () => notes.execute(SQUARES), refusal);
      await assert.rejects(async () => notes.live(SQUARES, { mode: 'rerun' }), refusal);
      await assert.rejects(async () => notes.live(SQUARES), refusal);
      assert.equal(store.stats().liveQueries, 0);
    }
    finally { await store.close(); }
  });

  it('a write past limits.steps after registration errors the registration as execute refuses it', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, profile: STEPS });
    try {
      await seed(store);
      const notes = store.collection('notes');
      const auto = await notes.live(SQUARES);
      const rerun = await notes.live(SQUARES, { mode: 'rerun' });
      assert.deepEqual(auto.result.rows, await notes.execute(SQUARES));
      await notes.put({ id: 'h', tenant: 'acme', team: 'x', n: 200 });
      await assert.rejects(async () => notes.execute(SQUARES), { code: 'JQ2009' });
      for (const live of [auto, rerun]) {
        assert.equal(live.state, 'errored');
        assert.equal(live.error.code, 'JQ2009');
      }
    }
    finally { await store.close(); }
  });
});

describe('a member allow-list re-runs a registration it would have refused', () => {
  it('a join and a collection projection reading only allowed members answer as execute does', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, profile: { members: {
      Author: ['$.id', '$.name'], Post: ['$.id', '$.authorId', '$.title'], notes: ['$.id', '$.n'] } } });
    try {
      await seed(store);
      const shapes = [
        { name: 'a join', on: 'entity', document: [{ $for: { p: '$.Post[*]', a: '$.Author[*]' },
          $where: { $eq: ['$p.authorId', '$a.id'] }, $return: { p: '$p.id', a: '$a.name' } }] },
        { name: 'a projection', on: 'notes', document: [{ $for: { it: '$[*]' }, $return: { id: '$it.id', n: '$it.n' } }] },
      ];
      for (const shape of shapes) {
        const { register, run } = over(store, shape);
        const live = await register({});
        assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason: PROFILE_RERUN });
        await followWrites(store, shape, live, run);
        live.close();
      }
      // a member the list denies is refused at registration, as execute refuses it
      const denied = [{ $for: { a: '$.Author[*]' }, $return: '$a.secret' }];
      await assert.rejects(async () => store.execute(denied), { code: 'JD0011' });
      await assert.rejects(async () => store.live(denied), { code: 'JD0011' });
      assert.equal(store.stats().liveQueries, 0);
    }
    finally { await store.close(); }
  });
});

describe('a live option the registration does not read is refused, never dropped', () => {
  it('a per-call profile, which execute applies, is JD0013 on both registrations, and so is a misspelt option', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    try {
      await seed(store);
      const [rows, entity] = [SHAPES[3], SHAPES[1]];
      // execute applies the per-call profile: the other tenant's note is hidden
      assert.deepEqual(await store.collection('notes').execute(rows.document, { profile: TENANT }), ['n1', 'n2']);
      const refused = { code: 'JD0013', message: /^JD0013: live option 'profile' is not one it reads/ };
      await assert.rejects(async () => store.collection('notes').live(rows.document, { profile: TENANT }), refused);
      await assert.rejects(async () => store.live(entity.document, { profile: TENANT }), refused);
      await assert.rejects(async () => store.transaction((tx) => tx.collection('notes').live(rows.document, { profile: TENANT })),
        refused);
      await assert.rejects(async () => store.collection('notes').live(rows.document, { mod: 'rerun' }),
        { code: 'JD0013', message: /^JD0013: live option 'mod' is not one it reads.*'mode'/ });
      await assert.rejects(async () => store.live(entity.document, null),
        { code: 'JD0013', message: 'JD0013: live options must be a plain object' });
      assert.equal(store.stats().liveQueries, 0);
    }
    finally { await store.close(); }
  });
});

describe('PostgreSQL: every registration resnapshots through the profile', { skip: !process.env.JAREN_PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('collection and entity registrations answer as execute after another tenant writes', async () => {
    const pg = (await import('pg')).default;
    const { postgresDriver } = await import('@jarenjs/db/postgres');
    const schema = `jaren_live_profile_${process.pid}`;
    const pool = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 3 });
    /** @type {any} */
    let store = null;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }), profile: TENANT,
        capture: { mode: 'journal', log: { retention: 2 } }, live: asyncLive({ pollMs: 60000 }) });
      await seed(store);
      const shapes = [SHAPES[0], SHAPES[1], SHAPES[3], SHAPES[4]];
      const lives = [];
      for (const shape of shapes) {
        const { register } = over(store, shape);
        const live = await register({});
        assert.equal(live.mode.strategy, 'resnapshot', shape.name);
        await assert.rejects(async () => register({ mode: 'incremental' }), { code: 'JD0051' });
        lives.push(live);
      }
      const check = async () => {
        for (const [index, shape] of shapes.entries()) {
          await lives[index].refresh();
          assert.deepEqual(lives[index].result.rows, await over(store, shape).run(), shape.name);
        }
      };
      await check();
      for (const write of [...ENTITY_WRITES.slice(0, 2), ...NOTE_WRITES.slice(0, 2)]) {
        await write(store);
        await check();
      }
      for (const live of lives) live.close();
    }
    finally {
      try { if (store !== null) await store.close(); }
      finally { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
    }
  });
});
