//@ts-check
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { relational, sql, planTable, planSchemaChange, applySchemaChange, withForeignKeysSuspended } from '@jarenjs/db/relational';
const c = sql.column, b = sql.binary;
export const target = { name: 'preferences', primaryKey: ['entity_id', 'source_id'], columns: [
  { name: 'entity_id', type: 'INTEGER', nullable: false },
  { name: 'source_id', type: 'INTEGER', nullable: false },
  { name: 'value', type: 'TEXT', nullable: false },
], constraints: [{ kind: 'foreignKey', columns: ['entity_id'], table: 'owners', references: ['id'] }] };

/** Synthetic, caller-owned policy: scope/product isolation and deterministic identity. */
export function upgradeIdentity(db) {
  return withForeignKeysSuspended(db, () => {
    const info = db.prepare('PRAGMA main.table_info(preferences)').all([]);
    const key = info.filter((column) => column.pk).sort((a, z) => a.pk - z.pk).map((column) => column.name);
    if (key.join(',') === 'entity_id,source_id') return { changed: 0, retained: 0, excluded: 0 };
    assert.deepEqual(key, ['entity_id', 'area', 'slot'], 'only the explicitly reviewed legacy shape is admitted');
    const r = relational(db);
    const count = r.get({ from: 'preferences', columns: { n: sql.call('count', []) } }).n;
    const matching = { from: { table: 'candidates', as: 'c' },
      columns: { id: sql.call('min', [c('id', 'c')]) },
      where: b('AND', b('AND', b('=', c('scope', 'c'), c('scope', 'o')), b('=', c('product', 'c'), c('product', 'o'))),
        b('AND', b('=', c('area', 'c'), c('area', 'p')), b('=', c('slot', 'c'), c('slot', 'p')))) };
    const source = { from: { table: 'preferences', as: 'p' },
      joins: [{ source: { table: 'owners', as: 'o' }, type: 'inner', on: b('=', c('id', 'o'), c('entity_id', 'p')) }],
      columns: { entity_id: c('entity_id', 'p'), source_id: sql.scalar(matching), value: c('value', 'p') },
      where: b('IS NOT', sql.scalar(matching), null) };
    const expected = r.get({ from: { query: source, as: 'resolved' }, columns: { n: sql.call('count', []) } }).n;
    const temporary = 'preferences_next';
    for (const text of planTable({ ...target, name: temporary }).createSql) db.exec(text);
    const result = r.execute({ op: 'insert', table: temporary, columns: ['entity_id', 'source_id', 'value'], source });
    assert.equal(result.affected, expected, 'every explicitly selected row must survive; conflicts must roll back');
    applySchemaChange(db, planSchemaChange(db, { op: 'dropTable', table: 'preferences' }));
    applySchemaChange(db, planSchemaChange(db, { op: 'renameTable', table: temporary, to: 'preferences' }));
    return { changed: 1, retained: expected, excluded: count - expected };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = process.versions.bun ? await import('@jarenjs/db/bun') : await import('@jarenjs/db/node');
  const driver = process.versions.bun ? runtime.bunDriver() : runtime.nodeDriver();
  const db = await driver.open(process.argv[2]);
  db.exec('PRAGMA foreign_keys=ON');
  const connection = { ...db, exec(statement) {
    const result = db.exec(statement);
    if (statement === 'DROP TABLE "main"."preferences"') process.kill(process.pid, 'SIGKILL');
    return result;
  } };
  upgradeIdentity(connection);
  throw new Error('the actual DROP crash boundary was not reached');
}
