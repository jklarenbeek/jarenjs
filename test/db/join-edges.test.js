//@ts-check
/**
 * @file The edges of an entity join. A column equality between two bindings
 * joins natively only where the database pairs the rows exactly as the engine
 * does: both sides mapped columns of ONE comparison family — the family the
 * column stores and the engine decodes, never the first type of a union and
 * never a schema that claims another kind than the codec holds — neither
 * boolean, and not both able to read a NULL as a present `null` (the engine
 * equates one with another, SQL pairs none; a NULL that reads back as no member
 * is an empty sequence in the engine and an unknown in SQL, which pair alike).
 * An equality that fails the rule is no edge, so the plan keeps the engine's
 * pairing under the reason the planner already gives for a binding nothing
 * connects, or for a conjunct that spans two bindings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openStore, reasonId } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { compileJsonQuery } from '@jarenjs/json/query';

import { FAMILY_WORLDS, FAMILY_MATRIX_WORLDS, NULL_WORLDS, FLAVOR_WORLDS, ORDER_WORLDS, onWorldHosts, checkWorld } from './oracle/join-worlds.js';
import { liveOracle } from './oracle/replication.js';
import { onBothEngines, onBothEnginesPhysical } from './query-core-engines.js';

const KEY = { 'x-entity': { key: true } };

/** The reason id of the first reason an `explain()` of a residual names. */
const firstReason = (/** @type {any} */ explained) => reasonId(explained.reasons[0].reason);

/** A string reference against an integer key: SQLite pairs `'1'` with `1` by affinity, PostgreSQL has no such operator. */
const FAMILY_MODEL = {
  $model: '0.1',
  entities: {
    U: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'integer', ...KEY }, n: { type: 'number' } } } },
    P: { schema: { type: 'object', required: ['pid'], properties: {
      pid: { type: 'integer', ...KEY }, ref: { type: 'string' }, uid: { type: 'integer' }, weight: { type: 'number' } } } },
  },
};
const FAMILY_DOCUMENTS = {
  U: [{ id: 1, n: 1 }, { id: 2, n: 2 }],
  P: [{ pid: 1, ref: '1', uid: 1, weight: 1 }, { pid: 2, ref: '2', uid: 2, weight: 2 }],
};
const joinOn = (/** @type {any} */ where, /** @type {any} */ ret = '$p.pid') =>
  ({ $for: { u: '$.U[*]', p: '$.P[*]' }, $where: where, $return: ret });

async function seed(/** @type {any} */ store, /** @type {Record<string, any[]>} */ documents) {
  for (const [name, rows] of Object.entries(documents)) for (const row of rows) await store.entity(name).create(row);
}

describe('a column equality between two bindings is a join edge only across one comparison family', () => {
  it('a string column against an integer key pairs nothing, as in the engine', async () => {
    await onBothEngines(FAMILY_MODEL, async (store, host) => {
      await seed(store, FAMILY_DOCUMENTS);
      const query = joinOn({ $eq: ['$p.ref', '$u.id'] });
      assert.equal(compileJsonQuery(query)(structuredClone(FAMILY_DOCUMENTS)), undefined, 'the engine pairs no row');
      const explained = await store.explain(query);
      assert.equal(explained.mode, 'set', host);
      assert.equal(firstReason(explained), 'entity.joinKey', host);
      // the reason says what was refused, not only that an equality is missing
      assert.match(explained.reasons[0].reason, /between mapped columns of one comparison family that the engine and the database pair alike \(not a boolean, not columns that store another kind than their type claims, not two columns that can each read a NULL as a null\)/, host);
      assert.equal(await store.execute(query), undefined, host);
      await assert.rejects(Promise.resolve().then(() => store.execute(query, { strict: true })), { code: 'JD0010' }, host);
    });
  });

  it('an equality across families beside a real edge is a conjunct the engine decides', async () => {
    await onBothEngines(FAMILY_MODEL, async (store, host) => {
      await seed(store, FAMILY_DOCUMENTS);
      const query = joinOn({ $and: [{ $eq: ['$p.uid', '$u.id'] }, { $eq: ['$p.ref', '$u.id'] }] });
      assert.equal(compileJsonQuery(query)(structuredClone(FAMILY_DOCUMENTS)), undefined, 'the engine pairs no row');
      const explained = await store.explain(query);
      assert.equal(explained.mode, 'set', host);
      assert.equal(firstReason(explained), 'entity.conjunctBinding', host);
      assert.match(explained.reasons[0].reason, /or a comparison between mapped columns of one comparison family that the engine and the database decide alike/, host);
      assert.equal(await store.execute(query), undefined, host);
    });
  });

  it('integer and number columns share a family and still join natively', async () => {
    await onBothEngines(FAMILY_MODEL, async (store, host) => {
      await seed(store, FAMILY_DOCUMENTS);
      for (const [name, where, answer] of /** @type {[string, any, any][]} */ ([
        ['an integer reference against an integer key', { $eq: ['$p.uid', '$u.id'] }, [1, 2]],
        ['a number against an integer key', { $eq: ['$p.weight', '$u.id'] }, [1, 2]],
        ['an integer key against a number', { $eq: ['$u.id', '$p.weight'] }, [1, 2]],
        ['two numbers', { $and: [{ $eq: ['$p.uid', '$u.id'] }, { $eq: ['$p.weight', '$u.n'] }] }, [1, 2]],
      ])) {
        const query = joinOn(where);
        const explained = await store.explain(query);
        assert.equal(explained.mode, 'native', `${host}: ${name}`);
        assert.deepEqual(await store.execute(query, { strict: true }), answer, `${host}: ${name}`);
        assert.deepEqual(compileJsonQuery(query)(structuredClone(FAMILY_DOCUMENTS)), answer, `${host}: ${name} (engine)`);
      }
    });
  });
});

