//@ts-check
/**
 * @file A chain's named zone reads the wall clock through the zone
 * provider its host injects (QUERY-PEN §8.1): `from()`, `fromAsync()`,
 * `fromDocument()` and `federate()` take `zoneProvider`, or the runtime
 * record's, and a client `open()`ed with one hands it to every chain over
 * its handles, in memory and in the store alike. Each answer is the one
 * `compileJsonQuery(document, { zoneProvider })` gives; without a
 * provider the refusal is the engine's `JQ0003`; and two providers whose
 * identities differ never share a compiled document. SQLite always,
 * PostgreSQL where JAREN_PG_URL names a server.
 */
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromAsync, fromDocument, federate } from '@jarenjs/linq';
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { prepareModel } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { compileJsonQuery, queryJson } from '@jarenjs/json/query';
import { createRuntime } from '@jarenjs/core/runtime';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const url = process.env.JAREN_PG_URL;
const ZONE = 'Europe/Amsterdam';
const provider = createIntlZoneProvider({ revision: 'host ICU' });
/**
 * A provider that names itself as `provider` does, at another revision,
 * and reads the zone as Tokyo: it answers differently, so a compiled
 * document shared between the two would show.
 * @param {string} revision
 */
const aliased = (revision) => Object.freeze({
  toParts: (/** @type {number} */ epoch, /** @type {string} */ zone) =>
    provider.toParts(epoch, zone === ZONE ? 'Asia/Tokyo' : zone),
  toEpoch: (/** @type {any} */ parts, /** @type {string} */ zone, /** @type {string} */ disambiguation) =>
    provider.toEpoch(parts, zone === ZONE ? 'Asia/Tokyo' : zone, disambiguation),
  identity: Object.freeze({ name: 'intl', revision }),
});

const ROWS = [
  { id: 'a', on: '2026-10-31T23:30:00Z', ts: Date.UTC(2026, 9, 31, 23, 30) },
  { id: 'b', on: '2026-03-29T00:30:00Z', ts: Date.UTC(2026, 2, 29, 0, 30) },
];
/** A named-zone date format and a named-zone series operator, in one projection. */
const project = (/** @type {any} */ e) => ({
  id: e.id,
  local: e.on.dateFormat('yyyy-MM-dd HH:mm', ZONE),
  day: e.ts.timeBucket('P1D', null, { zone: ZONE }),
});
/** What the engine answers for the chain's own document under `zones`. @param {any} zones */
const oracle = (zones) => compileJsonQuery(from([]).select(project).toDocument(), { zoneProvider: zones })(ROWS);
const isZoneRefusal = (/** @type {any} */ error) => error?.code === 'JQ0003' && /needs a time-zone provider/.test(error.message);

