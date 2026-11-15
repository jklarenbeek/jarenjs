//@ts-check
/**
 * @file Where a boolean ordering key is answered and where it is refused,
 * the runtime fact the typed chain's key follows: a chain (an entity's, a
 * collection's, an in-memory sequence's) refuses a boolean key with
 * `JQ2005` on every provider, and the load path — a graph page and an
 * include — orders it false before true. SQLite always, PostgreSQL where
 * JAREN_PG_URL names a server.
 */
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from } from '@jarenjs/linq';
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;

const model = m.defineModel({
  entities: {
    Org: m.object({ id: m.string().key(), name: m.string(), active: m.boolean(),
      mems: m.rel.hasMany('Mem', { via: 'org', onDelete: 'cascade' }) }),
    Mem: m.object({ id: m.string().key(), org: m.string(), on: m.boolean(),
      owner: m.rel.hasOne('Org', { via: 'org', onDelete: 'cascade' }) }),
  },
  collections: { flags: m.collection(m.object({ id: m.string(), on: m.boolean() }), { key: '/id' }) },
});

/** @type {any} */
let admin = null;
/** @type {any} */
let pool = null;
const schemas = /** @type {string[]} */ ([]);

before(async () => {
  if (!url) return;
  const pg = (await import('pg')).default;
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
async function openClient(postgres) {
  let driver = nodeDriver();
  if (postgres) {
    const schema = `jaren_booleanorder_${process.pid}_${schemas.length + 1}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    driver = postgresDriver(pool, { schema });
  }
  const client = await open(model, { driver });
  // the true row first, so an order that ignored the key would show it
  await client.entities.Org.create({ id: 'o1', name: 'b', active: true });
  await client.entities.Org.create({ id: 'o2', name: 'a', active: false });
  await client.entities.Mem.create({ id: 'm1', org: 'o1', on: true });
  await client.entities.Mem.create({ id: 'm2', org: 'o1', on: false });
  await client.collections.flags.insert({ id: 'f1', on: true });
  await client.collections.flags.insert({ id: 'f2', on: false });
  return client;
}

/** @param {() => any} call */
const later = (call) => Promise.resolve().then(call);

describe('a boolean ordering key', () => {
  it('is JQ2005 on an in-memory chain', () => {
    const rows = [{ id: 'a', on: true }, { id: 'b', on: false }];
    assert.throws(() => from(rows).orderBy((/** @type {any} */ r) => r.on).toArray(), { code: 'JQ2005' });
    assert.throws(() => from(rows).orderBy((/** @type {any} */ r) => r.id.eq('a')).toArray(), { code: 'JQ2005' });
  });

  for (const engine of ['sqlite', 'postgres']) {
    it(`${engine}: a chain refuses it, a graph page and an include order it false before true`, { skip: engine === 'postgres' && !url }, async () => {
      const client = await openClient(engine === 'postgres');
      try {
        const orgs = /** @type {any} */ (client.entities.Org);
        await assert.rejects(later(() => orgs.orderBy((/** @type {any} */ o) => o.active).toArray()), { code: 'JQ2005' });
        await assert.rejects(later(() => orgs.orderBy((/** @type {any} */ o) => o.name).thenByDescending((/** @type {any} */ o) => o.active).toArray()),
          { code: 'JQ2005' });
        const flags = /** @type {any} */ (client.collections.flags);
        await assert.rejects(later(() => flags.orderBy((/** @type {any} */ f) => f.on).toArray()), { code: 'JQ2005' });

        const ascending = await orgs.graph().orderBy((/** @type {any} */ o) => o.active).page({ limit: 5, maxBytes: 65536 });
        assert.deepEqual(ascending.items.map((/** @type {any} */ o) => o.id), ['o2', 'o1']);
        const descending = await orgs.graph().orderByDescending((/** @type {any} */ o) => o.active).page({ limit: 5, maxBytes: 65536 });
        assert.deepEqual(descending.items.map((/** @type {any} */ o) => o.id), ['o1', 'o2']);

        const loaded = await orgs.include((/** @type {any} */ o) => o.mems, { orderBy: (/** @type {any} */ mm) => mm.on })
          .where((/** @type {any} */ o) => o.id.eq('o1')).toArray();
        assert.deepEqual(loaded[0].mems.map((/** @type {any} */ mm) => mm.id), ['m2', 'm1']);
      }
      finally { await client.close(); }
    });
  }
});
