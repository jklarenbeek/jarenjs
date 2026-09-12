//@ts-check
/** Private SQLite initializer for an isolated project-model worker. */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createProjectDataWorker } from '@jarenjs/studio/data/host';
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';
createProjectDataWorker({
  initialize: () => sqlite3InitModule({ print: () => {}, printErr: () => {} }), scope: globalThis,
  operators: createJsltRegistry().use(mathPack).use(financePack).use(statsPack),
});
