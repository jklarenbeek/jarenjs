//@ts-check
/** SQLite vocabulary for the shared structural SQL compiler. */
export const sqliteRelationalVocabulary = Object.freeze({
  functions: new Set(['coalesce', 'nullif', 'trim', 'ltrim', 'rtrim', 'lower', 'upper', 'length', 'abs', 'round',
    'typeof', 'json_extract', 'json_valid', 'json_type', 'count', 'sum', 'total', 'avg', 'min', 'max',
    'date', 'time', 'datetime', 'julianday', 'unixepoch', 'strftime']),
  types: new Set(['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC']),
  collations: new Set(['BINARY', 'NOCASE', 'RTRIM']),
});
