// Runs under Bun: writes to a file another runtime created, whose unique index keys a container by the key two triggers
// write, through the store and as a writer of its own. Argument: the file. Prints what each write answered and the key
// the triggers wrote.
import { Database } from 'bun:sqlite';
import { openStore } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';

const path = process.argv[2];
const model = { $model: '0.1', collections: { c: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, q: { type: ['string', 'object', 'array'] } } },
  indexes: [{ name: 'by_q', path: '$.q', unique: true }] } } };
const store = await openStore(model, { driver: bunDriver(), path });
const answers = [];
try {
  for (const doc of [{ id: 'b', q: { y: 2, x: 1 } }, { id: 'c', q: [1, { b: 2, a: 1 }] }, { id: 'd', q: { x: 1, y: 3 } }])
    answers.push(await store.collection('c').insert(doc).then(() => 'stored', (/** @type {any} */ error) => error.code));
}
finally { await store.close(); }
const raw = new Database(path);
// a writer of its own, which escapes a member name
for (const [key, text] of [['f', '{"id":"f","q":{"\\u0079":2,"x":1}}'], ['g', '{"id":"g","q":{"\\u007a":1}}']]) {
  try { raw.prepare('INSERT INTO "c" ("key", "doc") VALUES (?, jsonb(?))').run(key, text); answers.push('stored'); }
  catch (error) { answers.push(String(/** @type {any} */ (error).message)); }
}
const keys = raw.prepare('SELECT "key", "kx_q" FROM "c" ORDER BY "key"').all().map((row) => [row.key, row.kx_q]);
raw.close();
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', answers, keys })}\n`);
