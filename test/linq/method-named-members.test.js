//@ts-check
/**
 * @file A document member named like a JavaScript array or string method
 * (`keys`, `values`, `entries`, `with`) is still that member: reading it
 * builds the member expression, and only CALLING it is the coded refusal
 * (QUERY-PEN.md §14.9). The in-memory engine, SQLite and — where
 * JAREN_PG_URL names a server — PostgreSQL answer the same rows for a
 * filter, a projection, a membership, an order and a relation target's
 * member of those names.
 */
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, LinqBuildError } from '@jarenjs/linq';
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { queryJson } from '@jarenjs/json/query';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;

const TABLES = Object.freeze({
  User: Object.freeze({}),
  Post: Object.freeze({
    author: Object.freeze({ to: 'User', kind: 'oneToOne', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' }),
  }),
});

const ROOT = {
  User: [
    { id: 'u1', keys: ['a', 'b'], values: 3, entries: 'a', with: 'w1' },
    { id: 'u2', keys: ['c'], values: 1, entries: 'b', with: 'w2' },
    { id: 'u3', keys: [], values: 2, entries: 'c', with: 'w1' },
  ],
  Post: [{ pid: 1, authorId: 'u2' }, { pid: 2, authorId: 'u1' }],
};

/** @param {string} name */
const entitySet = (name) => from({
  root: `$.${name}[*]`,
  scope: { relations: TABLES },
  relations: /** @type {any} */ (TABLES)[name],
  execute: (/** @type {any} */ document, /** @type {any} */ options) => queryJson(document, structuredClone(ROOT), options.externals),
});

/** Every chain here, by name: the build over an entity source and the rows it answers. */
const CASES = /** @type {[string, (f: (name: string) => any) => any, unknown[]][]} */ ([
  ['a filter on with', (f) => f('User').where((/** @type {any} */ u) => u.with.eq('w1')).select((/** @type {any} */ u) => u.id),
    ['u1', 'u3']],
  ['a projection of all four', (f) => f('User').orderBy((/** @type {any} */ u) => u.id)
    .select((/** @type {any} */ u) => ({ k: u.keys, v: u.values, e: u.entries, w: u.with })),
  [{ k: ['a', 'b'], v: 3, e: 'a', w: 'w1' }, { k: ['c'], v: 1, e: 'b', w: 'w2' }, { k: [], v: 2, e: 'c', w: 'w1' }]],
  ['entries in keys', (f) => f('User').where((/** @type {any} */ u) => u.entries.in(u.keys)).select((/** @type {any} */ u) => u.id),
    ['u1']],
  ['values as an operand', (f) => f('User').where((/** @type {any} */ u) => u.values.add(1).gt(2)).select((/** @type {any} */ u) => u.id),
    ['u1', 'u3']],
  ['an order by values', (f) => f('User').orderBy((/** @type {any} */ u) => u.values).select((/** @type {any} */ u) => u.id),
    ['u2', 'u3', 'u1']],
  ['a relation target\'s values and with', (f) => f('Post').orderBy((/** @type {any} */ p) => p.pid)
    .select((/** @type {any} */ p) => [p.author.values, p.author.with]), [[1, 'w2'], [3, 'w1']]],
]);

describe('a member named like a method is that member in memory, and its call is the refusal', () => {
  for (const [name, build, expected] of CASES) {
    it(name, () => assert.deepStrictEqual(build(entitySet).toArray(), expected));
  }

  it('calling one of them is JL0108 and get() reads it explicitly', () => {
    for (const [name, call] of /** @type {[string, (u: any) => unknown][]} */ ([
      ['keys', (u) => u.keys()], ['values', (u) => u.values()], ['entries', (u) => u.entries()], ['with', (u) => u.keys.with(0, 'z')]])) {
      assert.throws(() => entitySet('User').select(call),
        (e) => e instanceof LinqBuildError && e.code === 'JL0108' && e.message.startsWith(`JL0108: .${name}() is a JavaScript array method`));
    }
    assert.deepStrictEqual(entitySet('User').select((/** @type {any} */ u) => u.get('values')).toArray(), [3, 1, 2]);
  });
});

const User = m.object({
  id: m.string().key(),
  keys: m.array(m.string()),
  values: m.integer(),
  entries: m.string(),
  with: m.string(),
});
const Post = m.object({
  pid: m.integer().key(),
  authorId: m.string().optional(),
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
  const schema = `jaren_methodnamed_${process.pid}_${counter}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  return postgresDriver(pool, { schema });
}

/** @type {{ name: string, postgres: boolean }[]} */
const HOSTS = [{ name: 'sqlite', postgres: false }, ...(url ? [{ name: 'postgres', postgres: true }] : [])];

for (const host of HOSTS) {
  describe(`a store answers a member named like a method as the engine does, ${host.name}`, () => {
    /** @type {any} */
    let client;
    before(async () => {
      client = await open(model, { driver: await driverFor(host.postgres) });
      for (const user of ROOT.User) await client.entities.User.create(user);
      for (const post of ROOT.Post) await client.entities.Post.create(post);
    });
    after(async () => { await client.close(); });

    for (const [name, build, expected] of CASES) {
      it(name, async () => {
        const chain = build((/** @type {string} */ n) => client.entities[n]);
        assert.deepStrictEqual(await chain.toArray(), expected);
      });
    }
  });
}
