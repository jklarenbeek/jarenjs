//@ts-check
/** Installed public-API probe; inputs are copied beside this file by the pack gate. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nodeDriver } from '@jarenjs/db/node';
import { bunDriver } from '@jarenjs/db/bun';
import { readSchema } from '@jarenjs/db';
import { compileJsonQuery } from '@jarenjs/json/query';

const fixture = JSON.parse(readFileSync(new URL('./adoption-relational.json', import.meta.url), 'utf8'));
const consumers = JSON.parse(readFileSync(new URL('./adoption-consumers.json', import.meta.url), 'utf8'));
const db = await (process.versions.bun ? bunDriver() : nodeDriver()).open(':memory:');
try {
  for (const sql of [...fixture.ddl, ...fixture.seed]) db.exec(sql);
  for (const read of fixture.reads)
    assert.deepEqual(JSON.parse(JSON.stringify(db.prepare(read.sql).all([]))), read.expected);
  assert.ok((await readSchema(db)).tables.length >= 5);
  for (const { definition, rows, expected } of consumers) {
    assert.equal(rows.length, definition.rows);
    const query = compileJsonQuery({ $count: { $for: { row: '$[*]' },
      $where: { $eq: ['$row.provenance', 'manual'] }, $return: '$row.id' } });
    assert.equal(query(rows), expected.protectedRows);
    assert.equal(rows[0].sku, '00000000');
  }
}
finally { db.close(); }
