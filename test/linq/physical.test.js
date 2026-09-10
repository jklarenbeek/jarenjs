//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '@jarenjs/linq/model';
import { open } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { planInvariants, sqliteDialect } from '@jarenjs/db';

it('the pen emits physical layouts and invariants and transaction clients keep the guarded SQL scope', async () => {
  const model = m.defineModel({ entities: { Setting: m.object({ id: m.string().key(), value: m.string() })
    .physical({ table: 'settings', columns: {
      id: { name: 'key', codec: 'text', null: 'reject' }, value: { name: 'value', codec: 'text', null: 'reject' },
    } }).invariants([{ name: 'nonempty', on: ['insert', 'update'], enforcement: 'database', assert: { $ne: ['$.new.value', ''] } }]),
  } });
  const db = await nodeDriver().open(':memory:');
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)');
  for (const statement of planInvariants(model, { dialect: sqliteDialect })) db.exec(statement.sql);
  const client = await open(model, { driver: { ...nodeDriver(), open: async () => db }, adopt: true });
  let statement;
  try {
    await client.transaction(async (tx) => {
      statement = tx.sql.prepare('INSERT INTO settings VALUES(?,?)', { access: 'write' });
      statement.run(['locale', 'nl-NL']);
      assert.equal((await tx.entities.Setting.get('locale')).value, 'nl-NL');
      assert.equal(tx.sync.sql.prepare('SELECT value FROM settings', { access: 'read' }).get([]).value, 'nl-NL');
      await assert.rejects(tx.entities.Setting.create({ id: 'invalid', value: '' }), { code: 'JD2096' });
    });
    assert.throws(() => statement.run(['after', 'closed']), { code: 'JD2070' });
  }
  finally { await client.close(); }
});
