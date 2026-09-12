import initialize from '@sqlite.org/sqlite-wasm';
import { createProjectDataWorker } from '@jarenjs/studio/data/host';
createProjectDataWorker({ initialize: () => initialize({ print() {}, printErr() {} }), scope: globalThis });
