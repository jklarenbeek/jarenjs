//@ts-check
/**
 * @file A chain carries the source it was built over, and `live()` on a
 * handle registers only a chain over that collection or entity: a chain
 * over another one used to register its document against the handle it
 * was handed to, which ran it over the wrong rows. A chain over the same
 * name, from any view of it or from another client of the same model, and
 * a chain with no collection source (a document builder), register as
 * they always did.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { open } from '@jarenjs/linq/db';
import { from, fromAsync } from '@jarenjs/linq';
import * as m from '@jarenjs/linq/model';
import { nodeDriver } from '@jarenjs/db/node';

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

/** @param {(client: any) => Promise<void>} body */
async function withClient(body) {
  const client = await open(model, { driver: nodeDriver(), capture: true, validator: null });
  try {
    await client.collections.orders.insert({ id: 'o1', total: 5 });
    await client.collections.users.insert({ id: 'u1', age: 40 });
    await client.collections.users.insert({ id: 'u2', age: 20 });
    await client.entities.Post.create({ stars: 4 });
    await client.entities.Tag.create({ weight: 9 });
    await body(client);
  }
  finally { await client.close(); }
}

/** The rejection a call answers, or a failed assertion. @param {() => Promise<any>} call */
async function rejection(call) {
  try { await call(); }
  catch (err) { return /** @type {any} */ (err); }
  return assert.fail('expected a rejection');
}

const liveCount = (/** @type {any} */ client) => client.store.stats().liveQueries;

describe('a collection handle registers only a chain over its own collection', () => {
  it('a chain over users handed to orders.live is JL0005, names both, and registers nothing', async () => {
    await withClient(async (client) => {
      const users = client.collections.users.where((u) => u.age.gt(30));
      const error = await rejection(() => client.collections.orders.live(users));
      assert.strictEqual(error.code, 'JL0005');
      assert.strictEqual(error.message,
        "JL0005: live() on collection 'orders' was handed a chain built over collection 'users' — "
        + 'a chain runs against the source it was built over; build it from this handle, '
        + 'or hand it to the handle it was built from');
      assert.strictEqual(liveCount(client), 0);
    });
  });

  it('a chain over another handle itself is refused, as over the collection behind it', async () => {
    await withClient(async (client) => {
      const wrapped = fromAsync(client.collections.users).where((u) => u.age.gt(30));
      assert.strictEqual((await rejection(() => client.collections.orders.live(wrapped))).code, 'JL0005');
      const entity = fromAsync(client.entities.Tag).where((t) => t.weight.gt(1));
      assert.strictEqual((await rejection(() => client.entities.Post.live(entity))).code, 'JL0005');
      assert.strictEqual(liveCount(client), 0);
    });
  });

  it('a chain over its own collection registers, from the handle or from fromAsync(handle)', async () => {
    await withClient(async (client) => {
      const own = await client.collections.users.live(client.collections.users.where((u) => u.age.gt(30)));
      assert.deepStrictEqual(own.result.rows, [{ id: 'u1', age: 40 }]);
      const wrapped = await client.collections.users.live(fromAsync(client.collections.users).where((u) => u.age.lt(30)));
      assert.deepStrictEqual(wrapped.result.rows, [{ id: 'u2', age: 20 }]);
      const whole = await client.collections.orders.live();
      assert.deepStrictEqual(whole.result.rows, [{ id: 'o1', total: 5 }]);
      assert.strictEqual(liveCount(client), 3);
    });
  });

  it('a chain over the store\'s own collection object, from any view of it, is the same source', async () => {
    await withClient(async (client) => {
      const raw = await client.collections.users.live(fromAsync(client.store.collection('users')).where((u) => u.age.gt(30)));
      assert.deepStrictEqual(raw.result.rows, [{ id: 'u1', age: 40 }]);
      const young = client.collections.users.where((u) => u.age.lt(30));
      const adult = client.collections.users.where((u) => u.age.gt(30));
      const built = await client.transaction(async (tx) => {
        const inside = await tx.collections.users.live(young);
        assert.deepStrictEqual(inside.result.rows, [{ id: 'u2', age: 20 }]);
        const error = await rejection(() => tx.collections.orders.live(adult));
        assert.strictEqual(error.code, 'JL0005');
        return tx.collections.users.where((u) => u.age.gt(30));
      });
      const outside = await client.collections.users.live(built);
      assert.deepStrictEqual(outside.result.rows, [{ id: 'u1', age: 40 }]);
    });
  });

  it('a synchronous chain over another collection is refused too; over its own it registers', async () => {
    await withClient(async (client) => {
      const foreign = from(client.store.sync.collection('users')).where((u) => u.age.gt(30));
      const error = await rejection(() => client.collections.orders.live(foreign));
      assert.strictEqual(error.code, 'JL0005');
      assert.match(error.message, /collection 'orders' was handed a chain built over collection 'users'/);
      const own = await client.collections.users.live(foreign);
      assert.deepStrictEqual(own.result.rows, [{ id: 'u1', age: 40 }]);
    });
  });

  it('a chain with no collection source is a document builder and registers as before', async () => {
    await withClient(async (client) => {
      for (const chain of [
        from([]).where((o) => o.total.gt(1)),
        fromAsync([]).where((o) => o.total.gt(1)),
      ]) {
        const query = await client.collections.orders.live(chain);
        assert.deepStrictEqual(query.result.rows, [{ id: 'o1', total: 5 }]);
      }
      assert.strictEqual(liveCount(client), 2);
    });
  });

  it('the synchronous twin is recognised from every scope, whichever meets it first', async () => {
    await withClient(async (client) => {
      const foreign = from(client.store.sync.collection('users')).where((u) => u.age.gt(30));
      const inside = await client.transaction((tx) => rejection(() => tx.collections.orders.live(foreign)));
      assert.strictEqual(inside.code, 'JL0005');
      const outside = await rejection(() => client.collections.orders.live(foreign));
      assert.strictEqual(outside.code, 'JL0005');
      assert.match(outside.message, /collection 'orders' was handed a chain built over collection 'users'/);
      assert.strictEqual(liveCount(client), 0);
    });
  });

  it('a chain over a provider the client never fronted cannot be told apart, and registers as before', async () => {
    await withClient(async (client) => {
      const handWritten = fromAsync({ execute: () => [], root: '$[*]' }).where((o) => o.total.gt(1));
      const query = await client.collections.orders.live(handWritten);
      assert.deepStrictEqual(query.result.rows, [{ id: 'o1', total: 5 }]);
    });
  });

  it('a hand-written document names no source and registers on any handle', async () => {
    await withClient(async (client) => {
      const query = await client.collections.orders.live({ $for: { it: '$[*]' }, $where: { $gt: ['$it.total', 1] }, $return: '$it' });
      assert.deepStrictEqual(query.result.rows, [{ id: 'o1', total: 5 }]);
    });
  });
});