/** A foreign key no property declares: the column stores the key it references, and the engine's documents carry it as that key. */
const UNDECLARED_MODEL = {
  $model: '0.1',
  entities: {
    Author: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', ...KEY }, rank: { type: 'integer' }, flag: { type: 'boolean' },
      posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
    Post: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', ...KEY }, flag: { type: 'boolean' } } } },
  },
};
const UNDECLARED_DOCUMENTS = {
  Author: [{ id: '1', rank: 1, flag: true }, { id: '2', rank: 2, flag: false }],
  Post: [{ id: 'p1', authorId: '1', flag: true }, { id: 'p2', authorId: '2', flag: true }, { id: 'p3', flag: false }],
};

describe('a foreign key no property declares joins as the key it references', () => {
  it('pairs the rows of the key it references natively, and of a column of another family not at all', async () => {
    await onBothEngines(UNDECLARED_MODEL, async (store, host) => {
      await seed(store, UNDECLARED_DOCUMENTS);
      const keyed = { $for: { p: '$.Post[*]', a: '$.Author[*]' }, $where: { $eq: ['$p.authorId', '$a.id'] },
        $return: { p: '$p.id', a: '$a.rank' } };
      const explained = await store.explain(keyed);
      assert.equal(explained.mode, 'native', host);
      assert.deepEqual(await store.execute(keyed, { strict: true }), [{ p: 'p1', a: 1 }, { p: 'p2', a: 2 }], host);
      assert.deepEqual(await store.execute(keyed, { pushdown: false }), [{ p: 'p1', a: 1 }, { p: 'p2', a: 2 }], `${host} (engine)`);
      // the key '1' is a string, the rank 1 a number: the engine pairs them with nothing, SQLite by affinity with the row
      const across = { $for: { p: '$.Post[*]', a: '$.Author[*]' }, $where: { $eq: ['$p.authorId', '$a.rank'] }, $return: '$p.id' };
      const refused = await store.explain(across);
      assert.equal(refused.mode, 'set', host);
      assert.equal(firstReason(refused), 'entity.joinKey', host);
      assert.equal(await store.execute(across), undefined, host);
    });
  });
});

describe('a column equality is no join edge over boolean columns', () => {
  it('plans the engine, which pairs the rows by value', async () => {
    await onBothEngines(UNDECLARED_MODEL, async (store, host) => {
      await seed(store, UNDECLARED_DOCUMENTS);
      const query = { $for: { p: '$.Post[*]', a: '$.Author[*]' }, $where: { $eq: ['$p.flag', '$a.flag'] },
        $return: { p: '$p.id', a: '$a.id' } };
      const explained = await store.explain(query);
      assert.equal(explained.mode, 'set', host);
      assert.equal(firstReason(explained), 'entity.joinKey', host);
      const answer = [{ p: 'p1', a: '1' }, { p: 'p2', a: '1' }, { p: 'p3', a: '2' }];
      assert.deepEqual(await store.execute(query), answer, host);
      assert.deepEqual(await store.execute(query, { pushdown: false }), answer, `${host} (engine)`);
    });
  });
});

