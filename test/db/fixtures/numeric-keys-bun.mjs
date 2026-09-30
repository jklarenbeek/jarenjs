// Run under Bun by test/db/numeric-keys.test.js, on a file node wrote:
// read numeric key 7, upsert it, and report what the key column holds.
import { openStore } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';

const [file, model] = process.argv.slice(2);
const store = await openStore(JSON.parse(model), { driver: bunDriver(), path: file });
const items = store.collection('items');
const found = (await items.get(7)) ?? null;
await items.put({ id: 7, label: 'upserted by bun' });
const rows = store.sync.transaction((tx) =>
  tx.sql.prepare('SELECT "key" FROM "items" ORDER BY "key"', { access: 'read' }).all([]));
const after = await items.get(7);
await store.close();
process.stdout.write(`${JSON.stringify({ runtime: `bun ${process.versions.bun}`, found,
  keys: rows.map((row) => row.key), after })}\n`);
