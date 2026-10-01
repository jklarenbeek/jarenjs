//@ts-check
/** PostgreSQL lowering of database rules: per table and operation, one
 * PL/pgSQL trigger function and the row trigger that calls it. The server
 * keeps a function's source verbatim but deparses a trigger, so an installed
 * program is verified field by field through the catalog, not by its text.
 * Every function runs with a fixed search path, so no schema a writer puts
 * ahead of `pg_catalog` can supply its operators, casts or collations. */
import { hashContent, utf8ByteLength } from '@jarenjs/core/string';
import { DbCompileError, INVARIANT_MARKER, INVARIANT_SQLSTATE } from '../errors.js';
import { compileInvariants } from './invariant-sql.js';

const SAFE_RANGE = 'BETWEEN -9007199254740991 AND 9007199254740991';
/** The search path every rule function runs under, as the catalog keeps it. */
const SEARCH_PATH = 'pg_catalog, pg_temp';

/** Every PostgreSQL column is typed, so an operand's domain is what its codec
 * reads back: a safe integer, a finite number inside that range, a date of
 * years 1–9999. Text compares by code point, as SQLite's BINARY does. */
const POSTGRES = {
  true: 'TRUE',
  false: 'FALSE',
  equal: 'IS NOT DISTINCT FROM',
  different: 'IS DISTINCT FROM',
  /** @param {any} column @param {string} ref */
  column(column, ref) {
    const checks = ['integer', 'number'].includes(column.codec) ? [`${ref} ${SAFE_RANGE}`]
      : column.codec === 'date' ? [`${ref} >= DATE '0001-01-01'`, `${ref} < DATE '10000-01-01'`] : [];
    const domain = column.null === 'null'
      ? checks.length === 0 ? null : `(${ref} IS NULL OR (${checks.join(' AND ')}))`
      : `(${[`${ref} IS NOT NULL`, ...checks].join(' AND ')})`;
    const value = column.codec === 'date' ? `(pg_catalog.to_char(${ref}, 'YYYY-MM-DD') COLLATE "C")`
      : ['text', 'datetime'].includes(column.codec) ? `(${ref} COLLATE "C")` : ref;
    return { value, domain };
  },
  /** One notion of a changed column: the dialect's own physical difference.
   * @param {any} column @param {(name: string) => string} q @param {any} dialect */
  changed: (column, q, dialect) => dialect.physicalDifferent(column.codec, `OLD.${q(column.physical)}`, `NEW.${q(column.physical)}`),
  /** The function runs under its caller's search path, so it names its tables.
   * @param {string} table @param {(name: string) => string} q @param {any} dialect */
  table: (table, q, dialect) => `${q(dialect.schema)}.${q(table)}`,
  /** An integer column would round a number assigned to it.
   * @param {any} column @param {any} expression @param {(path: string) => any} columnOf @param {(why: string) => never} fail */
  auditValue(column, expression, columnOf, fail) {
    if (column.codec !== 'integer') return;
    let literal = expression;
    while (literal && typeof literal === 'object' && Object.hasOwn(literal, '$const')) literal = literal.$const;
    const source = typeof expression === 'string' && expression.startsWith('$.') ? columnOf(expression) : undefined;
    if (source?.codec === 'number' || (typeof literal === 'number' && !Number.isInteger(literal)))
      fail(`audit member '${column.name}' is an integer column, which would round a number`);
  },
};

/** A program's name: the SQLite trigger's, or a hash of the table when that
 * would pass PostgreSQL's identifier limit (a hash has no underscore, a full
 * name always does, so the two forms never meet).
 * @param {string} table @param {string} suffix @param {number} limit */
function programName(table, suffix, limit) {
  const full = `_jaren_rule_${table.length}_${table}_${suffix}`;
  return utf8ByteLength(full) <= limit ? full : `_jaren_rule_${hashContent(table)}_${suffix}`;
}

/** A function and the trigger that calls it, as two plan items (a migration
 * step is one statement), the trigger carrying what its open verifies.
 * @param {any} dialect @param {string} table @param {string} name @param {string} rule
 * @param {{ timing: 'BEFORE' | 'AFTER', event: string, columns: string[], level?: 'ROW' | 'STATEMENT' }} on
 * @param {string} source */