describe('an in-memory chain over a zone provider', () => {
  it('answers the named zone as compileJsonQuery does, from the option or the runtime record', async () => {
    const expected = oracle(provider);
    assert.deepStrictEqual(expected.map((/** @type {any} */ row) => row.local), ['2026-11-01 00:30', '2026-03-29 01:30']);
    assert.deepStrictEqual(from(ROWS, { zoneProvider: provider }).select(project).toArray(), expected);
    const runtime = createRuntime({ zoneProvider: provider });
    assert.deepStrictEqual(from(ROWS, { runtime }).select(project).toArray(), expected);
    assert.deepStrictEqual(await fromAsync(ROWS, { runtime }).select(project).toArray(), expected);
    assert.deepStrictEqual(fromDocument(ROWS, '$[*]', { runtime }).select(project).toArray(), expected);
    // an explicit option wins over the record's member, as openStore reads them
    assert.deepStrictEqual(from(ROWS, { runtime, zoneProvider: aliased('other') }).select(project).toArray(), oracle(aliased('other')));
    // a partial record, a phase after a host callback, and an aggregate over it
    assert.deepStrictEqual(await fromAsync(ROWS, { runtime: { zoneProvider: provider } })
      .mapAsync(async (/** @type {any} */ row) => row, { concurrency: 1 }).select(project).toArray(), expected);
    assert.strictEqual(await fromAsync(ROWS, { runtime })
      .mapAsync(async (/** @type {any} */ row) => row, { concurrency: 1 })
      .select((/** @type {any} */ e) => e.on.dateFormat('HH', ZONE)).max(), '01');
  });

  it('without one refuses the named zone as before, and UTC needs none', async () => {
    assert.throws(() => from(ROWS).select(project).toArray(), isZoneRefusal);
    assert.throws(() => from(ROWS, { runtime: createRuntime() }).select(project).toArray(), isZoneRefusal);
    await assert.rejects(async () => fromAsync(ROWS).select(project).toArray(), isZoneRefusal);
    assert.deepStrictEqual(from(ROWS).select((/** @type {any} */ e) => e.on.dateFormat('HH:mm', 'UTC')).toArray(), ['23:30', '00:30']);
  });

  it('never shares a compiled document between providers whose identities differ', () => {
    const chain = (/** @type {any} */ zones) => from(ROWS, { zoneProvider: zones }).select(project).toArray();
    const one = chain(aliased('r1'));
    // the same name at another revision, the same document text: compiled again
    const two = chain(aliased('r2'));
    assert.deepStrictEqual(one, oracle(aliased('r1')));
    assert.deepStrictEqual(two, oracle(aliased('r2')));
    assert.deepStrictEqual(chain(provider), oracle(provider));
    assert.notDeepStrictEqual(one.map((/** @type {any} */ row) => row.local), oracle(provider).map((/** @type {any} */ row) => row.local));
    // and a provider that declares no identity keys by its object
    const { identity: _identity, ...bare } = aliased('r3');
    assert.deepStrictEqual(chain(provider), oracle(provider));
    assert.deepStrictEqual(chain(Object.freeze({ ...bare })), oracle(aliased('r3')));
    assert.deepStrictEqual(chain(Object.freeze({ toParts: provider.toParts, toEpoch: provider.toEpoch })), oracle(provider));
  });

  it('refuses what is no provider, and an identity that is no { name, revision }', () => {
    assert.throws(() => from(ROWS, { zoneProvider: 'Europe/Amsterdam' }).select(project).toArray(), TypeError);
    assert.throws(() => from(ROWS, { zoneProvider: { ...provider, identity: { name: 'intl' } } }).select(project).toArray(),
      /options\.zoneProvider\.identity must be \{ name, revision \} with non-empty strings/);
    assert.throws(() => from(ROWS, { runtime: { clock: Date.now } }), TypeError);
  });

  it('reaches what a federation runs over the fetched sides', async () => {
    const source = (/** @type {any[]} */ rows) => ({ execute: async (/** @type {any} */ document) => queryJson(document, rows) });
    const joined = (/** @type {any} */ spec) => {
      const fed = federate({ sources: { left: source(ROWS), right: source(ROWS) }, maxRows: 10, maxBytes: 1 << 20, ...spec });
      return fromAsync(fed.source('left'))
        .join(fromAsync(fed.source('right')), (/** @type {any} */ l) => l.id, (/** @type {any} */ r) => r.id,
          (/** @type {any} */ l, /** @type {any} */ r) => ({ id: l.id, local: r.on.dateFormat('yyyy-MM-dd HH:mm', ZONE) }))
        .toArray();
    };
    const expected = oracle(provider).map((/** @type {any} */ row) => ({ id: row.id, local: row.local }));
    assert.deepStrictEqual(await joined({ zoneProvider: provider }), expected);
    assert.deepStrictEqual(await joined({ runtime: createRuntime({ zoneProvider: provider }) }), expected);
    await assert.rejects(async () => joined({}), isZoneRefusal);
  });
});

const model = m.defineModel({
  entities: { Event: m.object({ id: m.string().key(), on: m.string(), ts: m.number() }) },
  collections: { events: m.collection(m.object({ id: m.string(), on: m.string(), ts: m.number() }), { key: '/id' }) },
});

/** @type {any} */
let pool = null;
/** @type {any} */
let admin = null;
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