const NULLABLE_MODEL = {
  $model: '0.1',
  entities: {
    U: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'integer', ...KEY }, tag: { type: ['string', 'null'] } } } },
    P: { schema: { type: 'object', required: ['pid'], properties: {
      pid: { type: 'integer', ...KEY }, tag: { type: ['string', 'null'] } } } },
  },
};

describe('a column equality over members typed to admit null', () => {
  it('joins natively when their NULL reads back as no member, and answers the engine\'s rows', async () => {
    await onBothEngines(NULLABLE_MODEL, async (store, host) => {
      // a mapped column reads its NULL back as an absent member: an empty sequence, which pairs with nothing in the engine, as SQL's unknown does
      await seed(store, { U: [{ id: 1, tag: null }, { id: 2, tag: 'x' }], P: [{ pid: 1, tag: null }, { pid: 2, tag: 'x' }] });
      const query = joinOn({ $eq: ['$p.tag', '$u.tag'] }, { p: '$p.pid', u: '$u.id' });
      assert.equal((await store.explain(query)).mode, 'native', host);
      assert.deepEqual(await store.execute(query, { strict: true }), { p: 2, u: 2 }, host);
      assert.deepEqual(await store.execute(query, { pushdown: false }), { p: 2, u: 2 }, `${host} (engine)`);
    });
  });
});

/** Two tables whose `tag` columns hold NULLs the entity reads as present nulls. */
const NULL_POLICY_DDL = (/** @type {string} */ prefix) => `CREATE TABLE ${prefix}a (id integer PRIMARY KEY, tag text);
  CREATE TABLE ${prefix}b (id integer PRIMARY KEY, tag text);
  INSERT INTO ${prefix}a VALUES (1, NULL), (2, 'x'), (3, NULL);
  INSERT INTO ${prefix}b VALUES (1, 'x'), (2, NULL), (3, NULL)`;
const nullPolicyModel = (/** @type {any} */ tagType) => (/** @type {string | null} */ schema) => ({
  $model: '0.1',
  entities: Object.fromEntries(['A', 'B'].map((name) => [name, {
    schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'integer', ...KEY }, tag: { type: tagType } } },
    physical: { ...(schema === null ? {} : { schema }), table: name.toLowerCase(), columns: {
      id: { name: 'id', codec: 'integer', null: 'reject' }, tag: { name: 'tag', codec: 'text', null: 'null' } } },
  }])),
});
const adoptedJoin = (/** @type {any} */ where) =>
  ({ $for: { a: '$.A[*]', b: '$.B[*]' }, $where: where, $return: { a: '$a.id', b: '$b.id' } });

