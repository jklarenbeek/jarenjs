// The real-runtime classification probe: under Bun, open `bun:sqlite`
// through the driver and print what the connection declares and what a
// cursor over it reports — one JSON line the spawning test reads.
import { openStore } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';

const store = await openStore({
  $model: '0.1',
  collections: { notes: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id' } },
}, { driver: bunDriver(), path: ':memory:' });
const notes = store.collection('notes');
await notes.insert({ id: 'a' });
await notes.insert({ id: 'b' });
const document = { $for: { it: '$[*]' }, $return: '$it.id' };
const cursor = notes.query(document);
const rows = [];
for await (const row of cursor) rows.push(row);
const explained = await notes.explain(document);
let strict = null;
try {
  notes.query(document, { strictStreaming: true }).return();
  strict = 'accepted';
}
catch (error) {
  strict = error.code;
}
process.stdout.write(`${JSON.stringify({
  runtime: typeof globalThis.Bun === 'undefined' ? 'node' : `bun ${globalThis.Bun.version}`,
  lazyIteration: store.capabilities.lazyIteration,
  streaming: cursor.streaming,
  barrier: cursor.barrier,
  explainStreaming: explained.streaming,
  strict,
  rows: rows.sort(),
})}\n`);
await store.close();
