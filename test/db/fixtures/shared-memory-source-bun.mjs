// Runs under Bun: which stores over one shared-cache in-memory URI read one
// database, and which carry one source. bun:sqlite opens the URI as a file
// of that name, so the fixture runs in a directory of its own.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, STORE_SOURCE } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';

const MODEL = { $model: '0.1', collections: { users: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id' } } };
const PATH = 'file:shared-memory-source?mode=memory&cache=shared';
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jaren-shared-memory-bun-')));
process.chdir(dir);
const failures = [];
const stores = [];
try {
  const open = async (driver) => { const store = await openStore(MODEL, { driver, path: PATH }); stores.push(store); return store; };
  const node = await open(nodeDriver());
  const worker = await open(nodeWorkerDriver());
  const bun = await open(bunDriver());
  await node.collection('users').insert({ id: 'u1' });
  const sourceOf = (store) => store.collection('users')[STORE_SOURCE].store;
  const read = async (store) => (await store.collection('users').get('u1')) !== undefined;
  const expect = (what, actual, expected) => { if (actual !== expected) failures.push(`${what}: ${String(actual)} (expected ${String(expected)})`); };
  expect('the node store\'s source', sourceOf(node), 'sqlite-memory:[null,"shared-memory-source"]');
  expect('the worker store reads the node store\'s rows', await read(worker), true);
  expect('the worker store\'s source', sourceOf(worker), sourceOf(node));
  // a file named by the URI: another database, and another source
  expect('the bun store reads the node store\'s rows', await read(bun), false);
  expect('the bun store\'s source', sourceOf(bun), `sqlite:${join(dir, PATH)}`);
}
catch (error) { failures.push(String(error?.stack ?? error)); }
finally {
  for (const store of stores) await store.close();
  rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', failures })}\n`);
process.exit(failures.length === 0 ? 0 : 1);
