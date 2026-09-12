/** Structural SQLite authoring, with explicit native SQL semantics. */
export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlInput = SqlValue | SqlExpression;
export type SqlOperator = '=' | '<>' | '<' | '<=' | '>' | '>=' | 'IS' | 'IS NOT'
  | '+' | '-' | '*' | '/' | '%' | '||' | 'AND' | 'OR' | 'LIKE' | 'NOT LIKE' | 'GLOB';
export type SqlFunction = 'coalesce' | 'nullif' | 'trim' | 'ltrim' | 'rtrim' | 'lower' | 'upper'
  | 'length' | 'abs' | 'round' | 'typeof' | 'json_extract' | 'json_valid'
  | 'count' | 'sum' | 'total' | 'avg' | 'min' | 'max'
  | 'date' | 'time' | 'datetime' | 'julianday' | 'unixepoch' | 'strftime';
export type SqlType = 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'NUMERIC';
export type SqlCollation = 'BINARY' | 'NOCASE' | 'RTRIM';
export type SqlExpression =
  | { readonly $sql: 'column'; readonly name: string; readonly table?: string }
  | { readonly $sql: 'value'; readonly value: SqlValue }
  | { readonly $sql: 'param'; readonly name: string }
  | { readonly $sql: 'binary'; readonly op: SqlOperator; readonly left: SqlInput; readonly right: SqlInput }
  | { readonly $sql: 'not'; readonly value: SqlInput }
  | { readonly $sql: 'in'; readonly value: SqlInput; readonly values: readonly SqlInput[] | SqlSelect; readonly negate?: boolean }
  | { readonly $sql: 'call'; readonly name: SqlFunction; readonly args: readonly SqlInput[]; readonly distinct?: boolean }
  | { readonly $sql: 'cast'; readonly value: SqlInput; readonly type: SqlType }
  | { readonly $sql: 'collate'; readonly value: SqlInput; readonly collation: SqlCollation }
  | { readonly $sql: 'case'; readonly branches: readonly { when: SqlInput; then: SqlInput }[]; readonly otherwise?: SqlInput }
  | { readonly $sql: 'scalar' | 'exists'; readonly query: SqlSelect };
export interface SqlOrder { readonly by: SqlInput; readonly direction?: 'asc' | 'desc'; readonly nulls?: 'first' | 'last' }
export type SqlProjection = '*' | Readonly<Record<string, SqlInput>>;
export type SqlSource = string | { readonly table: string; readonly as?: string } | { readonly query: SqlSelect; readonly as?: string };
export interface SqlSelect {
  readonly from?: SqlSource;
  readonly columns?: SqlProjection;
  readonly joins?: readonly { source: SqlSource; type?: 'inner' | 'left' | 'cross'; on?: SqlInput }[];
  readonly where?: SqlInput;
  readonly groupBy?: readonly SqlInput[];
  readonly having?: SqlInput;
  readonly orderBy?: readonly SqlOrder[];
  readonly distinct?: boolean;
  readonly limit?: number;
  readonly offset?: number;
  readonly union?: readonly SqlSelect[];
  readonly all?: boolean;
}
export type SqlConflict = { readonly target?: readonly (string | SqlExpression)[]; readonly where?: SqlInput } & (
  { readonly action: 'nothing' } | { readonly action: 'update'; readonly set: Readonly<Record<string, SqlInput>>; readonly updateWhere?: SqlInput });
export type SqlMutation = { readonly table: string; readonly returning?: SqlProjection } & (
  | { readonly op: 'update'; readonly set: Readonly<Record<string, SqlInput>>; readonly where: SqlInput; readonly reporting?: 'matched' | 'changed' }
  | { readonly op: 'delete'; readonly where: SqlInput }
  | ({ readonly op: 'insert'; readonly conflict?: SqlConflict; readonly ignore?: boolean } & (
    { readonly values: Readonly<Record<string, SqlInput>> } | { readonly source: SqlSelect; readonly columns: readonly string[] })));
