//@ts-check
/**
 * @file The join handle under a store profile that bounds an entity the
 * join table relates (MODEL-FORMAT §8, §10.7): a membership is readable
 * only where the row it names is, so the handle's chains, its count, its
 * cursor, its live query and a many-to-many hop from the other side answer
 * the memberships of the admitted users alone, natively, on SQLite and on
 * PostgreSQL.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { fromAsync } from '@jarenjs/linq';
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { nodeDriver } from '@jarenjs/db/node';

import { ENGINES, skipFor, withPostgres } from '../db/store-core-engines.js';

const User = m.object({ id: m.string().key(), tenant: m.string(), labels: m.rel.belongsToMany('Label') });
const Label = m.object({ name: m.string().key(), users: m.rel.belongsToMany('User') });
const model = m.defineModel({ entities: { User, Label } });
const profile = { predicates: { User: { $eq: ['$it.tenant', 't1'] } } };

/**
 * A client under the tenant profile, seeded: u1 (t1) holds admin; u2 (t2)
 * holds secret and admin.
 * @param {string} engine @param {(client: any) => Promise<void>} fn @param {Record<string, unknown>} [options]
 */
async function withClient(engine, fn, options = {}) {
  const run = async (/** @type {any} */ driver) => {
    const client = await open(model, { driver, validator: null, profile, ...options });
    try {
      await client.transaction(async (/** @type {any} */ tx) => {
        for (const [id, tenant] of [['u1', 't1'], ['u2', 't2']]) await tx.store.entity('User').create({ id, tenant });
        for (const name of ['admin', 'secret']) await tx.store.entity('Label').create({ name });
      });
      client.entities.User.link('u1', 'labels', 'admin');
      client.entities.User.link('u2', 'labels', 'secret');
      client.entities.User.link('u2', 'labels', 'admin');
      await client.saveChanges();
      await fn(client);
    }
    finally { await client.close(); }
  };
  if (engine === 'sqlite') return run(nodeDriver());
  return withPostgres(({ driver }) => run(driver()));
}

for (const engine of ENGINES) {
  describe(`the join handle under a profile that bounds a side, ${engine}`, { skip: skipFor(engine) }, () => {
    it('the chains, the count and the cursor answer the admitted users\' memberships alone, natively', () => withClient(engine, async (client) => {
      const memberships = client.entities.User.memberships.labels;
      assert.deepStrictEqual(await memberships.toArray(), [{ Label_key: 'admin', User_key: 'u1' }]);
      const other = memberships.where((j) => j.User_key.eq('u2')).select((j) => j.Label_key);
      assert.deepStrictEqual(await other.toArray(), []);
      assert.strictEqual((await memberships.explain(other)).mode, 'native');
      assert.strictEqual(await memberships.count(), 1);
      assert.strictEqual(await client.entities.Label.memberships.users.where((j) => j.Label_key.eq('admin')).count(), 1);
      const items = [];
      for await (const row of memberships.cursor(memberships.toDocument())) items.push(row);
      assert.deepStrictEqual(items, [{ Label_key: 'admin', User_key: 'u1' }]);
      const labels = client.entities.Label;
      const counted = labels.groupJoin(fromAsync(memberships), (l) => l.name, (j) => j.Label_key,
        (l, g) => ({ label: l.name, n: g.count() }));
      assert.deepStrictEqual(await counted.toArray(), [{ label: 'admin', n: 1 }, { label: 'secret', n: 0 }]);
      assert.strictEqual((await labels.explain(counted)).mode, 'native');
    }));

    it('a many-to-many hop from the other side reaches the admitted users alone', () => withClient(engine, async (client) => {
      const labels = client.entities.Label;
      const held = labels.select((l) => ({ name: l.name, users: l.users.count() }));
      assert.deepStrictEqual(await held.toArray(), [{ name: 'admin', users: 1 }, { name: 'secret', users: 0 }]);
    }));
  });
}

describe('the join handle under a profile: a live query', () => {
  it('re-runs on a write to the bounding side, and equals a fresh run', () => withClient('sqlite', async (client) => {
    const memberships = client.entities.User.memberships.labels;
    const live = await memberships.live(memberships.select((j) => j.Label_key));
    try {
      assert.deepStrictEqual(live.result.rows, ['admin']);
      await client.store.entity('User').update('u2', { tenant: 't1' });
      assert.deepStrictEqual([...live.result.rows].sort(), ['admin', 'admin', 'secret']);
      assert.deepStrictEqual([...live.result.rows].sort(), [...await memberships.select((j) => j.Label_key).toArray()].sort());
    }
    finally { await live.close(); }
  }, { capture: true }));
});
