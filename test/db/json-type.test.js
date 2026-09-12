//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { relational, sql } from '@jarenjs/db/relational';

it('native JSON type preserves missing, null and scalar distinctions through CASE and synchronous cursors', async () => {
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
  const db = await driver.open(':memory:');
  try {
    db.exec('CREATE TABLE documents(id INTEGER PRIMARY KEY,raw TEXT)');
    const raw = ['{}', '{"amount":null}', ' { "amount" : 0 } ', '{"amount":"0"}', '{"amount":false}', null,
      '{"amount":true}', '{"amount":0.5}', '{"amount":[]}', '{"amount":{}}'];
    const r = relational(db), type = sql.call('json_type', [sql.column('raw'), '$.amount']);
    for (let i = 0; i < raw.length; i++) r.execute({ op: 'insert', table: 'documents', values: { id: i, raw: raw[i] } });
    const query = { from: 'documents', columns: { id: sql.column('id'), raw: sql.column('raw'), type,
      supplied: sql.case([{ when: sql.binary('IS NOT', type, null), then: 1 }], 0),
      whole: sql.call('json_type', [sql.column('raw')]) }, orderBy: [{ by: sql.column('id') }] };
    const expected = db.prepare("SELECT id,raw,json_type(raw,'$.amount') AS type,CASE WHEN json_type(raw,'$.amount') IS NOT NULL THEN 1 ELSE 0 END AS supplied,json_type(raw) AS whole FROM documents ORDER BY id").all([]);
    assert.deepEqual(r.all(query), expected);
    assert.deepEqual([...r.iterate(query)], expected);
    assert.deepEqual(expected.map((row) => row.type), [null, 'null', 'integer', 'text', 'false', null, 'true', 'real', 'array', 'object']);
    assert.deepEqual(expected.map((row) => row.supplied), [0, 1, 1, 1, 1, 0, 1, 1, 1, 1]);
    assert.deepEqual(expected.map((row) => row.raw), raw);
    for (const invalid of ['{', 'plain text']) {
      const malformed = { columns: { type: sql.call('json_type', [invalid]) } };
      assert.throws(() => r.get(malformed), /malformed JSON/i);
      assert.throws(() => [...r.iterate(malformed)], /malformed JSON/i);
    }
    for (const args of [[], ['{}', '$', '$']]) assert.throws(() => r.plan({ columns: { type: sql.call('json_type', args) } }), { code: 'JD0038' });
    assert.deepEqual(r.all({ from: 'documents', columns: { raw: sql.column('raw') }, orderBy: [{ by: sql.column('id') }] }).map((row) => row.raw), raw);
  }
  finally { db.close(); }
});