function triggerFunction(dialect, table, name, rule, on, source) {
  const q = dialect.quoteIdentifier;
  const level = on.level ?? 'ROW';
  let tag = '$jaren$';
  for (let i = 1; source.includes(tag); i++) tag = `$jaren_${i}$`;
  const fn = `${q(dialect.schema)}.${q(name)}`;
  const event = `${on.event}${on.columns.length ? ` OF ${on.columns.map(q).join(', ')}` : ''}`;
  return [{ type: 'function', name, owner: table, rule,
    sql: `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql SET search_path = ${SEARCH_PATH} AS ${tag}${source}${tag}` },
  { type: 'trigger', name, owner: table, rule,
    sql: `CREATE TRIGGER ${q(name)} ${on.timing} ${event} ON ${q(dialect.schema)}.${q(table)} FOR EACH ${level} EXECUTE FUNCTION ${fn}()`,
    program: { timing: on.timing, events: [on.event], level, columns: on.columns, condition: false, enabled: 'O',
      deferrable: false, deferred: false, function: { schema: dialect.schema, name, language: 'plpgsql',
        returns: 'trigger', arguments: '', securityDefiner: false, config: [`search_path=${SEARCH_PATH}`], source } } }];
}

/** @param {any} mapping @param {any} all @param {any} dialect @param {number} limit @returns {any[]} */
export function postgresInvariantTriggers(mapping, all, dialect, limit) {
  if (dialect.schema === undefined && (mapping.invariants ?? []).some((rule) => rule.enforcement === 'database'))
    throw new DbCompileError('JD0005', 'database invariant: PostgreSQL rules install in the driver-owned schema; name it with searchPath');
  const q = dialect.quoteIdentifier;
  const sl = dialect.stringLiteral;
  const programs = compileInvariants(mapping, all, dialect, POSTGRES);
  // TRUNCATE removes rows without a row trigger: on a table whose deletes a
  // rule judges, a statement program refuses it in the delete rule's name
  const deletes = programs.find((program) => program.op === 'delete');
  const truncate = deletes === undefined ? [] : triggerFunction(dialect, mapping.table,
    programName(mapping.table, 'truncate', limit), deletes.rules.join(','), { timing: 'BEFORE', event: 'TRUNCATE', columns: [], level: 'STATEMENT' },
    ['', 'BEGIN',
      `  RAISE EXCEPTION USING MESSAGE = ${sl(`${INVARIANT_MARKER}${deletes.rules[0]}`)}, ERRCODE = ${sl(INVARIANT_SQLSTATE)};`,
      '  RETURN NULL;', 'END;', ''].join('\n'));
  // an increment rewrites the row before it is written, so every AFTER
  // program of the statement reads the revision it will keep
  return [...programs.flatMap((program) => {
    const name = programName(mapping.table, program.name, limit);
    const event = program.op.toUpperCase();
    const rule = program.rules.join(',');
    const source = ['', 'BEGIN',
      ...program.checks.map((check) => `  IF ${check.when} THEN\n`
        + `    RAISE EXCEPTION USING MESSAGE = ${sl(`${INVARIANT_MARKER}${check.rule}`)}, ERRCODE = ${sl(INVARIANT_SQLSTATE)};\n  END IF;`),
      ...program.audits.map((audit) => `  INSERT INTO ${audit.table} (${audit.names.join(', ')}) SELECT ${audit.values.join(', ')}${audit.when ? ` WHERE ${audit.when}` : ''};`),
      '  RETURN NULL;', 'END;', ''].join('\n');
    const after = triggerFunction(dialect, mapping.table, name, rule, { timing: 'AFTER', event, columns: program.columns }, source);
    if (program.increments.length === 0) return after;
    const before = ['', 'BEGIN',
      ...program.increments.map((increment) => {
        const column = q(increment.column);
        return `  IF ${increment.when ? `${increment.when} AND ` : ''}(NEW.${column} IS NOT DISTINCT FROM OLD.${column}) THEN\n`
          + `    NEW.${column} := OLD.${column} + 1;\n  END IF;`;
      }),
      '  RETURN NEW;', 'END;', ''].join('\n');
    const increments = [...new Set(program.increments.map((increment) => increment.rule))].join(',');
    return [...triggerFunction(dialect, mapping.table, programName(mapping.table, `${program.name}_before`, limit), increments,
      { timing: 'BEFORE', event, columns: [] }, before), ...after];
  }), ...truncate];
}
