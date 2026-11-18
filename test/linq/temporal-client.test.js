//@ts-check
/**
 * @file A linq client over a store opened with the temporal seam
 * (`@jarenjs/db/temporals`): its handles' chains read a calendar value
 * through the seam's calendar — in the store, and in what a chain runs in
 * memory after a host callback, or one the host builds over a handle — and
 * a client opened without the seam refuses a declared member (`JD0017`) and
 * a calendar operator (`JQ0003`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fromAsync } from '@jarenjs/linq';
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { nodeDriver } from '@jarenjs/db/node';
import { storeTemporals } from '@jarenjs/db/temporals';

const utc = (/** @type {string} */ instant) => ({ kind: 'utc', instant });
const ROWS = [{ id: 'a', u: utc('2026-01-01T00:00:00.5Z') }, { id: 'b', u: utc('2026-01-01T00:00:00Z') }];
const event = () => m.object({ id: m.string(), u: m.object({ kind: m.string(), instant: m.string() }) });
const declared = m.defineModel({ collections: { events: m.collection(event(), { key: '/id', temporals: [{ name: 'u', path: '$.u', kind: 'utc' }] }) } });
const plain = m.defineModel({ collections: { events: m.collection(event(), { key: '/id' }) } });
const pass = async (/** @type {any} */ row) => row;

describe('a client opened with the temporal seam', () => {
  it('orders by instantOf in the store, after a host callback, and over a handle the host wraps', async () => {
    for (const model of [declared, plain]) {
      const client = await open(model, { driver: nodeDriver(), validator: null, temporals: storeTemporals() });
      try {
        for (const row of ROWS) await client.collections.events.insert(row);
        const handle = client.collections.events;
        assert.deepEqual(await handle.orderBy((/** @type {any} */ e) => e.u.instantOf()).select((/** @type {any} */ e) => e.id).toArray(), ['b', 'a']);
        assert.deepEqual(await handle.mapAsync(pass, { concurrency: 1 }).orderBy((/** @type {any} */ e) => e.u.instantOf())
          .select((/** @type {any} */ e) => e.id).toArray(), ['b', 'a']);
        assert.deepEqual(await fromAsync(handle).mapAsync(pass, { concurrency: 1 }).orderBy((/** @type {any} */ e) => e.u.instantOf())
          .select((/** @type {any} */ e) => e.id).toArray(), ['b', 'a']);
      }
      finally { await client.close(); }
    }
  });
  it('without it, a declared member is JD0017 and a calendar operator JQ0003', async () => {
    await assert.rejects(open(declared, { driver: nodeDriver(), validator: null }), (/** @type {any} */ e) => e.code === 'JD0017');
    const client = await open(plain, { driver: nodeDriver(), validator: null });
    try {
      await client.collections.events.insert(ROWS[0]);
      const refused = (/** @type {any} */ e) => e.code === 'JQ0003' && /reads a calendar value/.test(e.message);
      await assert.rejects(async () => client.collections.events.select((/** @type {any} */ e) => e.u.instantOf()).toArray(), refused);
      await assert.rejects(async () => client.collections.events.mapAsync(pass, { concurrency: 1 })
        .select((/** @type {any} */ e) => e.u.instantOf()).toArray(), refused);
    }
    finally { await client.close(); }
  });
});
