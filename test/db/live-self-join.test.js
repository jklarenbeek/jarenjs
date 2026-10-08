//@ts-check
// A flat inner join may bind one entity under several aliases: every alias is
// maintained as its own input root, and a changed row reaches each of them.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { mulberry32 } from '@jarenjs/core/random';
import { liveOracle } from './oracle/replication.js';

const KEY = { 'x-entity': { key: true } };
const MODEL = { $model: '0.1', entities: {
  Author: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', ...KEY }, name: { type: 'string' }, rank: { type: 'number' },
    mentor: { type: 'string', 'x-entity': { index: true } },
    posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
  } } },
  Post: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', ...KEY }, title: { type: 'string' }, editor: { type: 'string' }, score: { type: 'number' },
  } } },
} };
const MENTORED = { $eq: ['$a.mentor', '$m.id'] };
const SELF = [{ $for: { a: '$.Author[*]', m: '$.Author[*]' }, $where: MENTORED, $return: { a: '$a.id', m: '$m.id' } }];
const PAIRS = [{ $for: { p: '$.Post[*]', q: '$.Post[*]' },
  $where: { $eq: ['$p.authorId', '$q.authorId'] }, $return: { p: '$p.id', q: '$q.id' } }];
const JOIN = [{ $for: { p: '$.Post[*]', a: '$.Author[*]' },
  $where: { $eq: ['$p.authorId', '$a.id'] }, $return: { p: '$p.id', a: '$a.id' } }];
const AMBIGUOUS = 'a self join has ambiguous root invalidation';
const ROOT_READ = 'an entity root read outside the join bindings re-runs';
/** A correlated count over every Author, filtered by `where` over `$x`. @param {any} where */
const PEERS = (where) => ({ $count: { $for: { x: '$.Author[*]' }, $where: where, $return: '$x' } });

/**
 * Authors a1 (no mentor), a2 and a3 mentored by a1, a4 by a2; Posts p1 and
 * p2 by a1, p3 by a2 — or only the first `authors` Authors and no Posts.
 * @param {{ authors?: number, live?: any }} [options]
 */
async function seeded({ authors = 4, live } = {}) {
  const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, ...(live ? { live } : {}) });
  for (const [id, mentor] of [['a1'], ['a2', 'a1'], ['a3', 'a1'], ['a4', 'a2']].slice(0, authors))
    await store.entity('Author').create({ id, name: id.toUpperCase(), rank: 1, ...(mentor ? { mentor } : {}) });
  if (authors === 4) for (const [id, authorId] of [['p1', 'a1'], ['p2', 'a1'], ['p3', 'a2']])
    await store.entity('Post').create({ id, authorId, title: `T${id}` });
  return store;
}

