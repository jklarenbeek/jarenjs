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
// the Store-bound engines: promises at the root and on a transaction view,
// values on the synchronous twins; the Store owns their lifetime
async function storeBound(store: import('@jarenjs/db').Store) {
  const rows: { id: number }[] = await store.relational.all<{ id: number }>(query);
  const result = await store.relational.execute({ op: 'insert', table: 'images', values: { data: null } });
  const rowid: number | bigint | undefined = result.lastInsertRowid;
  for await (const row of store.relational.iterate<{ id: number }>(query)) { const id: number = row.id; void id; }
  const inside: number = await store.transaction(async (tx) => (await tx.relational.execute({ op: 'delete', table: 'images', where: true })).affected);
  const syncRows: { id: number }[] | undefined = store.sync?.relational.all<{ id: number }>(query);
  // @ts-expect-error the Store owns the engine's lifetime: there is no dispose
  store.relational.dispose();
  return [rows, rowid, inside, syncRows];
}
// @ts-expect-error SQL parameter objects need an explicit structural expression
sql.value({ unexpected: true });
// @ts-expect-error physical types are a closed native vocabulary
sql.cast(sql.column('id'), 'TEXT; DROP TABLE images');
// @ts-expect-error updates need an explicit predicate
const refused: Parameters<ReturnType<typeof relational>['execute']>[0] = { op: 'update', table: 'images', set: { data: null } };
// @ts-expect-error absence suppression belongs to drop operations
planSchemaChange({}, { op: 'renameTable', table: 'images', to: 'archive', ifExists: true });
void [example, storeBound, refused, planTable, compileEntityModel, readSchema, createEntityQueryEngine, createQueryState, entityCore, collectEntityRoots];