describe('a column whose NULL reads back as a present null takes part in no join edge or refinement', () => {
  // the engine equates a null with a null and differs it from every other value; SQL does neither
  const EQUAL_TAGS = [{ a: 1, b: 2 }, { a: 1, b: 3 }, { a: 2, b: 1 }, { a: 3, b: 2 }, { a: 3, b: 3 }];
  const DIFFERENT_TAGS = [{ a: 1, b: 1 }, { a: 2, b: 2 }];
  for (const [label, tagType] of /** @type {[string, any][]} */ ([
    ['a schema that admits null', ['string', 'null']],
    ['a schema that does not', 'string'],
  ])) {
    it(`an equality of two such columns, under ${label}, is the engine's pairing`, async () => {
      await onBothEnginesPhysical(nullPolicyModel(tagType), NULL_POLICY_DDL, async (store, host) => {
        const query = adoptedJoin({ $eq: ['$a.tag', '$b.tag'] });
        const explained = await store.explain(query);
        assert.equal(explained.mode, 'set', host);
        assert.equal(firstReason(explained), 'entity.joinKey', host);
        assert.deepEqual(await store.execute(query), EQUAL_TAGS, host);
        assert.deepEqual(await store.execute(query, { pushdown: false }), EQUAL_TAGS, `${host} (engine)`);
      });
    });

    it(`a difference of two such columns beside a real edge, under ${label}, is the engine's`, async () => {
      await onBothEnginesPhysical(nullPolicyModel(tagType), NULL_POLICY_DDL, async (store, host) => {
        const query = adoptedJoin({ $and: [{ $eq: ['$a.id', '$b.id'] }, { $ne: ['$a.tag', '$b.tag'] }] });
        const explained = await store.explain(query);
        assert.equal(explained.mode, 'set', host);
        assert.equal(firstReason(explained), 'entity.conjunctBinding', host);
        assert.deepEqual(await store.execute(query), DIFFERENT_TAGS, host);
        assert.deepEqual(await store.execute(query, { pushdown: false }), DIFFERENT_TAGS, `${host} (engine)`);
      });
    });
  }

  it('the key columns of the same tables still join natively', async () => {
    await onBothEnginesPhysical(nullPolicyModel('string'), NULL_POLICY_DDL, async (store, host) => {
      const query = adoptedJoin({ $eq: ['$a.id', '$b.id'] });
      const explained = await store.explain(query);
      // PostgreSQL keeps a column whose NULL reads as a null out of every native predicate, the key columns apart
      assert.equal(explained.mode, 'native', host);
      assert.deepEqual(await store.execute(query, { strict: true }), [{ a: 1, b: 1 }, { a: 2, b: 2 }, { a: 3, b: 3 }], host);
    });
  });
});

/** Two adopted tables whose `w` property declares no type: the column's codec fixes how it reads, the schema says nothing of its family. */
const UNTYPED_DDL = (/** @type {string} */ prefix) => `CREATE TABLE ${prefix}a (id integer PRIMARY KEY, w text NOT NULL);
  CREATE TABLE ${prefix}b (id integer PRIMARY KEY, w text NOT NULL);
  INSERT INTO ${prefix}a VALUES (1, 'x'), (2, 'y');
  INSERT INTO ${prefix}b VALUES (1, 'y'), (2, 'x')`;
const untypedModel = (/** @type {string | null} */ schema) => ({
  $model: '0.1',
  entities: Object.fromEntries(['A', 'B'].map((name) => [name, {
    schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', ...KEY }, w: {} } },
    physical: { ...(schema === null ? {} : { schema }), table: name.toLowerCase(), columns: {
      id: { name: 'id', codec: 'integer', null: 'reject' }, w: { name: 'w', codec: 'text', null: 'reject' } } },
  }])),
});

describe('a column equality is no join edge over columns whose property declares no type', () => {
  it('plans the engine, which pairs the rows by the values the codec reads', async () => {
    await onBothEnginesPhysical(untypedModel, UNTYPED_DDL, async (store, host) => {
      const query = adoptedJoin({ $eq: ['$a.w', '$b.w'] });
      const explained = await store.explain(query);
      assert.equal(explained.mode, 'set', host);
      assert.equal(firstReason(explained), 'entity.joinKey', host);
      const answer = [{ a: 1, b: 2 }, { a: 2, b: 1 }];
      assert.deepEqual(await store.execute(query), answer, host);
      assert.deepEqual(await store.execute(query, { pushdown: false }), answer, `${host} (engine)`);
    });
  });
});

/** The adopted counterexample as the plain case states it: a NULL on each side that reads back as a present null. */
const PAIR_DDL = (/** @type {string} */ prefix) => `CREATE TABLE ${prefix}a (id integer PRIMARY KEY, tag text);
  CREATE TABLE ${prefix}b (id integer PRIMARY KEY, tag text);
  INSERT INTO ${prefix}a VALUES (1, NULL), (2, 'x');
  INSERT INTO ${prefix}b VALUES (10, NULL), (11, 'x')`;

describe('two adopted columns typed to admit null, whose NULL reads back as a present null', () => {
  it('pair the nulls as the engine does: SQL pairs no NULL, so the join is the engine\'s', async () => {
    await onBothEnginesPhysical(nullPolicyModel(['string', 'null']), PAIR_DDL, async (store, host) => {
      const query = adoptedJoin({ $eq: ['$a.tag', '$b.tag'] });
      const answer = [{ a: 1, b: 10 }, { a: 2, b: 11 }];
      const explained = await store.explain(query);
      assert.equal(explained.mode, 'set', host);
      assert.equal(firstReason(explained), 'entity.joinKey', host);
      assert.deepEqual(await store.execute(query), answer, host);
      assert.deepEqual(await store.execute(query, { pushdown: false }), answer, `${host} (engine)`);
    });
  });
});

