//@ts-check
/**
 * @file A handle's `execute`, `query` and `explain` take a chain as well as
 * a query document: the chain's document runs with its `params()` bindings
 * as the externals, so every answer is the answer its `toDocument()` gives
 * on the same member. They answered `{}` for a chain on a collection (the
 * chain object was read as a document with no clauses) and `JD0033` on an
 * entity. A chain built over another collection or entity is `JL0005`, as
 * `live()` answers it; a chain with no store source, or over the
 * same-named source of another client, is taken. A document is handed to
 * the store untouched. A store run is SQLite always, PostgreSQL where
 * JAREN_PG_URL names a server.
 */

import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromAsync } from '@jarenjs/linq';
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;

const Order = m.object({ id: m.string(), total: m.integer() });
const Person = m.object({ id: m.string(), age: m.integer() });
const Post = m.object({ pid: m.integer().identity('auto'), stars: m.integer() });
const Tag = m.object({ tid: m.integer().identity('auto'), weight: m.integer() });
const model = m.defineModel({
  collections: {
    orders: m.collection(Order, { key: (d) => d.id }),
    users: m.collection(Person, { key: (d) => d.id }),
  },
  entities: { Post, Tag },
});

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
  const schema = `jaren_handlechain_${process.pid}_${counter}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  return postgresDriver(pool, { schema });
}

/** @param {boolean} postgres */
async function openClient(postgres) {
  const client = await open(model, { driver: await driverFor(postgres), capture: true, validator: null });
  for (const [id, total] of [['o1', 5], ['o2', 12], ['o3', 30]]) await client.collections.orders.insert({ id, total });
  await client.collections.users.insert({ id: 'u1', age: 40 });
  for (const stars of [4, 9, 2]) await client.entities.Post.create({ stars });
  await client.entities.Tag.create({ weight: 9 });
  return client;
}

/** The rows a cursor yields. @param {AsyncIterable<any>} cursor */
async function rows(cursor) {
  const out = [];
  for await (const row of cursor) out.push(row);
  return out;
}

/** The rejection a call answers (a throw at the call is a failure), or a failed assertion.
 * @param {() => any} call */
async function rejection(call) {
  let pending;
  try { pending = call(); }
  catch (err) { return assert.fail(`threw at the call instead of rejecting: ${/** @type {any} */ (err).message}`); }
  try { await pending; }
  catch (err) { return /** @type {any} */ (err); }
  return assert.fail('expected a rejection');
}

/** The message `JL0005` carries for a chain of another source. */
const foreign = (/** @type {string} */ method, /** @type {string} */ kind,
  /** @type {string} */ own, /** @type {string} */ other) =>
  `JL0005: ${method}() on ${kind} '${own}' was handed a chain built over ${kind} '${other}' — `
  + 'a chain runs against the source it was built over; build it from this handle, '
  + 'or hand it to the handle it was built from';

const OVER_SIX = [{ id: 'o2', total: 12 }, { id: 'o3', total: 30 }];

/** @type {{ name: string, postgres: boolean }[]} */
const HOSTS = [{ name: 'sqlite', postgres: false }, ...(url ? [{ name: 'postgres', postgres: true }] : [])];

for (const host of HOSTS) {
  describe(`a handle takes a chain in execute, query and explain, ${host.name}`, () => {
    /** @type {any} */
    let client;
    before(async () => { client = await openClient(host.postgres); });
    after(async () => { await client.close(); });

    const bound = (/** @type {any} */ c) => c.collections.orders.params({ min: 6 })
      .where((/** @type {any} */ o, /** @type {any} */ q) => o.total.gt(q.min)).orderBy((/** @type {any} */ o) => o.total);

    it('a collection\'s execute answers the chain\'s rows, as its document does', async () => {
      const orders = client.collections.orders;
      const chain = bound(client);
      assert.deepStrictEqual(await orders.execute(chain), OVER_SIX);
      assert.deepStrictEqual(await orders.execute(chain.toDocument(), { externals: { min: 6 } }), OVER_SIX);
      // the chain's bindings are the externals; the options override them
      // (one row answers as the row itself, as a document's does)
      assert.deepStrictEqual(await orders.execute(chain, { externals: { min: 20 } }), { id: 'o3', total: 30 });
    });

    it('a collection\'s query yields the chain\'s rows, as its document does', async () => {
      const orders = client.collections.orders;
      const chain = bound(client);
      assert.deepStrictEqual(await rows(orders.query(chain)), OVER_SIX);
      assert.deepStrictEqual(await rows(orders.query(chain.toDocument(), { externals: { min: 6 } })), OVER_SIX);
    });

    it('a collection\'s explain of a chain is the explanation of its document', async () => {
      const orders = client.collections.orders;
      const chain = bound(client);
      const explained = await orders.explain(chain);
      assert.deepStrictEqual(explained, await orders.explain(chain.toDocument(), { externals: { min: 6 } }));
      assert.deepStrictEqual(explained.operators, ['$gt']);
      assert.deepStrictEqual(explained.externals, ['min']);
    });

    it('an entity\'s execute and explain take a chain, as its document does', async () => {
      const posts = client.entities.Post;
      const chain = posts.params({ min: 3 }).where((/** @type {any} */ p, /** @type {any} */ q) => p.stars.gt(q.min))
        .orderBy((/** @type {any} */ p) => p.stars);
      const expected = [{ pid: 1, stars: 4 }, { pid: 2, stars: 9 }];
      assert.deepStrictEqual(await posts.execute(chain), expected);
      assert.deepStrictEqual(await posts.execute(chain.toDocument(), { externals: { min: 3 } }), expected);
      assert.deepStrictEqual(await posts.explain(chain), await posts.explain(chain.toDocument(), { externals: { min: 3 } }));
    });

    it('a transaction\'s handles take a chain too', async () => {
      const chain = bound(client);
      await client.transaction(async (/** @type {any} */ tx) => {
        assert.deepStrictEqual(await tx.collections.orders.execute(chain), OVER_SIX);
        assert.deepStrictEqual(await rows(tx.collections.orders.query(chain)), OVER_SIX);
        assert.deepStrictEqual((await tx.collections.orders.explain(chain)).externals, ['min']);
        const posts = tx.entities.Post.where((/** @type {any} */ p) => p.stars.gt(3)).orderBy((/** @type {any} */ p) => p.stars);
        assert.deepStrictEqual(await tx.entities.Post.execute(posts), [{ pid: 1, stars: 4 }, { pid: 2, stars: 9 }]);
        assert.throws(() => tx.entities.Post.execute(tx.entities.Tag.where((/** @type {any} */ t) => t.weight.gt(1))),
          (/** @type {any} */ e) => e.message === foreign('execute', 'entity', 'Post', 'Tag'));
      });
    });

    it('a chain over a collection handle itself runs through the handle, and the handle stays a provider', async () => {
      const wrapped = fromAsync(client.collections.orders).where((/** @type {any} */ o) => o.total.gt(6)).orderBy((/** @type {any} */ o) => o.total);
      assert.deepStrictEqual(await client.collections.orders.execute(wrapped), OVER_SIX);
      assert.deepStrictEqual(await wrapped.toArray(), OVER_SIX);
      assert.strictEqual(await fromAsync(client.collections.orders).count(), 3);
    });

    it('a chain built over another collection or entity is JL0005 naming both, answered as the store answers a refused document', async () => {
      const { orders, users } = client.collections;
      const other = users.where((/** @type {any} */ u) => u.age.gt(30));
      assert.throws(() => orders.execute(other), (/** @type {any} */ e) => e.code === 'JL0005'
        && e.message === foreign('execute', 'collection', 'orders', 'users'));
      assert.throws(() => orders.query(other), (/** @type {any} */ e) => e.code === 'JL0005'
        && e.message === foreign('query', 'collection', 'orders', 'users'));
      assert.strictEqual((await rejection(() => orders.explain(other))).message, foreign('explain', 'collection', 'orders', 'users'));
      const tags = client.entities.Tag.where((/** @type {any} */ t) => t.weight.gt(1));
      assert.throws(() => client.entities.Post.execute(tags), (/** @type {any} */ e) => e.code === 'JL0005'
        && e.message === foreign('execute', 'entity', 'Post', 'Tag'));
      assert.strictEqual((await rejection(() => client.entities.Post.explain(tags))).message, foreign('explain', 'entity', 'Post', 'Tag'));
    });

    it('the synchronous twin of a collection is the same source by name (SQLite only: PostgreSQL has none)', { skip: host.postgres }, async () => {
      const { orders, users } = client.collections;
      const twin = from(client.store.sync.collection('users')).where((/** @type {any} */ u) => u.age.gt(30));
      assert.throws(() => orders.execute(twin), (/** @type {any} */ e) => e.code === 'JL0005');
      assert.deepStrictEqual(await users.execute(twin), { id: 'u1', age: 40 });
    });

    it('a chain with no store source, or over the same-named source of another client, is taken', async () => {
      const builder = from([]).where((/** @type {any} */ o) => o.total.gt(6)).orderBy((/** @type {any} */ o) => o.total);
      assert.deepStrictEqual(await client.collections.orders.execute(builder), OVER_SIX);
      const twin = await open(model, { driver: nodeDriver(), validator: null });
      try {
        const sameName = twin.collections.orders.where((/** @type {any} */ o) => o.total.gt(6)).orderBy((/** @type {any} */ o) => o.total);
        assert.deepStrictEqual(await client.collections.orders.execute(sameName), OVER_SIX);
      }
      finally { await twin.close(); }
    });

    it('a chain split by a host callback is its own JL0005, and a list parameter is checked in the merged set', async () => {
      const split = client.collections.orders.mapAsync((/** @type {any} */ o) => o, { concurrency: 1 });
      assert.throws(() => client.collections.orders.execute(split), (/** @type {any} */ e) => e.code === 'JL0005' && /mapAsync/.test(e.message));
      const byTotal = client.collections.orders.params({ ids: [5] }).where((/** @type {any} */ o, /** @type {any} */ q) => o.total.in(q.ids));
      assert.deepStrictEqual(await client.collections.orders.execute(byTotal), { id: 'o1', total: 5 });
      assert.throws(() => client.collections.orders.execute(byTotal, { externals: { ids: 5 } }), (/** @type {any} */ e) => e.code === 'JL0004');
      assert.strictEqual((await rejection(() => client.collections.orders.explain(byTotal, { externals: { ids: 5 } }))).code, 'JL0004');
    });

    it('every option reaches the chain as it reaches its document (pushdown, profile, signal, unknown and non-plain options)', async () => {
      const orders = client.collections.orders;
      const plain = orders.where((/** @type {any} */ o) => o.total.gt(6)).orderBy((/** @type {any} */ o) => o.total);
      const document = plain.toDocument();
      assert.strictEqual((await orders.explain(plain)).mode, 'native');
      const unpushed = await orders.explain(plain, { pushdown: false });
      assert.strictEqual(unpushed.mode, 'set');
      assert.deepStrictEqual(unpushed, await orders.explain(document, { pushdown: false }));
      assert.deepStrictEqual(await orders.execute(plain, { pushdown: false }), OVER_SIX);
      const safe = await orders.explain(plain, { profile: 'safe' });
      assert.deepStrictEqual(safe.budget.profile, { source: 'call', name: 'safe' });
      assert.deepStrictEqual(safe, await orders.explain(document, { profile: 'safe' }));
      const aborted = AbortSignal.abort();
      /** What a call answers, thrown, rejected or from a cursor. @param {() => any} call */
      const settle = async (call) => {
        try { await rows(await call()); }
        catch (err) { return /** @type {any} */ (err); }
        return assert.fail('expected a refusal');
      };
      // an option the store refuses is refused for the chain with the store's own message
      for (const options of [{ signal: aborted }, { bogus: 1 }, null, 'text', { externals: [] }]) {
        // an aborted signal gates a read, not an explanation
        for (const member of options?.signal ? ['execute', 'query'] : ['execute', 'query', 'explain']) {
          const call = (/** @type {any} */ source) => async () => {
            const answer = orders[member](source, options);
            return member === 'query' ? answer : [await answer];
          };
          const refused = await settle(call(plain));
          const expected = await settle(call(document));
          assert.strictEqual(refused.code, expected.code, `${member} ${JSON.stringify(options)}`);
          assert.strictEqual(refused.message, expected.message, `${member} ${JSON.stringify(options)}`);
        }
      }
      assert.strictEqual((await settle(async () => orders.execute(plain, { signal: aborted }))).code, 'JD2072');
      assert.strictEqual((await settle(async () => orders.execute(plain, { bogus: 1 }))).code, 'JD0013');
      assert.strictEqual((await settle(async () => orders.execute(plain, null))).code, 'JD0013');
    });

    it('a query document keeps working exactly as before', async () => {
      const orders = client.collections.orders;
      const document = { $for: { it: '$[*]' }, $where: { $gt: ['$it.total', 6] }, $orderby: { $key: '$it.total' }, $return: '$it' };
      assert.deepStrictEqual(await orders.execute(document), OVER_SIX);
      assert.deepStrictEqual(await rows(orders.query(document)), OVER_SIX);
      assert.deepStrictEqual((await orders.explain(document)).operators, ['$gt']);
      assert.strictEqual((await orders.explain()).streaming, 'row');
      assert.deepStrictEqual((await client.entities.Post.explain()).barriers, []);
      assert.throws(() => orders.execute({ $bogus: 1 }), (/** @type {any} */ e) => e.code === 'JQ0002');
      assert.throws(() => client.entities.Post.execute({ $bogus: 1 }), (/** @type {any} */ e) => e.code === 'JQ0002');
    });
  });
}
