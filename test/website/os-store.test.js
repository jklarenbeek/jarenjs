//@ts-check
/**
 * Radiant OS storage: `os.model.json` opened by `@jarenjs/db` (here over
 * `node:sqlite`; in the browser over sqlite-wasm on OPFS) and the memory
 * fallback answer the same operations, and both answer them as
 * `store.contract.json` states — the contract the page reaches the
 * database worker through.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nodeDriver } from '@jarenjs/db/node';
import { compileContract } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';
import { JarenValidator } from '@jarenjs/validate';
import storeDoc from '../../packages/website/src/os/documents/store.contract.json' with { type: 'json' };
import { openOsStore, storeHandlers, createMemoryStore } from '../../packages/website/src/os/kernel/store.js';
import { initialState, sessionSlice } from '../../packages/website/src/os/app/state.js';

const storeContract = compileContract(storeDoc, { validator: new JarenValidator({ collectErrors: true }) });

/** An artwork as `gallery.save` writes it. @param {string} id @param {string} at @param {number} tick */
function artwork(id, at, tick) {
  const state = initialState({ edition: 'test', title: 'Radiant OS' });
  return {
    id, title: `Artwork ${id}`, at, tick, harmony: 0.25,
    world: state.world, program: { machine: state.program.machine, tempo: 12 }, merits: state.council.merits,
  };
}

/** Both stores, each behind the store contract with outputs checked. */
async function stores() {
  const { store, handlers } = await openOsStore({ driver: nodeDriver(), mode: 'sqlite', detail: 'node:sqlite in memory' });
  return [
    { name: 'sqlite', client: openLocalClient(storeContract, handlers, { validateOutput: 'always' }), close: () => store.close?.() },
    { name: 'memory', client: openLocalClient(storeContract, createMemoryStore(), { validateOutput: 'always' }), close: () => {} },
  ];
}

describe('the OS database', () => {
  it('keeps artworks and lists them newest first, as the contract states', async () => {
    for (const { name, client, close } of await stores()) {
      const ok = async (/** @type {string} */ op, /** @type {any} */ input) => {
        const outcome = await client.invoke(op, input);
        assert.equal(outcome.ok, true, `${name} ${op}: ${JSON.stringify(outcome.error)}`);
        return outcome.value;
      };
      assert.deepEqual(await ok('artwork.list'), [], `${name} starts empty`);
      assert.equal(await ok('artwork.get', { id: 'none' }), null);
      assert.deepEqual(await ok('artwork.put', { artwork: artwork('a', '2026-01-01T00:00:00.000Z', 10) }), { id: 'a' });
      assert.deepEqual((await ok('artwork.list')).map((/** @type {any} */ a) => a.id), ['a'], `${name} lists a single artwork as a list`);
      await ok('artwork.put', { artwork: artwork('c', '2026-03-01T00:00:00.000Z', 30) });
      await ok('artwork.put', { artwork: artwork('b', '2026-02-01T00:00:00.000Z', 20) });
      const list = await ok('artwork.list');
      assert.deepEqual(list.map((/** @type {any} */ a) => a.id), ['c', 'b', 'a'], `${name} lists newest first`);
      assert.deepEqual(Object.keys(list[0]).sort(), ['at', 'harmony', 'id', 'tick', 'title'], `${name} lists summaries only`);
      const kept = await ok('artwork.get', { id: 'b' });
      assert.deepEqual(kept, artwork('b', '2026-02-01T00:00:00.000Z', 20), `${name} gives the whole artwork back`);
      const info = await ok('store.info');
      assert.equal(info.mode, name);
      close();
    }
  });

  it('keeps the constitution in session order', async () => {
    for (const { name, client, close } of await stores()) {
      const amendment = (/** @type {string} */ id, /** @type {number} */ session) => ({
        id, proposal: `p-${id}`, session, by: 'critic', title: 'Wash', status: 'enacted', change: { kind: 'tape', op: 'clear' },
        score: 0.5, reward: null, inverse: [], previousTempo: 12, tick: session * 100,
      });
      for (const [id, session] of /** @type {const} */ ([['a3', 3], ['a1', 1], ['a2', 2]])) {
        const put = await client.invoke('amendment.put', { amendment: amendment(id, session) });
        assert.deepEqual(put.value, { id });
      }
      const list = await client.invoke('amendment.list');
      assert.deepEqual(list.value.map((/** @type {any} */ a) => a.id), ['a1', 'a2', 'a3'], `${name} orders by session`);
      close();
    }
  });

  it('saves the running session and gives it back', async () => {
    for (const { name, client, close } of await stores()) {
      assert.equal((await client.invoke('session.get')).value, null, `${name} has no session yet`);
      const slice = sessionSlice(initialState({ edition: 'test', title: 'Radiant OS' }));
      const put = await client.invoke('session.put', { state: slice });
      assert.ok(!Number.isNaN(Date.parse(put.value.at)));
      const got = await client.invoke('session.get');
      assert.equal(got.value.id, 'current');
      assert.deepEqual(got.value.state, slice);
      await client.invoke('session.put', { state: { ...slice, council: { ...slice.council, session: 7 } } });
      assert.equal((await client.invoke('session.get')).value.state.council.session, 7, `${name} keeps one session, the latest`);
      close();
    }
  });

  it('isolates what the memory store keeps from what the caller holds', () => {
    const memory = createMemoryStore();
    const art = artwork('x', '2026-01-01T00:00:00.000Z', 1);
    memory['artwork.put']({ artwork: art });
    art.title = 'changed afterwards';
    assert.equal(memory['artwork.get']({ id: 'x' }).title, 'Artwork x');
    assert.match(memory['store.info']().detail, /nothing is kept after a reload/);
  });

  it('serves any open store with the default mode', async () => {
    const { store } = await openOsStore({ driver: nodeDriver() });
    const handlers = storeHandlers(store, 'sqlite', '');
    assert.deepEqual(await handlers['store.info'](), { mode: 'sqlite', detail: '' });
    const opened = await openOsStore({ driver: nodeDriver() });
    assert.deepEqual(await opened.handlers['store.info'](), { mode: 'sqlite', detail: '' });
  });
});
