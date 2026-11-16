/** A reader of an engine's application triggers back into the declared
 * database rules they are exactly equal to (MODEL-FORMAT §13.6): pass it as
 * introspection's `triggers` option. */
export interface TriggerRuleReader {
  read(dialect: unknown, schema: unknown, joinTables: ReadonlySet<string>): unknown;
}

/** The SQLite trigger reader: `store.introspect({ triggers: sqliteTriggers })`. */
export declare const sqliteTriggers: TriggerRuleReader;
