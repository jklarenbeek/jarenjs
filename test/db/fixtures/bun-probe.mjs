// The real-runtime classification probe: under Bun, open `bun:sqlite`
// through the driver and print what the connection declares and what a
// cursor over it reports — one JSON line the spawning test reads.
import { openStore } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const path = join(tmpdir(), `jaren-bun-probe-${process.pid}.db`);

const store = await openStore({
  $model: '0.1',
  collections: { notes: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id' } },
}, { driver: bunDriver(), path });
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
const report = {
  runtime: typeof globalThis.Bun === 'undefined' ? 'node' : `bun ${globalThis.Bun.version}`,
  lazyIteration: store.capabilities.lazyIteration,
  streaming: cursor.streaming,
  barrier: cursor.barrier,
  explainStreaming: explained.streaming,
  strict,
  rows: rows.sort(),
};
await store.close();
rmSync(path);
report.closedFileRemoved = true;
const failedTransactionRows = {};
const connection = await bunDriver().open(path);
try {
  connection.exec('PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); '
    + 'CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) '
    + 'DEFERRABLE INITIALLY DEFERRED);');
  for (const mode of ['deferred', 'immediate']) {
    await assert.rejects(async () => connection.transaction(
      (tx) => tx.exec('INSERT INTO child VALUES(1, 9)'), undefined, mode), /FOREIGN KEY constraint failed/);
    failedTransactionRows[mode] = connection.prepare('SELECT id FROM child').all();
    assert.deepEqual(failedTransactionRows[mode], []);
  }
}
finally {
  connection.close();
}
rmSync(path);
report.reopenedFileRemoved = true;
report.failedTransactionRows = failedTransactionRows;
process.stdout.write(`${JSON.stringify(report)}\n`);
