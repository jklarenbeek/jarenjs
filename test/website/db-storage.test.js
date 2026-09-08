//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { selectBrowserStorage } from '../../packages/website/src/lib/db-storage.js';

describe('observed browser storage ladder', () => {
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
