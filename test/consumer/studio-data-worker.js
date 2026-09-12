/** A private host supplies the official initializer and all storage identities. */
import initialize from '@sqlite.org/sqlite-wasm';
import { createBrowserDataWorker } from '@jarenjs/studio/data/host';
createBrowserDataWorker({ initialize: () => initialize({ print() {}, printErr() {} }), scope: globalThis,
  createChannel: name => new BroadcastChannel(name), identity: {
    channel: 'jaren-installed-editor-data', pool: 'jaren-installed-editor', database: '/installed-editor.db',
    snapshots: 'jaren-installed-editor-snapshots', lock: 'jaren-installed-editor-owner',
  },
});