describe('an entity handle registers only a chain over its own entity', () => {
  it('a chain over Tag handed to Post.live is JL0005; over Post it registers', async () => {
    await withClient(async (client) => {
      const tags = client.entities.Tag.where((t) => t.weight.gt(1));
      const error = await rejection(() => client.entities.Post.live(tags));
      assert.strictEqual(error.code, 'JL0005');
      assert.strictEqual(error.message,
        "JL0005: live() on entity 'Post' was handed a chain built over entity 'Tag' — "
        + 'a chain runs against the source it was built over; build it from this handle, '
        + 'or hand it to the handle it was built from');
      assert.strictEqual(liveCount(client), 0);
      const own = await client.entities.Post.live(client.entities.Post.where((p) => p.stars.gt(1)));
      assert.deepStrictEqual(own.result.rows, [{ pid: 1, stars: 4 }]);
      const synchronous = await client.entities.Post.live(from(client.store.sync.entity('Post')).where((p) => p.stars.gt(1)));
      assert.deepStrictEqual(synchronous.result.rows, [{ pid: 1, stars: 4 }]);
      const foreign = from(client.store.sync.entity('Tag')).where((t) => t.weight.gt(1));
      assert.strictEqual((await rejection(() => client.entities.Post.live(foreign))).code, 'JL0005');
    });
  });
});

describe('the client registers a chain over one of its own entities', () => {
  it('any entity of this client registers; a collection chain keeps the store\'s own refusal', async () => {
    await withClient(async (client) => {
      const tag = await client.live(client.entities.Tag.where((t) => t.weight.gt(1)));
      assert.deepStrictEqual(tag.result.rows, [{ tid: 1, weight: 9 }]);
      const error = await rejection(() => client.live(client.collections.users.where((u) => u.age.gt(30))));
      assert.strictEqual(error.code, 'JD0033');
      await client.transaction(async (tx) => {
        const inside = await tx.live(client.entities.Post.where((p) => p.stars.gt(1)));
        assert.deepStrictEqual(inside.result.rows, [{ pid: 1, stars: 4 }]);
      });
    });
  });

  it('a chain over another client\'s same-named source answered right and registers; a different name is refused', async () => {
    await withClient(async (client) => {
      await withClient(async (other) => {
        const post = other.entities.Post.where((p) => p.stars.gt(1));
        for (const register of [
          () => client.live(post),
          () => client.entities.Post.live(post),
          () => client.transaction((tx) => tx.live(post)),
        ]) {
          assert.deepStrictEqual((await register()).result.rows, [{ pid: 1, stars: 4 }]);
        }
        const orders = await client.collections.orders.live(other.collections.orders.where((o) => o.total.gt(1)));
        assert.deepStrictEqual(orders.result.rows, [{ id: 'o1', total: 5 }]);
        assert.strictEqual(liveCount(client), 4);
        const users = other.collections.users.where((u) => u.age.gt(30));
        const error = await rejection(() => client.collections.orders.live(users));
        assert.strictEqual(error.code, 'JL0005');
        assert.match(error.message, /collection 'orders' was handed a chain built over collection 'users' — /);
        assert.strictEqual(liveCount(client), 4);
      });
    });
  });
});