/** A foreign key no property declares, over a key of the given type; the posts reference it. */
const undeclaredKeyModel = (/** @type {string} */ keyType) => ({
  $model: '0.1',
  entities: {
    Author: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: keyType, ...KEY }, name: { type: 'string' },
      posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
    Post: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...KEY } } } },
  },
});

describe('a foreign key no property declares, written with another type than the key it references', () => {
  // its column stores the key's type, so the column converts the value or refuses the write, and the join reads what the engine's documents hold
  const PAIRS = [{ a: 'one', p: 'p1' }, { a: 'two', p: 'p2' }];
  const join = { $for: { a: '$.Author[*]', p: '$.Post[*]' }, $where: { $eq: ['$p.authorId', '$a.id'] }, $return: { a: '$a.name', p: '$p.id' } };
  /** @param {any} store @param {Record<string, any[]>} documents @returns {Promise<string | null>} the code the write was refused with */
  const written = async (store, documents) => {
    try {
      await seed(store, documents);
      return null;
    }
    catch (error) { return /** @type {any} */ (error).code; }
  };

  it('a number against a string key: SQLite refuses the write, PostgreSQL stores the key\'s text, and the join is the engine\'s', async () => {
    await onBothEngines(undeclaredKeyModel('string'), async (store, host) => {
      const refusal = await written(store, { Author: [{ id: '1', name: 'one' }, { id: '2', name: 'two' }],
        Post: [{ id: 'p1', authorId: 1 }, { id: 'p2', authorId: 2 }] });
      if (host === 'sqlite') return assert.equal(refusal, 'JD2005', host);
      assert.equal(refusal, null, host);
      assert.equal((await store.explain(join)).mode, 'native', host);
      assert.deepEqual(await store.execute(join), PAIRS, host);
      assert.deepEqual(await store.execute(join, { pushdown: false }), PAIRS, `${host} (engine)`);
    });
  });

  it('a numeric string against an integer key: the column stores the number, and the join is the engine\'s', async () => {
    await onBothEngines(undeclaredKeyModel('integer'), async (store, host) => {
      assert.equal(await written(store, { Author: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }],
        Post: [{ id: 'p1', authorId: '1' }, { id: 'p2', authorId: '2' }] }), null, host);
      assert.deepEqual(await store.execute({ $for: { p: '$.Post[*]' }, $return: '$p.authorId' }, { pushdown: false }), [1, 2], host);
      assert.equal((await store.explain(join)).mode, 'native', host);
      assert.deepEqual(await store.execute(join), PAIRS, host);
      assert.deepEqual(await store.execute(join, { pushdown: false }), PAIRS, `${host} (engine)`);
    });
  });

  it('a string that is no number against an integer key: the write is refused', async () => {
    await onBothEngines(undeclaredKeyModel('integer'), async (store, host) => {
      assert.equal(await written(store, { Author: [{ id: 1, name: 'one' }], Post: [{ id: 'p1', authorId: 'x' }] }), 'JD2005', host);
    });
  });
});

/** Run the Bun fixture over the named groups of worlds, or skip where there is no Bun. @param {any} t @param {string[]} groups */
function underBun(t, groups) {
  const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (which.status !== 0) return t.skip('no bun binary on PATH');
  const fixture = fileURLToPath(new URL('./fixtures/join-worlds-bun.mjs', import.meta.url));
  const run = spawnSync('bun', ['run', fixture, ...groups], { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)) });
  const report = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? 'null');
  assert.equal(report?.runtime, 'bun', run.stderr);
  assert.deepEqual(report.failures, []);
  assert.equal(run.status, 0);
}

