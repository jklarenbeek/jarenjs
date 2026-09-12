//@ts-check
/** Private SQLite initializer and the established Jaren storage identity. */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createBrowserDataWorker } from '@jarenjs/studio/data/host';
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';
createBrowserDataWorker({
  initialize: () => sqlite3InitModule({ print: () => {}, printErr: () => {} }),
  scope: globalThis, createChannel: name => new BroadcastChannel(name),
  identity: { channel: 'jaren-data-studio', pool: 'jaren-data', database: '/jaren-data-studio.db',
    snapshots: 'jaren-data-studio-snapshots', lock: 'jaren-data-studio-owner' },
  operators: createJsltRegistry().use(mathPack).use(financePack).use(statsPack),
});
