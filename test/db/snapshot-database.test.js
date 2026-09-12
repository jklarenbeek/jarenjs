//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('standalone snapshots include committed WAL, raw text and BLOB bytes and never replace a target', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-snapshot-'));
  const runtime = process.versions.bun ? await import('@jarenjs/db/bun') : await import('@jarenjs/db/node');
  const driver = process.versions.bun ? runtime.bunDriver() : runtime.nodeDriver();
  const source = await driver.open(join(directory, 'source.db'));
  try {
    source.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE history(id INTEGER PRIMARY KEY,data BLOB,raw TEXT);INSERT INTO history VALUES(1,X'0000FF',' { \"a\":1 } ')");
    const destination = join(directory, 'copy.db');
    const answer = await runtime.snapshotDatabase(source, destination);
    assert.ok(answer.pages > 0);
    const copy = await driver.open(destination, { readOnly: true });
    try {
      const row = copy.prepare('SELECT * FROM history').get([]);
      assert.deepEqual([...row.data], [0, 0, 255]); assert.equal(row.raw, ' { "a":1 } ');
    }
    finally { copy.close(); }
    const bytes = readFileSync(destination);
    await assert.rejects(runtime.snapshotDatabase(source, destination), { code: 'EEXIST' });
    assert.deepEqual(readFileSync(destination), bytes);
    const empty = join(directory, 'empty.db'); writeFileSync(empty, '');
    await assert.rejects(runtime.snapshotDatabase(source, empty), { code: 'EEXIST' });
    assert.equal(readFileSync(empty).length, 0);
    const failed = join(directory, 'failed.db');
    await assert.rejects(source.transaction(async () => runtime.snapshotDatabase(source, failed)), /transaction/);
    assert.equal(existsSync(failed), false);
  }
  finally { source.close(); rmSync(directory, { recursive: true, force: true }); }
});
