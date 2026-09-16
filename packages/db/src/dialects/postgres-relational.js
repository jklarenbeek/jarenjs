//@ts-check
/** Native PostgreSQL vocabulary for the shared structural SQL compiler. */
export const postgresRelational = Object.freeze({
  booleans: true,
  refusedOperators: Object.freeze(['GLOB']),
  operators: Object.freeze({ IS: 'IS NOT DISTINCT FROM', 'IS NOT': 'IS DISTINCT FROM' }),
  distinct: 'IS DISTINCT FROM',
  functions: new Set(['coalesce', 'nullif', 'trim', 'ltrim', 'rtrim', 'lower', 'upper', 'length',
    'abs', 'round', 'count', 'sum', 'avg', 'min', 'max', 'jsonb_typeof', 'json_typeof', 'octet_length']),
  types: new Set(['SMALLINT', 'INTEGER', 'BIGINT', 'REAL', 'DOUBLE PRECISION', 'TEXT', 'BYTEA', 'NUMERIC',
    'BOOLEAN', 'UUID', 'JSON', 'JSONB', 'DATE', 'TIMESTAMP', 'TIMESTAMPTZ']),
  collations: new Set(['C', 'POSIX']),
  // COALESCE, NULLIF and TRIM are parser expressions, not catalog functions.
  functionName: (name) => ['coalesce', 'nullif', 'trim'].includes(name)
    ? name.toUpperCase() : `pg_catalog.${name}`,
});
