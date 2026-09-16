//@ts-check
/** Native column strategies. Exact values cross the client as text, independent
 * of its numeric, JSON, byte and timestamp parsers. */
import { DbCompileError } from '../errors.js';

/** A native type must preserve the declared JSON codec, including precision.
 * @param {string} codec @param {string} type @returns {boolean} */
export function postgresPhysicalTypeMatches(codec, type) {
  const text = /^(TEXT|CHARACTER VARYING(?:\(\d+\))?)$/;
  if (codec === 'text' || codec === 'datetime') return text.test(type);
  if (codec === 'uuid') return type === 'UUID';
  if (codec === 'integer' || codec === 'bigint' || codec === 'epoch-ms') return /^(SMALLINT|INTEGER|BIGINT)$/.test(type);
  if (codec === 'number') return type === 'DOUBLE PRECISION';
  if (codec === 'boolean') return type === 'BOOLEAN';
  if (codec === 'json') return /^(JSON|JSONB)$/.test(type);
  if (codec === 'blob-hex') return type === 'BYTEA';
  if (codec === 'date') return type === 'DATE';
  if (codec === 'local-timestamp') return /^TIMESTAMP(?:\([0-6]\))? WITHOUT TIME ZONE$/.test(type);
  if (codec === 'instant') return /^TIMESTAMP(?:\([0-6]\))? WITH TIME ZONE$/.test(type);
  if (codec === 'decimal') {
    const numeric = /^NUMERIC(?:\((\d+),(\d+)\))?$/.exec(type);
    return numeric !== null && (numeric[1] === undefined || Number(numeric[2]) <= Number(numeric[1]));
  }
  return false;
}

/** Project exact values without a global parser override or session timezone.
 * @param {string} codec @param {string} sql @returns {string} */
export function postgresPhysicalRead(codec, sql) {
  if (['bigint', 'decimal', 'uuid', 'json'].includes(codec)) return `(${sql})::text`;
  if (codec === 'blob-hex') return `pg_catalog.encode(${sql}, 'hex')`;
  if (codec === 'boolean') return `CASE WHEN ${sql} IS NULL THEN NULL WHEN ${sql} THEN 1 ELSE 0 END`;
  if (['date', 'local-timestamp', 'instant'].includes(codec)) {
    const instant = codec === 'instant';
    const type = codec === 'date' ? 'DATE' : instant ? 'TIMESTAMPTZ' : 'TIMESTAMP';
    const offset = instant ? '+00' : '';
    const format = codec === 'date' ? 'YYYY-MM-DD' : `YYYY-MM-DD"T"HH24:MI:SS.US${instant ? '"Z"' : ''}`;
    return `CASE WHEN ${sql} IS NULL THEN NULL WHEN ${sql} >= ${type} '0001-01-01${offset}' `
      + `AND ${sql} < ${type} '10000-01-01${offset}' THEN pg_catalog.to_char(${sql}${instant ? " AT TIME ZONE 'UTC'" : ''}, '${format}') `
      + `ELSE 'unsupported native temporal value' END`;
  }
  return sql;
}

/** JSON-facing comparable scalars retain shared boolean and codepoint meaning.
 * @param {string} codec @param {string} sql @returns {string} */
export function postgresPhysicalCompare(codec, sql) {
  if (codec === 'boolean') return postgresPhysicalRead(codec, sql);
  if (['text', 'datetime', 'uuid'].includes(codec)) return `((${sql})::text COLLATE "C")`;
  return sql;
}

/** Typed native columns need no SQLite typeof() or cast from a scalar to JSONB.
 * @param {string} codec @param {string} sql @returns {string} */
export function postgresPhysicalValueType(codec, sql) {
  const kind = codec === 'text' ? 'text' : codec === 'number' ? 'real' : 'integer';
  return `CASE WHEN ${sql} IS NULL THEN NULL ELSE '${kind}' END`;
}

/** Equality for one encoded physical assignment; exact decimal scale remains
 * a text fact, whereas booleans/bytes/JSON use their declared native values.
 * @param {string} codec @param {string} left @param {string} right @returns {string} */
export function postgresPhysicalDifferent(codec, left, right) {
  const type = { boolean: 'boolean', 'blob-hex': 'bytea', json: 'jsonb', integer: 'bigint',
    bigint: 'bigint', 'epoch-ms': 'bigint', number: 'double precision', date: 'date',
    'local-timestamp': 'timestamp', instant: 'timestamptz' }[codec] ?? 'text';
  const cast = (value) => type === 'text' ? `((${value})::text COLLATE "C")` : `((${value})::${type})`;
  return `${cast(left)} IS DISTINCT FROM ${cast(right)}`;
}

/** Attach only verified native storage restrictions to the compiled mapping.
 * @param {any} column @param {any} actual @param {string} kind */
export function qualifyPostgresPhysicalColumn(column, actual, kind) {
  const fail = (reason) => { throw new DbCompileError('JD0002', `physical column '${column.physical}': ${reason}`); };
  const type = actual.type.toUpperCase();
  if (column.declaredType !== undefined && column.declaredType.toUpperCase() !== type)
    fail('declared native type disagrees with the catalog');
  if (actual.native?.typeKind !== undefined && actual.native.typeKind !== 'b')
    fail('domains, enums and composite types need an explicit codec');
  if (kind !== 'view' && column.databaseDefault && actual.default == null && !actual.native?.identity)
    fail('database default ownership requires a catalog default or identity');
  if (column.identity !== undefined && column.identity !== actual.native?.identity)
    fail('declared identity ownership disagrees with the catalog');
  if (column.codec === 'decimal') {
    column.nativeNumeric = true;
    const scale = /^NUMERIC\(\d+,(\d+)\)$/.exec(type);
    if (scale) column.scale = Number(scale[1]);
  }
  if (column.codec === 'local-timestamp' || column.codec === 'instant')
    column.fractionDigits = Number(/^TIMESTAMP\(([0-6])\)/.exec(type)?.[1] ?? 6);
  // Native typed projections and predicates are independently qualified. The
  // decoded evaluator remains exact for every codec and reports its residual.
  column.nativeQuery = ['text', 'integer', 'number', 'boolean'].includes(column.codec) && column.null !== 'null';
}