describe('flat self joins', () => {
  it('a self join over an indexed member is maintained, a row joined with itself included', async () => {
    const store = await seeded();
    try {
      const live = await store.live(SELF, { mode: 'incremental' });
      assert.deepEqual(live.mode, { strategy: 'join', mode: 'incremental' });
      const oracle = liveOracle(live, () => store.execute(SELF));
      const pairs = () => live.result.rows.map((row) => `${row.a}>${row.m}`);
      assert.deepEqual(pairs(), ['a2>a1', 'a3>a1', 'a4>a2']);
      await store.entity('Author').update('a1', { mentor: 'a1' });
      await oracle.check();
      assert.deepEqual(pairs(), ['a1>a1', 'a2>a1', 'a3>a1', 'a4>a2']);
      await store.entity('Author').delete('a2');
      await oracle.check();
      assert.deepEqual(pairs(), ['a1>a1', 'a3>a1']);
      assert.equal(live.stats().reruns, 0);
      oracle.close();
    }
    finally { await store.close(); }
  });

  it('a post joined with every post of its author, itself included, follows a move', async () => {
    const store = await seeded();
    try {
      const live = await store.live(PAIRS, { mode: 'incremental' });
      assert.deepEqual(live.mode, { strategy: 'join', mode: 'incremental' });
      const oracle = liveOracle(live, () => store.execute(PAIRS));
      const pairs = () => live.result.rows.map((row) => row.p + row.q);
      assert.deepEqual(pairs(), ['p1p1', 'p1p2', 'p2p1', 'p2p2', 'p3p3']);
      await store.entity('Post').update('p3', { authorId: 'a1' });
      await oracle.check();
      assert.deepEqual(pairs(), ['p1p1', 'p1p2', 'p1p3', 'p2p1', 'p2p2', 'p2p3', 'p3p1', 'p3p2', 'p3p3']);
      assert.equal(live.stats().reruns, 0);
      oracle.close();
    }
    finally { await store.close(); }
  });

  it('an unindexed self join re-runs, its missing index named', async () => {
    const store = await seeded();
    const unindexed = [{ ...SELF[0], $where: { $eq: ['$a.name', '$m.name'] } }];
    try {
      const live = await store.live(unindexed);
      assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun',
        reason: "join dependency 'a.name' has no declared index" });
      await assert.rejects(store.live(unindexed, { mode: 'incremental' }), { code: 'JD0051' });
    }
    finally { await store.close(); }
  });

  it('a self join inside a graph projection or an allowing-empty join keeps re-running', async () => {
    const store = await seeded();
    const graph = [{ $for: { a: '$.Author[*]' }, $return: { id: '$a.id', mentees: [{
      $for: { x: '$.Author[*]' }, $where: { $eq: ['$x.mentor', '$a.id'] }, $return: '$x.id' }] } }];
    const allowingEmpty = [{ $for: { a: '$.Author[*]', m: { $in: {
      $for: { x: '$.Author[*]' }, $where: { $eq: ['$x.id', '$a.mentor'] }, $return: '$x',
    }, '$allowing-empty': true } }, $return: { a: '$a.id', m: { $default: ['$m.id', null] } } }];
    try {
      for (const document of [graph, allowingEmpty]) {
        const live = await store.live(document);
        assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason: AMBIGUOUS });
        assert.deepEqual(live.result.rows, await store.execute(document));
        await assert.rejects(store.live(document, { mode: 'incremental' }), { code: 'JD0051' });
      }
    }
    finally { await store.close(); }
  });

  it('a changed row is read once for every alias of its entity', async () => {
    const store = await seeded();
    try {
      const live = await store.live(SELF, { mode: 'incremental' });
      const oracle = liveOracle(live, () => store.execute(SELF));
      // a2 is both a mentored row (a2>a1) and a mentor (a4>a2)
      for (const change of [{ rank: 7 }, { mentor: 'a3' }]) {
        const reads = live.stats().dependencyReads;
        await store.entity('Author').update('a2', change);
        await oracle.check();
        assert.equal(live.stats().dependencyReads - reads, 1);
      }
      oracle.close();
    }
    finally { await store.close(); }
  });

  it('a self join charges the shared rows once per alias against live.maxMaintained', async () => {
    const store = await seeded({ authors: 3, live: { maxMaintained: 5 } });
    try {
      // three Author rows and no Post: a plain join holds three source rows
      const join = await store.live(JOIN, { mode: 'incremental' });
      assert.deepEqual(join.result.rows, []);
      join.close();
      await assert.rejects(store.live(SELF), { code: 'JD2060' });
    }
    finally { await store.close(); }
  });

  it('an alias input member never takes a declared root name', async () => {
    const model = structuredClone(MODEL);
    model.entities._alias1 = { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', ...KEY }, author: { type: 'string', 'x-entity': { index: true } } } } };
    const document = [{ $for: { a: '$.Author[*]', m: '$.Author[*]', x: '$._alias1[*]' },
      $where: { $and: [MENTORED, { $eq: ['$x.author', '$m.id'] }] }, $return: { a: '$a.id', m: '$m.id', x: '$x.id' } }];
    const store = await openStore(model, { driver: nodeDriver(), capture: true });
    try {
      for (const [id, mentor] of [['a1'], ['a2', 'a1'], ['a3', 'a2']])
        await store.entity('Author').create({ id, ...(mentor ? { mentor } : {}) });
      await store.entity('_alias1').create({ id: 'x1', author: 'a1' });
      const live = await store.live(document, { mode: 'incremental' });
      const oracle = liveOracle(live, () => store.execute(document));
      assert.deepEqual(live.result.rows, [{ a: 'a2', m: 'a1', x: 'x1' }]);
      await store.entity('_alias1').create({ id: 'x2', author: 'a2' });
      await oracle.check();
      assert.equal(live.result.rows.length, 2);
      oracle.close();
    }
    finally { await store.close(); }
  });

  it('a join reading an entity root outside its bindings re-runs and equals store.execute', async () => {
    const store = await seeded();
    // a correlated count over every Author: a maintained join would evaluate
    // it over the outer row's connected rows alone
    const documents = [
      ...[{ $eq: ['$x.mentor', '$m.id'] }, { $eq: ['$x.mentor', '$a.id'] }, { $eq: ['$x.id', '$m.mentor'] }]
        .map((where) => [{ ...SELF[0], $return: { a: '$a.id', k: PEERS(where) } }]),
      [{ ...JOIN[0], $return: { p: '$p.id', k: PEERS({ $eq: ['$x.mentor', '$a.id'] }) } }],
      [{ $for: { p: '$.Post[*]', a: { $in: { $for: { y: '$.Author[*]' }, $where: { $eq: ['$y.id', '$p.authorId'] }, $return: '$y' },
        '$allowing-empty': true } }, $return: { p: '$p.id', k: PEERS({ $eq: ['$x.mentor', '$p.authorId'] }) } }],
      [{ $for: { j: JOIN[0] }, $return: { p: '$j.p', k: PEERS({ $eq: ['$x.mentor', '$j.a'] }) } }],
    ];
    // a quoted literal reads nothing
    const quoted = [{ ...SELF[0], $return: { a: '$a.id', c: { $const: '$.Author[*]' } } }];
    try {
      const watched = [];
      for (const document of documents) {
        const live = await store.live(document);
        assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason: ROOT_READ });
        await assert.rejects(store.live(document, { mode: 'incremental' }), { code: 'JD0051' });
        if (document === documents[0])
          assert.deepEqual(live.result.rows, [{ a: 'a2', k: 2 }, { a: 'a3', k: 2 }, { a: 'a4', k: 1 }]);
        watched.push(liveOracle(live, () => store.execute(document)));
      }
      const literal = await store.live(quoted, { mode: 'incremental' });
      assert.deepEqual(literal.mode, { strategy: 'join', mode: 'incremental' });
      watched.push(liveOracle(literal, () => store.execute(quoted)));
      for (const write of [
        () => store.entity('Author').update('a3', { mentor: 'a2' }),
        () => store.entity('Post').create({ id: 'p4', authorId: 'a2' }),
        () => store.entity('Author').create({ id: 'a5', name: 'A5', rank: 1, mentor: 'a1' }),
      ]) { await write(); for (const oracle of watched) await oracle.check(); }
      for (const oracle of watched) oracle.close();
    }
    finally { await store.close(); }
  });

  it('a self join over a join-table root is maintained', async () => {
    const model = structuredClone(MODEL);
    model.entities.Author.schema.properties.tags = { 'x-entity': { relation: { to: 'Tag', many: true, through: 'author_tags' } } };
    model.entities.Tag = { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...KEY } } } };
    // every two tags one author carries
    const document = [{ $for: { x: '$.author_tags[*]', y: '$.author_tags[*]' }, $where: { $eq: ['$x.Author_key', '$y.Author_key'] },
      $return: { a: '$x.Author_key', t: '$x.Tag_key', u: '$y.Tag_key' } }];
    const store = await openStore(model, { driver: nodeDriver(), capture: true });
    try {
      for (const id of ['t1', 't2', 't3']) await store.entity('Tag').create({ id });
      await store.entity('Author').create({ id: 'a1', tags: ['t1', 't2'] });
      await store.entity('Author').create({ id: 'a2', tags: ['t2'] });
      const live = await store.live(document, { mode: 'incremental' });
      assert.deepEqual(live.mode, { strategy: 'join', mode: 'incremental' });
      const oracle = liveOracle(live, () => store.execute(document));
      assert.equal(live.result.rows.length, 5);
      for (const write of [
        () => { store.entity('Author').link('a2', 'tags', 't3'); return store.saveChanges(); },
        () => { store.entity('Author').unlink('a1', 'tags', 't1'); return store.saveChanges(); },
        () => store.entity('Author').delete('a2'),
      ]) { await write(); await oracle.check(); }
      assert.deepEqual(live.result.rows, [{ a: 'a1', t: 't2', u: 't2' }]);
      assert.equal(live.stats().reruns, 0);
      oracle.close();
    }
    finally { await store.close(); }
  });

  it('seeded self joins equal store.execute after single writes, three-write transactions and rollbacks', async () => {
    const random = mulberry32(9);
    const SHAPES = {
      'self join': [{ $for: { a: '$.Author[*]', m: '$.Author[*]' }, $where: MENTORED,
        $return: { a: '$a.id', m: '$m.id', rank: '$m.rank' } }],
      'self join, aliases reversed': [{ $for: { m: '$.Author[*]', a: '$.Author[*]' }, $where: MENTORED,
        $return: { a: '$a.id', m: '$m.id', rank: '$a.rank' } }],
      'a post joined with itself': PAIRS,
      'three-way self join': [{ $for: { a: '$.Author[*]', m: '$.Author[*]', p: '$.Post[*]' },
        $where: { $and: [MENTORED, { $eq: ['$p.authorId', '$m.id'] }] },
        $return: { a: '$a.id', m: '$m.id', p: '$p.id', rank: '$a.rank' } }],
      'three aliases of one entity': [{ $for: { a: '$.Author[*]', m: '$.Author[*]', g: '$.Author[*]' },
        $where: { $and: [MENTORED, { $eq: ['$m.mentor', '$g.id'] }] },
        $return: { a: '$a.id', m: '$m.id', g: '$g.id', rank: '$g.rank' } }],
      'a self join counting over the entity': [{ ...SELF[0], $return: { a: '$a.id', k: PEERS({ $eq: ['$x.mentor', '$m.id'] }) } }],
    };
    /** @type {Record<string, any>} the shapes that re-run, and why */
    const RERUNS = { 'a self join counting over the entity': { strategy: 'rerun', mode: 'rerun', reason: ROOT_READ } };
    const AUTHORS = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'];
    const POSTS = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
    const pick = (list) => list[Math.floor(random() * list.length)];
    // a mentor is an indexed member, not a foreign key: any Author id, the
    // row's own included, or none; a Post's author is an existing Author or none
    const mentorOf = (id) => { const roll = random(); return roll < 0.2 ? null : roll < 0.35 ? id : pick(AUTHORS); };
    const authorOf = (state) => state.authors.size === 0 || random() < 0.2 ? null : pick([...state.authors]);
    /** One write through `handle` (the store or a transaction), mirrored in `state`. */
    const write = async (handle, state) => {
      const authors = AUTHORS.filter((id) => state.authors.has(id));
      const unusedAuthors = AUTHORS.filter((id) => !state.authors.has(id));
      const posts = POSTS.filter((id) => state.posts.has(id));
      const unusedPosts = POSTS.filter((id) => !state.posts.has(id));
      const roll = random();
      if (roll < 0.15 && unusedAuthors.length > 0) {
        const id = pick(unusedAuthors); const mentor = mentorOf(id);
        await handle.entity('Author').create({ id, name: id.toUpperCase(), rank: Math.floor(random() * 5),
          ...(mentor === null ? {} : { mentor }) });
        state.authors.add(id);
      }
      else if (roll < 0.25 && authors.length > 0) {
        const id = pick(authors);
        await handle.entity('Author').delete(id);
        state.authors.delete(id);
        // the relation cascades
        for (const [post, owner] of state.posts) if (owner === id) state.posts.delete(post);
      }
      else if (roll < 0.45 && authors.length > 0) {
        // a `null` mentor removes the member
        const id = pick(authors);
        await handle.entity('Author').update(id, { mentor: mentorOf(id) });
      }
      else if (roll < 0.55 && authors.length > 0) await handle.entity('Author').update(pick(authors), { rank: Math.floor(random() * 5) });
      else if (roll < 0.7 && unusedPosts.length > 0) {
        const id = pick(unusedPosts); const owner = authorOf(state);
        await handle.entity('Post').create({ id, title: `T${id}`, authorId: owner });
        state.posts.set(id, owner);
      }
      else if (roll < 0.8 && posts.length > 0) {
        const id = pick(posts);
        await handle.entity('Post').delete(id);
        state.posts.delete(id);
      }
      else if (posts.length > 0) {
        const id = pick(posts); const owner = authorOf(state);
        await handle.entity('Post').update(id, { authorId: owner });
        state.posts.set(id, owner);
      }
    };
    let checks = 0;
    for (let trial = 0; trial < 10; trial++) {
      const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
      try {
        let state = { authors: new Set(), posts: new Map() };
        for (const id of AUTHORS.slice(0, 4)) {
          const mentor = mentorOf(id);
          await store.entity('Author').create({ id, name: id.toUpperCase(), rank: Math.floor(random() * 5),
            ...(mentor === null ? {} : { mentor }) });
          state.authors.add(id);
        }
        for (const id of POSTS.slice(0, 4)) {
          const owner = authorOf(state);
          await store.entity('Post').create({ id, title: `T${id}`, authorId: owner });
          state.posts.set(id, owner);
        }
        const watched = [];
        for (const [name, document] of Object.entries(SHAPES)) {
          const live = await store.live(document, RERUNS[name] ? {} : { mode: 'incremental' });
          assert.deepEqual(live.mode, RERUNS[name] ?? { strategy: 'join', mode: 'incremental' }, name);
          watched.push({ name, live, oracle: liveOracle(live, () => store.execute(document)) });
        }
        for (let step = 0; step < 30; step++) {
          const label = `trial ${trial} step ${step}`;
          const before = watched.map(({ oracle }) => oracle.emissions);
          const roll = random();
          if (roll < 0.15) {
            const undone = await store.transaction(async (tx) => {
              const scratch = { authors: new Set(state.authors), posts: new Map(state.posts) };
              for (let i = 0; i < 3; i++) await write(tx, scratch);
              throw new Error('undo');
            }).catch((error) => {
              // only the deliberate rollback: a store error is a failure
              if (error.message !== 'undo') throw error;
              return 'rolled back';
            });
            assert.equal(undone, 'rolled back');
            assert.deepEqual(watched.map(({ oracle }) => oracle.emissions), before, `${label}: a rollback emits nothing`);
          }
          else if (roll < 0.4) {
            const next = { authors: new Set(state.authors), posts: new Map(state.posts) };
            await store.transaction(async (tx) => { for (let i = 0; i < 3; i++) await write(tx, next); });
            state = next;
          }
          else await write(store, state);
          for (const [i, { name, live, oracle }] of watched.entries()) {
            assert.ok(oracle.emissions - before[i] <= 1, `${name}, ${label}: one commit, at most one emission`);
            await assert.doesNotReject(oracle.check(), `${name}, ${label}`);
            if (!RERUNS[name]) assert.equal(live.stats().reruns, 0, `${name}, ${label}`);
            checks++;
          }
        }
        for (const { oracle } of watched) oracle.close();
      }
      finally { await store.close(); }
    }
    assert.equal(checks, 1800);
  });
});
