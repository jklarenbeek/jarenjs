//@ts-check
/** Lightweight column-first SQLite authoring and execution. */
export { sql, planRelational, relational } from './dialects/sqlite-relational.js';
export { defineTable, planTable } from './dialects/sqlite-schema.js';
export { planTableMigration, applyTableMigration, withForeignKeysSuspended, planSchemaChange, applySchemaChange } from './table-migration.js';
export { sqliteDialect } from './dialects/sqlite.js';
