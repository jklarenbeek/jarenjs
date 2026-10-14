//@ts-check
/**
 * @file `.all()` on an array member of a relation target fans it exactly as
 * it does on a path member: `p.author.tags.all().eq('a')` holds when any
 * element of the author's `tags` equals `'a'`, `p.author.items.all().sku` is
 * every element's `sku`, and the aggregates range over those elements. The
 * emitted phrase returns the fanned path (`$r1.tags[*]`), the in-memory
 * engine and a store answer alike, and `.all()` on the relation itself (the
 * related rows) is unchanged. A store run is SQLite always, PostgreSQL where
 * JAREN_PG_URL names a server.
 */

import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromAsync, LinqBuildError } from '@jarenjs/linq';
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { queryJson } from '@jarenjs/json/query';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;

/** The relation tables of the in-memory fixture, as a store exposes them. */
const TABLES = Object.freeze({
  User: Object.freeze({
    posts: Object.freeze({ to: 'Post', kind: 'oneToMany', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' }),
  }),
  Post: Object.freeze({
    author: Object.freeze({ to: 'User', kind: 'oneToOne', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' }),
  }),
});

/** Users with array members (one without `tags`), posts with and without an author. */
const ROOT = {
  User: [
    { id: 'u1', name: 'ada', tags: ['a', 'b'], items: [{ sku: 'x', qty: 1 }, { sku: 'y', qty: 2 }] },
    { id: 'u2', name: 'lin', tags: ['c'], items: [] },
    { id: 'u3', name: 'kid', tags: [], items: [{ sku: 'x', qty: 5 }] },
  ],
  Post: [
    { pid: 1, authorId: 'u1', tags: ['q'] },
    { pid: 2, authorId: 'u2', tags: ['r', 's'] },
    { pid: 3, authorId: 'u1', tags: [] },
    { pid: 4, tags: [] },
    { pid: 5, authorId: 'u3', tags: [] },
  ],
};

const scope = { relations: TABLES };
/** @param {string} name */
const entitySet = (name) => ({
  root: `$.${name}[*]`,
  scope,
  relations: /** @type {any} */ (TABLES)[name],
  execute: (/** @type {any} */ document, /** @type {any} */ options) => queryJson(document, structuredClone(ROOT), options.externals),
});
const posts = () => from(entitySet('Post'));
const users = () => from(entitySet('User'));

/** The phrase from a post to its author returning `ret`. @param {string} ret */
const author = (ret) => ({ $for: { r1: '$.User[*]' }, $where: { $eq: ['$r1.id', '$it.authorId'] }, $return: ret });
/** The phrase from a user to its posts returning `ret`. @param {string} ret */
const authored = (ret) => ({ $for: { r1: '$.Post[*]' }, $where: { $eq: ['$r1.authorId', '$it.id'] }, $return: ret });

/** Every chain here, by name: the build, the document it must emit and the rows it answers. */
const CASES = [
  ['an element equals a value', (/** @type {any} */ f) => f('Post').where((p) => p.author.tags.all().eq('a')).select((p) => p.pid),
    { $for: { it: '$.Post[*]' }, $where: { $eq: [author('$r1.tags[*]'), 'a'] }, $return: '$it.pid' }, [1, 3]],
  ['no element equals the value', (/** @type {any} */ f) => f('Post').where((p) => p.author.tags.all().eq('zz')).select((p) => p.pid),
    null, []],
  ['a member of each element', (/** @type {any} */ f) => f('Post').where((p) => p.author.items.all().sku.eq('x')).select((p) => p.pid),
    { $for: { it: '$.Post[*]' }, $where: { $eq: [author('$r1.items[*].sku'), 'x'] }, $return: '$it.pid' }, [1, 3, 5]],
  ['the elements counted', (/** @type {any} */ f) => f('Post').select((p) => p.author.tags.all().count()),
    { $for: { it: '$.Post[*]' }, $return: { $count: author('$r1.tags[*]') } }, [2, 1, 2, 0, 0]],
  ['the elements summed', (/** @type {any} */ f) => f('Post').select((p) => p.author.items.all().qty.sum()),
    { $for: { it: '$.Post[*]' }, $return: { $sum: author('$r1.items[*].qty') } }, [3, 0, 3, 0, 5]],
  ['an element exists', (/** @type {any} */ f) => f('Post').where((p) => p.author.tags.all().exists()).select((p) => p.pid),
    null, [1, 2, 3]],
  ['no element differs', (/** @type {any} */ f) => f('Post').where((p) => p.author.items.all().qty.ne(1).not()).select((p) => p.pid),
    null, [2, 4]],
  ['the elements as one array value', (/** @type {any} */ f) => f('Post').select((p) => ({ pid: p.pid, tags: [p.author.tags.all()] })),
    { $for: { it: '$.Post[*]' }, $return: { pid: '$it.pid', tags: [author('$r1.tags[*]')] } },
    [{ pid: 1, tags: ['a', 'b'] }, { pid: 2, tags: ['c'] }, { pid: 3, tags: ['a', 'b'] }, { pid: 4, tags: [] }, { pid: 5, tags: [] }]],
  ['get() spells the same member', (/** @type {any} */ f) => f('Post').where((p) => p.author.get('tags').all().eq('a')).select((p) => p.pid),
    null, [1, 3]],
  ['a hop off a fanned to-many hop', (/** @type {any} */ f) => f('User').where((u) => u.posts.all().author.tags.all().eq('b')).select((u) => u.id),
    null, ['u1']],
  ['a member of the related rows, fanned', (/** @type {any} */ f) => f('User').where((u) => u.posts.all().tags.all().eq('r')).select((u) => u.id),
    { $for: { it: '$.User[*]' }, $where: { $eq: [authored('$r1.tags[*]'), 'r'] }, $return: '$it.id' }, ['u2']],
  ['the related rows\' elements counted', (/** @type {any} */ f) => f('User').select((u) => u.posts.all().tags.all().count()),
    { $for: { it: '$.User[*]' }, $return: { $count: authored('$r1.tags[*]') } }, [1, 2, 0]],
  ['the related row itself, fanned, is still the row', (/** @type {any} */ f) => f('Post').select((p) => p.author.all().count()),
    { $for: { it: '$.Post[*]' }, $return: { $count: author('$r1') } }, [1, 1, 1, 0, 1]],
];

describe('.all() on a relation target\'s array member fans it as on a path member', () => {
  for (const [name, build, document, expected] of CASES) {
    it(`${name}: the phrase returns the fanned path and the engine answers its elements`, async () => {
      const chain = build((/** @type {string} */ n) => (n === 'Post' ? posts() : users()));
      if (document !== null) assert.deepStrictEqual(chain.toDocument(), document);
      assert.deepStrictEqual(chain.toArray(), expected);
      const asynchronous = build((/** @type {string} */ n) => fromAsync(entitySet(n)));
      assert.strictEqual(canonicalizeJson(asynchronous.toDocument()), canonicalizeJson(chain.toDocument()));
      assert.deepStrictEqual(await asynchronous.toArray(), expected);
    });
  }

  it('the same spelling on a path member is the same fan', () => {
    const own = users().where((u) => u.tags.all().eq('a')).select((u) => u.id);
    assert.strictEqual(own.toDocument().$where.$eq[0], '$it.tags[*]');
    assert.deepStrictEqual(own.toArray(), ['u1']);
    assert.strictEqual(posts().where((p) => p.author.tags.all().eq('a')).toDocument().$where.$eq[0].$return, '$r1.tags[*]');
  });
});

describe('the array-method refusal on a relation target names a spelling that runs', () => {
  const refused = (/** @type {() => any} */ build) => {
    try { build(); } catch (e) { return /** @type {any} */ (e); }
    return assert.fail('expected a refusal');
  };

  it('every element-testing method names the fanned comparison, and that comparison answers', () => {
    for (const method of ['includes', 'indexOf', 'lastIndexOf']) {
      const e = refused(() => posts().where((p) => p.author.tags[method]('a')));
      assert.ok(e instanceof LinqBuildError && e.code === 'JL0108', method);
      assert.strictEqual(e.message, `JL0108: .${method}() is a JavaScript array method, and a captured expression has none — it `
        + 'stands for a value the engine computes later; test the elements with a fanned comparison — x.tags.all().eq(v) holds when '
        + 'any element equals v (on a string member, x.name.contains(v))');
    }
    assert.deepStrictEqual(posts().where((p) => p.author.tags.all().eq('a')).select((p) => p.pid).toArray(), [1, 3]);
  });

  it('the other methods keep the spellings they name for a path member, and each runs off a relation target', () => {
    const e = refused(() => posts().select((p) => p.author.items.map((i) => i.sku)));
    assert.match(e.message, /name the member of each element off the fan — x\.items\.all\(\)\.sku is every element's sku/);
    assert.deepStrictEqual(posts().select((p) => [p.author.items.all().sku]).toArray(),
      [['x', 'y'], [], ['x', 'y'], [], ['x']]);
    const some = refused(() => posts().where((p) => p.author.items.some((i) => i.qty)));
    assert.match(some.message, /x\.items\.all\(\)\.sku\.eq\(v\) holds when any element's sku equals v/);
    assert.deepStrictEqual(posts().where((p) => p.author.items.all().qty.eq(2)).select((p) => p.pid).toArray(), [1, 3]);
    const fold = refused(() => posts().select((p) => p.author.items.reduce((a, i) => a + i.qty, 0)));
    assert.match(fold.message, /aggregate the fanned member — x\.items\.all\(\)\.qty\.sum\(\)/);
  });
});

const User = m.object({
  id: m.string().key(),
  name: m.string(),
  tags: m.array(m.string()),
  items: m.array(m.object({ sku: m.string(), qty: m.integer() })),
  posts: m.rel.hasMany('Post', { via: 'authorId', onDelete: 'setNull' }),
});
const Post = m.object({
  pid: m.integer().key(),
  authorId: m.string().optional(),
  tags: m.array(m.string()),
  author: m.rel.hasOne('User', { via: 'authorId', onDelete: 'setNull' }),
});
const model = m.defineModel({ entities: { User, Post } });

/** @type {any} */
let pg = null;
/** @type {any} */
let admin = null;
/** @type {any} */
let pool = null;
const schemas = /** @type {string[]} */ ([]);
let counter = 0;

before(async () => {
  if (!url) return;
  pg = (await import('pg')).default;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  pool = new pg.Pool({ connectionString: url, max: 2 });
});
after(async () => {
  await pool?.end().catch(() => {});
  if (admin) {
    try { for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  }
});

/** @param {boolean} postgres */
async function driverFor(postgres) {
  if (!postgres) return nodeDriver();
  counter += 1;
  const schema = `jaren_hopfan_${process.pid}_${counter}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  return postgresDriver(pool, { schema });
}

/** @type {{ name: string, postgres: boolean }[]} */
const HOSTS = [{ name: 'sqlite', postgres: false }, ...(url ? [{ name: 'postgres', postgres: true }] : [])];

for (const host of HOSTS) {
  describe(`a store answers the fanned relation-target member as the engine does, ${host.name}`, () => {
    /** @type {any} */
    let client;
    before(async () => {
      client = await open(model, { driver: await driverFor(host.postgres) });
      for (const user of ROOT.User) await client.entities.User.create(user);
      for (const post of ROOT.Post) await client.entities.Post.create(post);
    });
    after(async () => { await client.close(); });

    for (const [name, build, , expected] of CASES) {
      it(`${name}`, async () => {
        const chain = build((/** @type {string} */ n) => client.entities[n]);
        assert.deepStrictEqual(await chain.toArray(), expected);
        // the document the store runs is the one the in-memory engine answers
        const answered = queryJson(chain.toDocument(), structuredClone(ROOT));
        assert.deepStrictEqual(answered === undefined ? [] : Array.isArray(answered) ? answered : [answered], expected);
      });
    }
  });
}
