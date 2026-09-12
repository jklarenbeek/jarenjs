import { relational, sql, defineTable, planTable, planTableMigration, applyTableMigration, withForeignKeysSuspended, planSchemaChange, applySchemaChange, type SqlSelect } from '@jarenjs/db/relational';
import { nodeDriver as relationalNodeDriver, snapshotDatabase } from '@jarenjs/db/node';
import { createEntityQueryEngine, createQueryState, collectEntityRoots } from '@jarenjs/db/query';
import { compileEntityModel, readSchema } from '@jarenjs/db/model';
import { entityCore } from '@jarenjs/db/entity';
const table = defineTable({ name: 'images', columns: [
  { name: 'id', type: 'INTEGER', identity: 'autoincrement' }, { name: 'data', type: 'BLOB' },
], primaryKey: ['id'], indexes: [{ name: 'has_data', terms: [{ by: sql.column('id') }], where: sql.binary('IS NOT', sql.column('data'), null) }] });
const query: SqlSelect = { from: 'images', columns: { id: sql.column('id'), data: sql.column('data') } };
async function example() {
  const db = await relationalNodeDriver().open(':memory:');
  const engine = relational(db);
  applyTableMigration(db, planTableMigration(db, table, { id: 'v1' }));
  applySchemaChange(db, planSchemaChange(db, { op: 'addColumn', table: 'images', column: { name: 'revision', type: 'INTEGER', nullable: false, default: 1, check: sql.binary('>=', sql.column('revision'), 1) } }));
  applySchemaChange(db, planSchemaChange(db, { op: 'addColumn', table: 'images', column: { name: 'parent', type: 'INTEGER', references: { table: 'images', columns: ['id'], onDelete: 'set null' } } }));
  applySchemaChange(db, planSchemaChange(db, { op: 'dropIndex', name: 'has_data', ifExists: true }));
  const jsonType: string | null = engine.get<{ type: string | null }>({ columns: { type: sql.call('json_type', ['{}', '$.amount']) } })!.type;
  void jsonType;
  const affected: number = engine.execute({ op: 'insert', table: 'images', values: { data: new Uint8Array([0, 255]) } }).affected;
  for (const row of engine.iterate<{ id: number; data: Uint8Array }>(query)) { const bytes: Uint8Array = row.data; void bytes; break; }
  const copy: { path: string; pages: number } = await snapshotDatabase(db, '/tmp/example.db');
  withForeignKeysSuspended(db, () => affected);
  return copy;
}
// @ts-expect-error boolean is not a native SQL parameter
sql.value(true);
// @ts-expect-error physical types are a closed SQLite vocabulary
sql.cast(sql.column('id'), 'BIGINT');
// @ts-expect-error updates need an explicit predicate
const refused: Parameters<ReturnType<typeof relational>['execute']>[0] = { op: 'update', table: 'images', set: { data: null } };
// @ts-expect-error absence suppression belongs to drop operations
planSchemaChange({}, { op: 'renameTable', table: 'images', to: 'archive', ifExists: true });
void [example, refused, planTable, compileEntityModel, readSchema, createEntityQueryEngine, createQueryState, entityCore, collectEntityRoots];