export interface RelationalOptions { readonly externals?: Readonly<Record<string, SqlValue>> }
export interface RelationalPlan { readonly sql: string; readonly params: readonly SqlValue[]; readonly access: 'read' | 'write' }
export interface RelationalMutationResult { readonly affected: number; readonly rows?: readonly Record<string, unknown>[]; readonly lastInsertRowid?: number | bigint }
export interface RelationalEngine {
  plan(document: SqlSelect | SqlMutation, options?: RelationalOptions): RelationalPlan;
  all<T = Record<string, unknown>>(document: SqlSelect, options?: RelationalOptions): T[];
  get<T = Record<string, unknown>>(document: SqlSelect, options?: RelationalOptions): T | undefined;
  iterate<T = Record<string, unknown>>(document: SqlSelect, options?: RelationalOptions): IterableIterator<T>;
  execute(document: SqlMutation, options?: RelationalOptions): RelationalMutationResult;
}
export declare const sql: {
  column(name: string, table?: string): SqlExpression;
  value(value: SqlValue): SqlExpression;
  param(name: string): SqlExpression;
  binary(op: SqlOperator, left: SqlInput, right: SqlInput): SqlExpression;
  not(value: SqlInput): SqlExpression;
  in(value: SqlInput, values: readonly SqlInput[] | SqlSelect, negate?: boolean): SqlExpression;
  call(name: SqlFunction, args: readonly SqlInput[], options?: { distinct?: boolean }): SqlExpression;
  cast(value: SqlInput, type: SqlType): SqlExpression;
  collate(value: SqlInput, collation: SqlCollation): SqlExpression;
  case(branches: readonly { when: SqlInput; then: SqlInput }[], otherwise?: SqlInput): SqlExpression;
  scalar(query: SqlSelect): SqlExpression;
  exists(query: SqlSelect): SqlExpression;
};
export declare function planRelational(document: SqlSelect | SqlMutation, options?: RelationalOptions): RelationalPlan;
/** Requires a synchronous SQLite connection; no model is opened. */
export declare function relational(connection: unknown): RelationalEngine;

export interface TableColumn {
  readonly name: string; readonly type: SqlType | 'ANY'; readonly nullable?: boolean;
  readonly default?: SqlInput; readonly collation?: SqlCollation;
  readonly identity?: 'rowid' | 'autoincrement'; readonly check?: SqlInput;
  readonly generated?: SqlInput; readonly stored?: boolean;
}
export type ForeignKeyAction = 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default';
export type TableConstraint = { readonly name?: string } & (
  { readonly kind: 'unique'; readonly columns: readonly string[] }
  | { readonly kind: 'check'; readonly expression: SqlInput }
  | { readonly kind: 'foreignKey'; readonly columns: readonly string[]; readonly table: string; readonly references: readonly string[];
      readonly onDelete?: ForeignKeyAction; readonly onUpdate?: ForeignKeyAction; readonly deferred?: boolean });
export interface TableIndex { readonly name: string; readonly terms: readonly Omit<SqlOrder, 'nulls'>[]; readonly unique?: boolean; readonly where?: SqlInput }
export type TriggerRaise = { readonly raise: { readonly action: 'abort' | 'fail' | 'rollback'; readonly message: string } | { readonly action: 'ignore' } };
export interface TableTrigger {
  readonly name: string; readonly timing: 'before' | 'after'; readonly event: 'insert' | 'update' | 'delete';
  readonly of?: readonly string[]; readonly when?: SqlInput; readonly steps: readonly (SqlMutation | TriggerRaise)[];
}
export interface TableDefinition {
  readonly name: string; readonly columns: readonly TableColumn[]; readonly primaryKey?: readonly string[];
  readonly constraints?: readonly TableConstraint[]; readonly indexes?: readonly TableIndex[]; readonly triggers?: readonly TableTrigger[];
  readonly strict?: boolean; readonly withoutRowid?: boolean;
}
export interface TablePlan { readonly table: string; readonly createSql: readonly string[]; readonly expected: unknown }
export declare function defineTable(definition: TableDefinition): TableDefinition;
export declare function planTable(definition: TableDefinition): TablePlan;
export interface TableMigrationOptions {
  readonly id: string; readonly allowRebuild?: boolean; readonly copy?: Readonly<Record<string, SqlInput>>;
  readonly dropColumns?: readonly string[]; readonly dropObjects?: readonly string[];
}
export interface TableMigrationPlan {
  readonly version: 1; readonly id: string; readonly table: string; readonly checksum: string;
  readonly source: readonly unknown[]; readonly after: readonly unknown[]; readonly rebuild: boolean;
  readonly temporary: string; readonly unchanged: readonly string[]; readonly statements: readonly string[]; readonly finish: readonly string[];
}
export declare function planTableMigration(connection: unknown, definition: TableDefinition, options: TableMigrationOptions): TableMigrationPlan;
export declare function applyTableMigration(connection: unknown, plan: TableMigrationPlan): { changed: number };
export declare function withForeignKeysSuspended<T>(connection: unknown, fn: () => T): T;
export { sqliteDialect } from './index.js';
