//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { selectBrowserStorage, discoverStorageOwner } from '../../packages/website/src/lib/db-storage.js';

describe('observed browser storage ladder', () => {
  it('a busy owner can answer the longer discovery window', async () => {
    const windows = [];
    const result = await discoverStorageOwner({ held: true }, async (ms) => {
      windows.push(ms);
      return windows.length === 1 ? false : { vfs: 'opfs-sahpool' };
    });
    assert.deepEqual(windows, [600, 3000]);
    assert.deepEqual(result, { vfs: 'opfs-sahpool' });
  });

  it('a held handle with no responding owner refuses honestly, while an unavailable API permits memory', async () => {
    await assert.rejects(discoverStorageOwner({ held: true }, async () => false), (error) => {
      assert.equal(error.code, 'JD2061');
      assert.match(error.message, /held by another context/);
      assert.match(error.message, /no studio owner answered/);
      assert.doesNotMatch(error.message, /OPFS is unavailable/);
      return true;
    });
    assert.equal(await discoverStorageOwner({}, async () => false), false);
    let attempts = 0;
    assert.deepEqual(await discoverStorageOwner({}, async () => { attempts++; return { vfs: 'opfs-sab' }; }), { vfs: 'opfs-sab' });
    assert.equal(attempts, 1);
  });

  it('a held OPFS access handle stops fallback before a private store can be selected', async () => {
    const held = new DOMException('the access handle is held', 'NoModificationAllowedError');
    const result = await selectBrowserStorage({ isolated: false, sharedArrayBuffer: false,
      sab: async () => ({}),
      sah: async () => { throw new Error('pool installation failed', { cause: held }); },
      indexedDB: async () => { assert.fail('a held database must not become a private snapshot store'); },
    });
    assert.equal(result.held, true);
    assert.equal(result.vfs, 'owner-selected');
    assert.equal(result.durable, false);
    assert.match(result.failures.at(-1).reason, /pool installation failed/);
  });

  for (const selected of ['opfs-sab', 'opfs-sahpool', 'indexeddb-snapshot', 'memory']) {
    it(`selects ${selected} and names every preceding refusal`, async () => {
      const attempted = [];
      const probe = (name) => async () => { attempted.push(name); if (name !== selected) throw new Error(`${name} denied`); return { observed: true }; };
      const result = await selectBrowserStorage({ isolated: true, sharedArrayBuffer: true,
        sab: probe('opfs-sab'), sah: probe('opfs-sahpool'), indexedDB: probe('indexeddb-snapshot') });
      assert.equal(result.vfs, selected);
      assert.equal(result.durable, selected !== 'memory');
      assert.equal(result.failures.length, attempted.length - (selected === 'memory' ? 0 : 1));
      assert.ok(result.failures.every((failure) => failure.reason === `${failure.vfs} denied`));
    });
  }
  for (const runtime of [{ isolated: false, sharedArrayBuffer: true }, { isolated: true, sharedArrayBuffer: false }]) {
    it(`requires both isolation and SharedArrayBuffer (${JSON.stringify(runtime)})`, async () => {
      const result = await selectBrowserStorage({ ...runtime,
        sab: async () => { assert.fail('SAB VFS must not be attempted'); },
        sah: async () => ({}), indexedDB: async () => { assert.fail('lower rung must not be attempted'); } });
      assert.equal(result.vfs, 'opfs-sahpool');
      assert.equal(result.failures.length, 1);
      assert.match(result.failures[0].reason, /unavailable/);
    });
  }
});
