//@ts-check
/** Recover only a complete scalar enum CHECK; unfamiliar SQL remains a loss. */

/** Tokenize catalog SQL without treating quoted text or comments as syntax.
 * @param {string} sql @returns {{ kind: string, value: string }[]} */
function tokensOf(sql) {
  const tokens = [];
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2); i = end < 0 ? sql.length : end + 1; continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return [];
      i = end + 2; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let value = '';
      let closed = false;
      for (i++; i < sql.length; i++) {
        if (sql[i] !== c) { value += sql[i]; continue; }
        if (sql[i + 1] === c) { value += c; i++; continue; }
        i++; closed = true; break;
      }
      if (!closed) return [];
      tokens.push({ kind: c === "'" ? 'string' : 'identifier', value });
      continue;
    }
    const number = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(sql.slice(i));
    if (number) { tokens.push({ kind: 'number', value: number[0] }); i += number[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(sql.slice(i));
    if (word) { tokens.push({ kind: 'word', value: word[0] }); i += word[0].length; continue; }
    const value = sql.startsWith('::', i) ? '::' : c;
    tokens.push({ kind: 'symbol', value }); i += value.length;
  }
  return tokens;
}

/** @param {any[]} tokens @returns {{ column: string, values: any[] } | null} */
function enumOf(tokens) {
  let at = 0;
  const take = (value) => {
    const token = tokens[at];
    if (token && token.kind !== 'string' && token.kind !== 'identifier'
      && token.value.toUpperCase() === value) { at++; return true; }
    return false;
  };
  const scalar = () => {
    if (take('(')) {
      const value = scalar();
      return value === undefined || !take(')') ? undefined : cast(value);
    }
    const negative = take('-');
    const token = tokens[at++];
    if (!token) return undefined;
    let value;
    if (token.kind === 'number') value = Number(`${negative ? '-' : ''}${token.value}`);
    else if (negative) return undefined;
    else if (token.kind === 'string') value = token.value;
    else if (token.kind === 'word' && /^(true|false)$/i.test(token.value)) value = token.value.toLowerCase() === 'true';
    else return undefined;
    if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
    return cast(value);
  };
  const cast = (value) => {
    if (!take('::')) return value;
    // Only exact scalar casts emitted by the catalog are understood.
    // Rounding casts could change the enum's members.
    const type = tokens[at++];
    if (type?.kind !== 'word') return undefined;
    const name = type.value.toLowerCase();
    if (typeof value === 'string' && name === 'text') return value;
    if (typeof value === 'boolean' && name === 'boolean') return value;
    // PostgreSQL renders negative constants as quoted numeric casts,
    // e.g. ('-1'::integer)::numeric. Decode only finite numeric syntax.
    if (typeof value === 'string' && ['numeric', 'integer', 'bigint', 'smallint'].includes(name)
      && /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value)) {
      const number = Number(value);
      if (!Number.isFinite(number) || (['integer', 'bigint', 'smallint'].includes(name)
        && !Number.isSafeInteger(number))) return undefined;
      return number;
    }
    if (typeof value === 'number' && name === 'numeric') return value;
    if (typeof value === 'number' && ['integer', 'bigint', 'smallint'].includes(name)
      && Number.isSafeInteger(value)) return value;
    if (typeof value === 'number' && name === 'double' && take('PRECISION')) return value;
    return undefined;
  };
  const expression = () => {
    if (take('(')) {
      const result = expression();
      return result === null || !take(')') ? null : result;
    }
    const column = tokens[at++];
    if (!column || !['identifier', 'word'].includes(column.kind)) return null;
    const any = take('=');
    // A singleton IN list is normalized to scalar equality by PostgreSQL.
    if (any && !take('ANY')) {
      const value = scalar();
      return value === undefined ? null : { column: column.value, values: [value] };
    }
    if (any ? !(take('(') && take('ARRAY') && take('[')) : !(take('IN') && take('('))) return null;
    const values = [];
    do {
      const value = scalar();
      if (value === undefined) return null;
      if (!values.includes(value)) values.push(value);
    } while (take(','));
    if (any ? !(take(']') && take(')')) : !take(')')) return null;
    return { column: column.value, values };
  };
  const result = expression();
  return at === tokens.length ? result : null;
}

/** SQLite retains the CREATE text, including inline and table CHECKs.
 * @param {any[]} rows @returns {any[]} neutral constraints */
export function sqliteChecks(rows) {
  const checks = [];
  for (const row of rows) {
    const tokens = tokensOf(String(row.sql ?? ''));
    // A column's inherited collation changes IN equality even when the
    // CHECK itself names no collation. Refuse conservatively per table.
    const collated = tokens.some((token, i) => token.kind === 'word'
      && token.value.toUpperCase() === 'COLLATE'
      && tokens[i + 1]?.value.toUpperCase() !== 'BINARY');
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].kind !== 'word' || tokens[i].value.toUpperCase() !== 'CHECK'
        || tokens[i + 1]?.value !== '(') continue;
      const start = i + 2;
      let depth = 1;
      for (i = start; i < tokens.length; i++) {
        if (tokens[i].kind !== 'symbol') continue;
        if (tokens[i].value === '(') depth++;
        if (tokens[i].value === ')' && --depth === 0) break;
      }
      checks.push({ name: `check_${checks.length + 1}`,
        ...(collated ? null : enumOf(tokens.slice(start, i))) });
    }
  }
  return checks;
}

/** PostgreSQL exposes each CHECK expression separately.
 * @param {any[]} rows @returns {any[]} neutral constraints */
export function postgresChecks(rows) {
  return rows.map((row) => ({ name: String(row.name),
    ...(row.unsafe_collation ? null : enumOf(tokensOf(String(row.expression ?? '')))) }));
}