for (const [title, groups, worlds] of /** @type {[string, string[], any[]][]} */ ([
  ['the comparison family of a join edge is the family the column stores and the engine decodes', ['family'], FAMILY_WORLDS],
  ['every claim over every codec joins natively only against a column of its own family', ['matrix'], FAMILY_MATRIX_WORLDS],
  ['a join edge pairs the nulls the engine and the database pair alike, and no other', ['nulls'], NULL_WORLDS],
  ['only a mapped column is a join edge', ['flavor'], FLAVOR_WORLDS],
  ['an ordering or an aggregate reads a NULL and a boolean as the engine does: a column\'s NULL as no member, a document member\'s or a policy\'s as a null, a boolean by what its column stores', ['order'], ORDER_WORLDS],
])) {
  describe(title, () => {
    for (const world of worlds) {
      it(world.name, async () => {
        await onWorldHosts(world, async (store, host) => {
          assert.deepEqual(await checkWorld(store, world, host), []);
        });
      });
    }
    it('the same worlds on bun:sqlite', (t) => underBun(t, groups));
  });
}

describe('the live view of a join', () => {
  const model = (/** @type {any} */ authorId) => ({ $model: '0.1', entities: {
    U: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...KEY }, name: { type: 'string' },
      posts: { 'x-entity': { relation: { to: 'P', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
    P: { schema: { type: 'object', required: ['pid'], properties: {
      pid: { type: 'integer', ...KEY }, authorId, flag: { type: 'boolean', 'x-entity': { index: true } } } } },
    Q: { schema: { type: 'object', required: ['qid'], properties: { qid: { type: 'integer', ...KEY }, flag: { type: 'boolean', 'x-entity': { index: true } } } } },
  } });
  const join = [{ $for: { p: '$.P[*]', u: '$.U[*]' }, $where: { $eq: ['$p.authorId', '$u.id'] }, $return: { p: '$p.pid', u: '$u.name' } }];

  it('over an optional foreign key (typed to admit null) stays an incremental join, and equals a fresh run after every write', async () => {
    const store = await openStore(model({ type: ['string', 'null'], 'x-entity': { index: true } }), { driver: nodeDriver(), capture: true });
    try {
      await seed(store, { U: [{ id: 'u1', name: 'one' }, { id: 'u2', name: 'two' }], P: [{ pid: 1, authorId: 'u1' }, { pid: 2, authorId: null }, { pid: 3 }] });
      assert.equal((await store.explain(join)).mode, 'native');
      const live = await store.live(join, { mode: 'incremental' });
      assert.deepEqual(live.mode, { strategy: 'join', mode: 'incremental' });
      const oracle = liveOracle(live, () => store.execute(join));
      await oracle.check();
      for (const write of [
        () => store.entity('P').create({ pid: 4, authorId: 'u2' }),
        () => store.entity('P').update('2', { authorId: 'u1' }),
        () => store.entity('P').update('1', { authorId: null }),
        () => store.entity('P').create({ pid: 5 }),
        () => store.entity('U').create({ id: 'u3', name: 'three' }),
        () => store.entity('P').delete('4'),
      ]) {
        await write();
        await oracle.check();
      }
      oracle.close();
      live.close();
    }
    finally { await store.close(); }
  });

  it('over an equality that is no edge re-runs, naming why, and refuses to be demanded incremental', async () => {
    const store = await openStore(model({ type: 'string', 'x-entity': { index: true } }), { driver: nodeDriver(), capture: true });
    try {
      await seed(store, { U: [{ id: 'u1', name: 'one' }], P: [{ pid: 1, authorId: 'u1', flag: true }], Q: [{ qid: 1, flag: true }] });
      const booleans = [{ $for: { p: '$.P[*]', q: '$.Q[*]' }, $where: { $eq: ['$p.flag', '$q.flag'] }, $return: { p: '$p.pid', q: '$q.qid' } }];
      const live = await store.live(booleans);
      assert.equal(live.mode.strategy, 'rerun');
      assert.match(live.mode.reason, /^entity dependency plan: every binding past the first needs a column equality to one already joined, between mapped columns of one comparison family/);
      live.close();
      await assert.rejects(async () => store.live(booleans, { mode: 'incremental' }), { code: 'JD0051' });
      await assert.rejects(async () => store.live([{ $for: { p: '$.P[*]' }, $groupby: { f: '$p.flag' }, $return: { f: '$f', n: { $count: '$p' } } }], { mode: 'incremental' }), { code: 'JD0051' });
    }
    finally { await store.close(); }
  });
});
