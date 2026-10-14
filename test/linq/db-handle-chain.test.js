//@ts-check
/**
 * @file A handle's `execute`, `query` and `explain` take a chain as well as
 * a query document: the chain's document runs with its `params()` bindings
 * as the externals, so every answer is the answer its `toDocument()` gives
 * on the same member. They answered `{}` for a chain on a collection (the
 * chain object was read as a document with no clauses) and `JD0033` on an
 * entity. A chain built over another collection or entity, from any view
 * of the store, over the same-named source of a store over another
 * database (another file, another in-memory database, another schema), or
 * over rows in memory, is `JL0005`, as `live()` answers it; a chain over
 * no rows (the `from([])` document builder), or over the same source from
 * any view of a store over this database (another client of one file or
 * schema included), is taken. A document is handed to the store untouched. A store run is SQLite always, PostgreSQL where
 * JAREN_PG_URL names a server.
 */

import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { from, fromAsync } from '@jarenjs/linq';
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { openStore } from '@jarenjs/db';
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

/** The schema each PostgreSQL driver opens its store in. @type {WeakMap<object, string>} */
const schemaOf = new WeakMap();

/** @param {boolean} postgres */
async function driverFor(postgres) {
  if (!postgres) return nodeDriver();
  counter += 1;
  const schema = `jaren_handlechain_${process.pid}_${counter}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  const driver = postgresDriver(pool, { schema });
  schemaOf.set(driver, schema);
  return driver;
}

/** @param {boolean} postgres */
async function openClient(postgres) {
  const driver = await driverFor(postgres);
  const client = await open(model, { driver, capture: true, validator: null });
  const schema = schemaOf.get(driver);
  if (schema !== undefined) schemaOf.set(client, schema);
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

/** The message `JL0005` carries for a chain over the same-named source of another store. */
const anotherStore = (/** @type {string} */ method, /** @type {string} */ kind, /** @type {string} */ own) =>
  `JL0005: ${method}() on ${kind} '${own}' was handed a chain built over ${kind} '${own}' of another store — `
  + 'a chain runs against the source it was built over; build it from this handle, '
  + 'or hand it to the handle it was built from';

/** The message `JL0005` carries for a chain over rows in memory. */
const inMemory = (/** @type {string} */ method, /** @type {string} */ kind,
  /** @type {string} */ own, /** @type {string} */ count) =>
  `JL0005: ${method}() on ${kind} '${own}' was handed a chain built over ${count} in memory — `
  + "a handle runs a chain's document over its own rows, never the chain's; build it from "
  + 'this handle (or from([]) to write a document), or run it over its rows with toArray()';

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

    it('a chain over rows in memory is JL0005 naming the rows; an empty sequence is the document builder', async () => {
      const { orders } = client.collections;
      const over = (/** @type {any} */ chain) => chain.where((/** @type {any} */ o) => o.total.gt(6)).orderBy((/** @type {any} */ o) => o.total);
      // the rows were ignored: each answered the handle's OVER_SIX
      const one = over(from([{ id: 'x', total: 99 }]));
      assert.throws(() => orders.execute(one), (/** @type {any} */ e) => e.code === 'JL0005'
        && e.message === inMemory('execute', 'collection', 'orders', '1 row'));
      assert.throws(() => orders.query(one), (/** @type {any} */ e) => e.message === inMemory('query', 'collection', 'orders', '1 row'));
      assert.strictEqual((await rejection(() => orders.explain(one))).message, inMemory('explain', 'collection', 'orders', '1 row'));
      const two = over(fromAsync(new Set([{ id: 'x', total: 99 }, { id: 'y', total: 7 }])));
      assert.throws(() => orders.execute(two), (/** @type {any} */ e) => e.message === inMemory('execute', 'collection', 'orders', '2 rows'));
      assert.throws(() => orders.execute(from('ab')), (/** @type {any} */ e) => e.message === inMemory('execute', 'collection', 'orders', '2 rows'));
      assert.throws(() => orders.execute(from(new Uint8Array(3))), (/** @type {any} */ e) => e.message === inMemory('execute', 'collection', 'orders', '3 rows'));
      const stars = from([{ pid: 9, stars: 99 }]).where((/** @type {any} */ p) => p.stars.gt(3));
      assert.throws(() => client.entities.Post.execute(stars), (/** @type {any} */ e) => e.message === inMemory('execute', 'entity', 'Post', '1 row'));
      assert.strictEqual((await rejection(() => client.entities.Post.explain(stars))).message, inMemory('explain', 'entity', 'Post', '1 row'));
      // no rows, or rows whose count is read only by consuming them, are taken as before
      for (const builder of [from([]), fromAsync([]), from(new Map()), from((function* () {})())]) {
        assert.deepStrictEqual(await orders.execute(over(builder)), OVER_SIX);
      }
      assert.deepStrictEqual(await rows(orders.query(over(fromAsync([])))), OVER_SIX);
    });

    it('a view the client never built carries its own source: another store\'s, an escaped transaction\'s', async () => {
      const { orders } = client.collections;
      const raw = await openStore(model, { driver: await driverFor(host.postgres) });
      try {
        const adults = fromAsync(raw.collection('users')).where((/** @type {any} */ u) => u.age.gt(30));
        assert.throws(() => orders.execute(adults), (/** @type {any} */ e) => e.message === foreign('execute', 'collection', 'orders', 'users'));
        assert.throws(() => orders.query(adults), (/** @type {any} */ e) => e.message === foreign('query', 'collection', 'orders', 'users'));
        assert.strictEqual((await rejection(() => orders.explain(adults))).message, foreign('explain', 'collection', 'orders', 'users'));
        const tags = fromAsync(raw.entity('Tag')).where((/** @type {any} */ t) => t.weight.gt(1));
        assert.throws(() => client.entities.Post.execute(tags), (/** @type {any} */ e) => e.message === foreign('execute', 'entity', 'Post', 'Tag'));
        // the same name of another store ran over this store's rows (OVER_SIX); raw holds none
        const sameName = fromAsync(raw.collection('orders')).where((/** @type {any} */ o) => o.total.gt(6)).orderBy((/** @type {any} */ o) => o.total);
        assert.deepStrictEqual(await sameName.toArray(), []);
        assert.throws(() => orders.execute(sameName), (/** @type {any} */ e) => e.code === 'JL0005'
          && e.message === anotherStore('execute', 'collection', 'orders'));
        assert.throws(() => orders.query(sameName), (/** @type {any} */ e) => e.message === anotherStore('query', 'collection', 'orders'));
        assert.strictEqual((await rejection(() => orders.explain(sameName))).message, anotherStore('explain', 'collection', 'orders'));
        const posts = fromAsync(raw.entity('Post')).where((/** @type {any} */ p) => p.stars.gt(3));
        assert.throws(() => client.entities.Post.execute(posts), (/** @type {any} */ e) => e.message === anotherStore('execute', 'entity', 'Post'));
        assert.strictEqual((await rejection(() => client.entities.Post.explain(posts))).message, anotherStore('explain', 'entity', 'Post'));
      }
      finally { await raw.close(); }
      /** @type {any} */
      let escaped;
      /** @type {any} */
      let escapedOrders;
      await client.transaction(async (/** @type {any} */ tx) => {
        escaped = tx.store.collection('users');
        escapedOrders = tx.store.collection('orders');
      });
      assert.throws(() => orders.execute(fromAsync(escaped).where((/** @type {any} */ u) => u.age.gt(30))),
        (/** @type {any} */ e) => e.message === foreign('execute', 'collection', 'orders', 'users'));
      // a transaction's view is a view of this store: its same name is this source
      const viaTransaction = fromAsync(escapedOrders).where((/** @type {any} */ o) => o.total.gt(6)).orderBy((/** @type {any} */ o) => o.total);
      assert.deepStrictEqual(await orders.execute(viaTransaction), OVER_SIX);
    });

    it('the synchronous twin of a collection is the same source (SQLite only: PostgreSQL has none)', { skip: host.postgres }, async () => {
      const { orders, users } = client.collections;
      const twin = from(client.store.sync.collection('users')).where((/** @type {any} */ u) => u.age.gt(30));
      assert.throws(() => orders.execute(twin), (/** @type {any} */ e) => e.code === 'JL0005');
      assert.deepStrictEqual(await users.execute(twin), { id: 'u1', age: 40 });
    });

    it('a chain over the same-named source of another client answers right over one database, and is JL0005 over another', async () => {
      const builder = from([]).where((/** @type {any} */ o) => o.total.gt(6)).orderBy((/** @type {any} */ o) => o.total);
      assert.deepStrictEqual(await client.collections.orders.execute(builder), OVER_SIX);
      const over = (/** @type {any} */ c) => c.collections.orders.where((/** @type {any} */ o) => o.total.gt(6)).orderBy((/** @type {any} */ o) => o.total);
      if (host.postgres) {
        // one server, database and schema: the twin's rows are the client's
        const twin = await open(model, { driver: postgresDriver(pool, { schema: schemaOf.get(client) }), validator: null });
        try {
          assert.deepStrictEqual(await over(twin).toArray(), OVER_SIX);
          assert.deepStrictEqual(await client.collections.orders.execute(over(twin)), OVER_SIX);
          assert.deepStrictEqual(await rows(client.collections.orders.query(over(twin))), OVER_SIX);
        }
        finally { await twin.close(); }
        return; // another schema is refused above, by the store a view the client never built reads
      }
      const dir = mkdtempSync(join(tmpdir(), 'jaren-handle-chain-'));
      const first = await open(model, { driver: nodeDriver(), path: join(dir, 'one.sqlite'), validator: null });
      const second = await open(model, { driver: nodeDriver(), path: join(dir, 'one.sqlite'), validator: null });
      const elsewhere = await open(model, { driver: nodeDriver(), path: join(dir, 'two.sqlite'), validator: null });
      const memory = await open(model, { driver: nodeDriver(), validator: null });
      try {
        for (const [id, total] of [['o1', 5], ['o2', 12], ['o3', 30]]) await first.collections.orders.insert({ id, total });
        // one file: the second client's rows are the first's, and the chain answers them
        assert.deepStrictEqual(await over(second).toArray(), OVER_SIX);
        assert.deepStrictEqual(await first.collections.orders.execute(over(second)), OVER_SIX);
        assert.deepStrictEqual(await rows(first.collections.orders.query(over(second))), OVER_SIX);
        await first.transaction(async (/** @type {any} */ tx) => {
          assert.deepStrictEqual(await tx.collections.orders.execute(over(second)), OVER_SIX);
        });
        // another file, or another in-memory database: its own rows are none, and this
        // client's handle ran its document over OVER_SIX
        for (const other of [elsewhere, memory]) {
          assert.deepStrictEqual(await over(other).toArray(), []);
          assert.throws(() => first.collections.orders.execute(over(other)), (/** @type {any} */ e) => e.code === 'JL0005'
            && e.message === anotherStore('execute', 'collection', 'orders'));
        }
      }
      finally {
        for (const opened of [first, second, elsewhere, memory]) await opened.close();
        rmSync(dir, { recursive: true, force: true });
      }
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

    it('the store\'s own members refuse a chain (JD0039); the handle takes it, and the store its document', async () => {
      const chain = bound(client);
      const raw = client.store.collection('orders');
      // read as a document with no clauses, these answered {} and [{}]
      assert.throws(() => raw.execute(chain), (/** @type {any} */ e) => e.code === 'JD0039'
        && e.message.startsWith("JD0039: collection('orders').execute takes a query document and was handed a chain — "));
      assert.throws(() => raw.query(chain), (/** @type {any} */ e) => e.code === 'JD0039');
      assert.strictEqual((await rejection(() => raw.explain(chain))).code, 'JD0039');
      assert.strictEqual((await rejection(() => raw.live(chain))).code, 'JD0039');
      const posts = client.entities.Post.where((/** @type {any} */ p) => p.stars.gt(3));
      assert.strictEqual((await rejection(() => client.store.explain(posts))).code, 'JD0039');
      assert.strictEqual((await rejection(() => client.store.live(posts))).code, 'JD0039');
      assert.deepStrictEqual(await raw.execute(chain.toDocument(), { externals: chain.explain().bindings }), OVER_SIX);
      assert.deepStrictEqual(await client.collections.orders.execute(chain), OVER_SIX);
    });
  });
}
