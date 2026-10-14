//@ts-check
/**
 * @file A handle hands the store a chain's `params()` bindings with the
 * call's `externals` merged over them. `params()` refuses a `Date` itself
 * (`JL0004`); one given under the call's `externals` reaches the store,
 * which refuses it where a comparison reads it as `{}` (`JD0041`) on every
 * member a handle runs a chain through — `execute`, `query`, `explain` and
 * `live` — where it matched no row. Its ISO string answers, and a `Date`
 * the chain never compares is not read. A store run is SQLite always,
 * PostgreSQL where JAREN_PG_URL names a server.
 */

import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert';

import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;

const Visit = m.object({ id: m.string(), seen: m.string() });
const model = m.defineModel({ collections: { visits: m.collection(Visit, { key: (d) => d.id }) } });

const SINCE = new Date('2026-03-01T00:00:00Z');

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
    const schema = `jaren_handleexternals_${process.pid}_${schemas.length + 1}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    driver = postgresDriver(pool, { schema });
  }
  const client = await open(model, { driver, capture: true, validator: null });
  for (const [id, seen] of [['a', '2026-01-01T00:00:00Z'], ['b', '2026-06-01T00:00:00Z']]) await client.collections.visits.insert({ id, seen });
  return client;
}

/** What a call refuses with, thrown at the call or a rejected promise. @param {() => any} call */
async function refusal(call) {
  let pending;
  try { pending = call(); }
  catch (error) { return /** @type {any} */ (error); }
  try { await pending; }
  catch (error) { return /** @type {any} */ (error); }
  return assert.fail('expected a refusal');
}

/** The rows a cursor yields. @param {AsyncIterable<any>} cursor */
async function rows(cursor) {
  const out = [];
  for await (const row of cursor) out.push(row);
  return out;
}

/** The refusal `JD0041` gives `$since` on a member. @param {string} member */
const refused = (member) => `JD0041: ${member} external '$since' holds a Date instance, which a comparison reads as {} — `
  + 'pass the JSON value it stands for, a Date as its toISOString() at /$where/$gt/1';

for (const host of [{ name: 'sqlite', postgres: false }, ...(url ? [{ name: 'postgres', postgres: true }] : [])]) {
  describe(`a chain's Date binding is refused where a comparison reads it, ${host.name}`, () => {
    /** @type {any} */
    let client;
    before(async () => { client = await openClient(host.postgres); });
    after(async () => { await client.close(); });

    const later = (/** @type {any} */ since, /** @type {any} */ extra = {}) => client.collections.visits.params({ since, ...extra })
      .where((/** @type {any} */ v, /** @type {any} */ q) => v.seen.gt(q.since)).select((/** @type {any} */ v) => v.id);

    it('the call\'s externals merged over the chain\'s bindings, on execute, query, explain and live', async () => {
      const visits = client.collections.visits;
      const chain = later(SINCE.toISOString());
      const externals = { since: SINCE };
      // each answered no row: the Date compared as {}
      assert.strictEqual((await refusal(() => visits.execute(chain, { externals }))).message, refused("collection('visits').execute"));
      assert.strictEqual((await refusal(() => rows(visits.query(chain, { externals })))).message, refused("collection('visits').query"));
      assert.strictEqual((await refusal(() => visits.explain(chain, { externals }))).message, refused("collection('visits').explain"));
      if (!host.postgres) {
        assert.strictEqual((await refusal(() => visits.live(chain, { externals }))).message, refused("collection('visits').live"));
      }
      // a binding is checked by params() itself, before the store
      assert.strictEqual((await refusal(() => visits.execute(later(SINCE)))).code, 'JL0004');
    });

    it('its ISO string answers, and a Date the chain never compares is not read', async () => {
      const visits = client.collections.visits;
      const iso = SINCE.toISOString();
      assert.deepStrictEqual(await visits.execute(later(iso)), 'b');
      assert.deepStrictEqual(await later(iso).toArray(), ['b']);
      assert.deepStrictEqual(await visits.execute(later(iso), { externals: { stamp: SINCE } }), 'b');
    });
  });
}