/** @param {boolean} postgres @param {any} options @param {any} [over] */
async function openClient(postgres, options, over = model) {
  let driver = nodeDriver();
  if (postgres) {
    const schema = `jaren_chainzones_${process.pid}_${schemas.length + 1}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    driver = postgresDriver(pool, { schema });
  }
  const client = await open(over, { driver, ...options });
  for (const row of ROWS) {
    await client.collections.events.insert(row);
    await client.entities.Event.create(row);
  }
  return client;
}

for (const postgres of [false, true]) {
  describe(`a db chain over a zone provider on ${postgres ? 'PostgreSQL' : 'SQLite'}`, { skip: postgres && !url && 'JAREN_PG_URL is not set' }, () => {
    it('answers the named zone as compileJsonQuery does, pushed and in memory', async () => {
      const expected = oracle(provider);
      for (const options of [{ runtime: createRuntime({ zoneProvider: provider }) }, { zoneProvider: provider }]) {
        const client = await openClient(postgres, options);
        try {
          for (const handle of [client.collections.events, client.entities.Event]) {
            const byId = (/** @type {any} */ chain) => chain.orderBy((/** @type {any} */ e) => e.id);
            // what the store runs
            assert.deepStrictEqual(await byId(handle).select(project).toArray(), expected);
            // a phase after a host callback runs in memory: the client's provider again
            assert.deepStrictEqual(await byId(handle).mapAsync(async (/** @type {any} */ row) => row, { concurrency: 1 })
              .select(project).toArray(), expected);
            // a chain the host builds over the handle
            assert.deepStrictEqual(await byId(fromAsync(handle)).mapAsync(async (/** @type {any} */ row) => row, { concurrency: 1 })
              .select(project).toArray(), expected);
            assert.strictEqual(await byId(handle).mapAsync(async (/** @type {any} */ row) => row, { concurrency: 1 })
              .select((/** @type {any} */ e) => e.on.dateFormat('HH', ZONE)).max(), '01');
          }
          // a transaction's handles carry it too
          await client.transaction(async (/** @type {any} */ tx) => {
            assert.deepStrictEqual(await tx.collections.events.orderBy((/** @type {any} */ e) => e.id)
              .mapAsync(async (/** @type {any} */ row) => row, { concurrency: 1 }).select(project).toArray(), expected);
          });
        }
        finally { await client.close(); }
      }
    });

    it('without one refuses the named zone, pushed and in memory', async () => {
      const client = await openClient(postgres, {});
      try {
        const handle = client.collections.events;
        await assert.rejects(async () => handle.select(project).toArray(), isZoneRefusal);
        await assert.rejects(async () => handle.mapAsync(async (/** @type {any} */ row) => row, { concurrency: 1 })
          .select(project).toArray(), isZoneRefusal);
        await assert.rejects(async () => fromAsync(handle).mapAsync(async (/** @type {any} */ row) => row, { concurrency: 1 })
          .select(project).toArray(), isZoneRefusal);
      }
      finally { await client.close(); }
    });

    it('keeps two clients of one prepared model to their own providers', async () => {
      const prepared = prepareModel(model);
      const first = await openClient(postgres, { zoneProvider: aliased('r1') }, prepared);
      const second = await openClient(postgres, { zoneProvider: provider }, prepared);
      try {
        const run = (/** @type {any} */ client) => client.collections.events.orderBy((/** @type {any} */ e) => e.id)
          .mapAsync(async (/** @type {any} */ row) => row, { concurrency: 1 }).select(project).toArray();
        assert.deepStrictEqual(await run(first), oracle(aliased('r1')));
        assert.deepStrictEqual(await run(second), oracle(provider));
        assert.deepStrictEqual(await run(first), oracle(aliased('r1')));
        const pushed = (/** @type {any} */ client) => client.entities.Event.orderBy((/** @type {any} */ e) => e.id).select(project).toArray();
        assert.deepStrictEqual(await pushed(first), oracle(aliased('r1')));
        assert.deepStrictEqual(await pushed(second), oracle(provider));
      }
      finally {
        await first.close();
        await second.close();
      }
    });
  });
}
