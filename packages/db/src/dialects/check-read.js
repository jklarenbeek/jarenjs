//@ts-check
/** Read catalog SQL back into the model's terms: a complete scalar enum CHECK,
 * and an index condition in the query grammar. Both walk one tokenizer and
 * one literal reader, and each engine injects its spelling; unfamiliar SQL
 * remains a loss, never a guess. */

/** Tokenize catalog SQL without treating quoted text or comments as syntax.
 * @param {string} sql @param {(sql:string,at:number)=>any} [nativeToken]
 * @returns {{ kind: string, value: string, at: number }[]} each token with the offset it starts at */
export function sqlTokens(sql, nativeToken) {
  const tokens = [];
  if (sql.includes('\0')) return [];
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2); i = end < 0 ? sql.length : end + 1; continue;
    }
    const native = nativeToken?.(sql, i);
    if (native === null) return [];
    if (native) {
      if (native.kind !== 'comment') tokens.push({ kind: native.kind, value: native.value, at: i });
      i = native.end; continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return [];
      i = end + 2; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quoted = quotedSqlToken(sql, i);
      if (!quoted) return [];
      tokens.push({ kind: quoted.kind, value: quoted.value, at: i }); i = quoted.end; continue;
    }
    const number = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(sql.slice(i));
    if (number) { tokens.push({ kind: 'number', value: number[0], at: i }); i += number[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(sql.slice(i));
    if (word) { tokens.push({ kind: 'word', value: word[0], at: i }); i += word[0].length; continue; }
    const value = sql.startsWith('::', i) ? '::' : c;
    tokens.push({ kind: 'symbol', value, at: i }); i += value.length;
  }
  return tokens;
}

/** One quote owner for catalog identifiers, SQL strings and native escape strings.
 * @param {string} sql @param {number} at @param {boolean} [escaped] @returns {any} */
export function quotedSqlToken(sql, at, escaped = false) {
  const quote = sql[at];
  let value = '';
  for (let i = at + 1; i < sql.length; i++) {
    if (escaped && sql[i] === '\\') { value += sql.slice(i, i + 2); i++; continue; }
    if (sql[i] !== quote) { value += sql[i]; continue; }
    if (sql[i + 1] === quote) { value += quote; i++; continue; }
    return { kind: quote === "'" ? 'string' : 'identifier', value, end: i + 1 };
  }
  return null;
}

/**
 * A cursor over catalog tokens. `take` consumes the next token when it is
 * the keyword or symbol named (case folded), never a quoted one.
 * @param {{ kind: string, value: string, at?: number }[]} tokens
 * @returns {{ tokens: { kind: string, value: string, at?: number }[], at: number, take: (value: string) => boolean }}
 */
function tokenCursor(tokens) {
  const cursor = {
    tokens,
    at: 0,
    /** @param {string} value */
    take(value) {
      const token = tokens[cursor.at];
      if (token && token.kind !== 'string' && token.kind !== 'identifier'
        && token.value.toUpperCase() === value) { cursor.at++; return true; }
      return false;
    },
  };
  return cursor;
}

/**
 * The exact decimal a numeric literal spells, in one canonical form — its
 * sign, its digits without leading or trailing zeros, and the power of ten
 * of the last one — so `1e-7` and `0.0000001` are one value and
 * `0.30000000000000004` and `0.300000000000000044` are two. `null` for text
 * that spells no number.
 * @param {string} text
 * @returns {string | null}
 */
export function decimalText(text) {
  const match = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (match === null || `${match[2]}${match[3] ?? ''}` === '') return null;
  const fraction = match[3] ?? '';
  const digits = `${match[2]}${fraction}`.replace(/^0+/, '');
  if (digits === '') return '0';
  const significant = digits.replace(/0+$/, '');
  const exponent = Number(match[4] ?? 0) - fraction.length + (digits.length - significant.length);
  return `${match[1] === '-' ? '-' : ''}${significant}e${exponent}`;
}

/** Whether a numeric literal spells exactly the number it reads as — the
 * shortest decimal of one double — and nothing a double rounds.
 * @param {string} text @param {number} value */
const spellsExactly = (text, value) => Number.isFinite(value) && decimalText(text) === decimalText(String(value));

/**
 * One scalar literal at the cursor: a number (signed), a string, and where
 * `booleans` says so `true`/`false`, each possibly parenthesised and cast;
 * a cast is read by the engine's `nativeCast`, and none is read without one.
 * Where `exact` is given, a number — written as one, or a text a cast reads as
 * one — must pass it with its text.
 * @param {ReturnType<typeof tokenCursor>} cursor @param {any} [nativeCast] @param {boolean} [booleans]
 * @param {(text: string, value: number) => boolean} [exact]
 * @returns {any} the value, or `undefined`
 */
function scalarAt(cursor, nativeCast, booleans = true, exact = undefined) {
  const cast = (/** @type {any} */ value) => {
    if (!cursor.take('::')) return value;
    const read = nativeCast?.(value, cursor.tokens[cursor.at++], cursor.take);
    return exact !== undefined && typeof value === 'string' && typeof read === 'number' && !exact(value, read) ? undefined : read;
  };
  if (cursor.take('(')) {
    const value = scalarAt(cursor, nativeCast, booleans, exact);
    return value === undefined || !cursor.take(')') ? undefined : cast(value);
  }
  const negative = cursor.take('-');
  const token = cursor.tokens[cursor.at++];
  if (!token) return undefined;
  let value;
  if (token.kind === 'number') {
    const text = `${negative ? '-' : ''}${token.value}`;
    value = Number(text);
    if (exact !== undefined && !exact(text, value)) return undefined;
  }
  else if (negative) return undefined;
  else if (token.kind === 'string') value = token.value;
  else if (booleans && token.kind === 'word' && /^(true|false)$/i.test(token.value)) value = token.value.toLowerCase() === 'true';
  else return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  return cast(value);
}

/** @param {any[]} tokens @param {any} [nativeCast] @returns {{ column: string, values: any[] } | null} */
function enumOf(tokens, nativeCast) {
  const cursor = tokenCursor(tokens);
  const take = cursor.take;
  const scalar = () => scalarAt(cursor, nativeCast);
  const expression = () => {
    if (take('(')) {
      const result = expression();
      return result === null || !take(')') ? null : result;
    }
    const column = tokens[cursor.at++];
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
  return cursor.at === tokens.length ? result : null;
}

/** SQLite retains the CREATE text, including inline and table CHECKs: each
 * under the name its `CONSTRAINT` clause gave it, else its ordinal, with the
 * CHECK's own text as `sql`.
 * @param {any[]} rows @returns {any[]} neutral constraints */
export function sqliteChecks(rows) {
  const checks = [];
  for (const row of rows) {
    const sql = String(row.sql ?? '');
    const tokens = sqlTokens(sql);
    // A column's inherited collation changes IN equality even when the
    // CHECK itself names no collation. Refuse conservatively per table.
    const collated = tokens.some((token, i) => token.kind === 'word'
      && token.value.toUpperCase() === 'COLLATE'
      && tokens[i + 1]?.value.toUpperCase() !== 'BINARY');
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].kind !== 'word' || tokens[i].value.toUpperCase() !== 'CHECK'
        || tokens[i + 1]?.value !== '(') continue;
      const named = tokens[i - 2]?.kind === 'word' && tokens[i - 2].value.toUpperCase() === 'CONSTRAINT'
        && (tokens[i - 1].kind === 'identifier' || tokens[i - 1].kind === 'word') ? tokens[i - 1].value : undefined;
      const start = i + 2;
      let depth = 1;
      for (i = start; i < tokens.length; i++) {
        if (tokens[i].kind !== 'symbol') continue;
        if (tokens[i].value === '(') depth++;
        if (tokens[i].value === ')' && --depth === 0) break;
      }
      checks.push({ name: named ?? `check_${checks.length + 1}`,
        sql: sql.slice(tokens[start]?.at ?? sql.length, tokens[i]?.at ?? sql.length),
        ...(collated ? null : enumOf(tokens.slice(start, i))) });
    }
  }
  return checks;
}

/** PostgreSQL exposes each CHECK expression separately, with whether the
 * rows it holds were checked against it (`validated`; a CHECK added `NOT
 * VALID` holds nothing for them) and the session's string conformance.
 * @param {any[]} rows @returns {any[]} neutral constraints */
export function postgresChecks(rows) {
  return rows.map((row) => ({ name: String(row.name), sql: String(row.expression ?? ''),
    ...(row.validated === undefined || row.validated === null ? {} : { validated: Number(row.validated) === 1 }),
    conforming: row.conforming === undefined || row.conforming === null || String(row.conforming) === 'on',
    ...(row.unsafe_collation ? null : enumOf(sqlTokens(String(row.expression ?? '')), postgresCast)) }));
}

/** Only exact scalar casts emitted by the native catalog are understood. */
function postgresCast(value, type, take) {
  if (type?.kind !== 'word') return undefined;
  const name = type.value.toLowerCase();
  if (typeof value === 'string' && name === 'text') return value;
  if (typeof value === 'boolean' && name === 'boolean') return value;
  // Negative constants are quoted numeric casts, e.g. ('-1'::integer)::numeric.
  const integer = ['integer', 'bigint', 'smallint'].includes(name);
  if (typeof value === 'string' && (name === 'numeric' || integer)
    && /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value)) value = Number(value);
  if (typeof value === 'number' && Number.isFinite(value)
    && (name === 'numeric' || integer && Number.isSafeInteger(value) || name === 'double' && take('PRECISION'))) return value;
  return undefined;
}

/**
 * How one engine spells an index condition it hands back: `truth` reads a
 * truth constant (or answers `undefined`), `cast` reads a literal's cast,
 * `nativeToken` reads a token of the engine's own, `bare` admits an unquoted
 * column name, `any` the `= ANY (ARRAY[...])` form of a list.
 * @typedef {{ truth: (token: { kind: string, value: string }) => boolean | undefined, cast?: any,
 *   nativeToken?: (sql: string, at: number) => any, bare?: boolean, any?: boolean }} PredicateSpelling
 */

/** The comparison each operator spells. */
const COMPARISONS = /* @__PURE__ */ Object.freeze(/** @type {Record<string, string>} */ ({ '=': '$eq', '<>': '$ne', '!=': '$ne', '<': '$lt', '<=': '$le', '>': '$gt', '>=': '$ge' }));

/** How deep a condition the reader follows: a deeper one is refused where it
 * is planned, and a stored one this deep reads as a condition that differs. */
const READ_DEPTH = 256;

/**
 * Read an index condition back into the query grammar, from the text the
 * predicate rendering wrote or the engine's stored form of it. The reading is
 * exact: it covers the rendering's one spelling per meaning and the server's
 * cosmetic rewrites of it, nothing else. A nested `$and` (`$or`) joins the one
 * it sits in and a one-item list is an equality (the server flattens and
 * rewrites both); a `COALESCE(…, false)` must wrap exactly the plain leaves a
 * `NOT` encloses, as the rendering writes them (`NOT x` and `NOT COALESCE(x,
 * false)` differ where `x` is NULL); a number must spell exactly the double it
 * reads as; a boolean column's stored 1 or 0 is `true` or `false`, and a text
 * starting with `$` is escaped. So two readings are equal exactly when the two
 * conditions hold for the same rows, and rendering a reading reproduces the
 * rendering it came from — save one rare form: two members of different types
 * compared render as their presence test, which an enclosing `$and` joins.
 * @param {string} sql
 * @param {PredicateSpelling} spelling - the engine's
 * @param {(identifier: string) => ({ path: string, codec: string } | null)} member -
 *   the member path and codec a column of the table holds, or `null`
 * @returns {any} the condition, or `null` for anything the spelling does not
 *   cover, which a reader takes as a condition that differs
 */
export function readPredicate(sql, spelling, member) {
  const tokens = sqlTokens(String(sql), spelling.nativeToken);
  if (tokens.length === 0) return null;
  const cursor = tokenCursor(tokens);
  const take = cursor.take;
  /** A literal as the grammar writes it beside `other`. @param {any} value @param {any} other */
  const literal = (value, other) => {
    if (other?.codec === 'boolean') return value === 1 ? true : value === 0 ? false : undefined;
    return typeof value === 'string' && value.startsWith('$') ? `$${value}` : value;
  };
  /** A column or a literal. */
  const operand = () => {
    const token = tokens[cursor.at];
    if (token === undefined) return undefined;
    if (token.kind === 'identifier' || (token.kind === 'word' && spelling.bare === true)) {
      const read = member(token.value);
      if (read !== null) { cursor.at++; return { column: true, ...read }; }
      if (token.kind === 'identifier') return undefined;
    }
    const value = scalarAt(cursor, spelling.cast, false, spellsExactly);
    return value === undefined ? undefined : { value };
  };
  /** The comparison operator at the cursor, its two symbols adjacent. */
  const operator = () => {
    const token = tokens[cursor.at], next = tokens[cursor.at + 1];
    if (token?.kind !== 'symbol') return undefined;
    const pair = next?.kind === 'symbol' && next.at === /** @type {number} */ (token.at) + 1 ? `${token.value}${next.value}` : undefined;
    if (pair !== undefined && Object.hasOwn(COMPARISONS, pair)) { cursor.at += 2; return COMPARISONS[pair]; }
    if (!Object.hasOwn(COMPARISONS, token.value)) return undefined;
    cursor.at++;
    return COMPARISONS[token.value];
  };
  /** The items of a list up to `close`, as membership of the column. @param {any} column @param {string} close */
  const membership = (column, close) => {
    if (!column.column) return undefined;
    const items = [];
    do {
      const value = scalarAt(cursor, spelling.cast, false, spellsExactly);
      const item = value === undefined ? undefined : literal(value, column);
      if (item === undefined) return undefined;
      items.push(item);
    } while (take(','));
    if (!take(close)) return undefined;
    return { $eq: [column.path, items.length === 1 ? items[0] : { $seq: items }] };
  };
  const comparison = () => {
    const left = operand();
    if (left === undefined) return undefined;
    if (take('IS')) return take('NOT') && take('NULL') && left.column ? { $exists: left.path } : undefined;
    if (take('IN')) return take('(') ? membership(left, ')') : undefined;
    const key = operator();
    if (key === undefined) return undefined;
    if (key === '$eq' && spelling.any === true && take('ANY')) {
      if (!(take('(') && take('ARRAY') && take('['))) return undefined;
      const list = membership(left, ']');
      return list !== undefined && take(')') ? list : undefined;
    }
    const right = operand();
    if (right === undefined) return undefined;
    const sides = [left.column ? left.path : literal(left.value, right), right.column ? right.path : literal(right.value, left)];
    return sides.includes(undefined) ? undefined : { [key]: sides };
  };
  /** A comparison, possibly parenthesised. @returns {any} */
  const leaf = () => {
    const start = cursor.at;
    if (take('(')) {
      const inner = leaf();
      if (inner !== undefined && take(')')) return inner;
      cursor.at = start;
    }
    return comparison();
  };
  /** Whether a reading is a presence test, which is never NULL and never coalesced. @param {any} read */
  const presence = (read) => Object.hasOwn(read, '$exists');
  /** @param {boolean} negated whether a `NOT` encloses it @param {number} depth @returns {any} */
  const primary = (negated, depth) => {
    if (depth > READ_DEPTH) return undefined;
    const start = cursor.at;
    if (take('(')) {
      const inner = disjunction(negated, depth + 1);
      if (inner !== undefined && take(')')) return inner;
      cursor.at = start;
    }
    if (take('COALESCE')) {
      if (!negated || !take('(')) return undefined;
      const inner = leaf();
      if (inner === undefined || presence(inner) || !take(',')) return undefined;
      const fallback = tokens[cursor.at++];
      return fallback !== undefined && spelling.truth(fallback) === false && take(')') ? inner : undefined;
    }
    const found = comparison();
    if (found !== undefined) return negated && !presence(found) ? undefined : found;
    cursor.at = start;
    const truth = tokens[start] === undefined ? undefined : spelling.truth(tokens[start]);
    if (truth !== undefined) cursor.at++;
    return truth;
  };
  /** @param {boolean} negated @param {number} depth @returns {any} */
  const negation = (negated, depth) => {
    if (!take('NOT')) return primary(negated, depth);
    const inner = depth > READ_DEPTH ? undefined : negation(true, depth + 1);
    return inner === undefined ? undefined : { $not: inner };
  };
  /** @param {'$and' | '$or'} key @param {string} word @param {() => any} next @returns {any} */
  const joined = (key, word, next) => {
    const first = next();
    if (first === undefined) return undefined;
    const operands = [first];
    while (take(word)) {
      const operand = next();
      if (operand === undefined) return undefined;
      operands.push(operand);
    }
    return operands.length === 1 ? first : { [key]: operands.flatMap((operand) =>
      (operand !== null && typeof operand === 'object' && Object.hasOwn(operand, key) ? operand[key] : [operand])) };
  };
  /** @param {boolean} negated @param {number} depth @returns {any} */
  const conjunction = (negated, depth) => joined('$and', 'AND', () => negation(negated, depth));
  /** @param {boolean} negated @param {number} depth @returns {any} */
  const disjunction = (negated, depth) => joined('$or', 'OR', () => conjunction(negated, depth));
  const result = disjunction(false, 0);
  return result !== undefined && cursor.at === tokens.length ? result : null;
}

/**
 * The string tokens PostgreSQL writes back beyond the standard ones: an
 * escape string (`E'…'`), as this package writes one too, and — in a session
 * whose `standard_conforming_strings` is off — a plain string spelled the same
 * way. A doubled backslash is the one escape either holds: the server writes
 * no other, and anything else reads as text it did not write.
 * @param {boolean} conforming - the session's `standard_conforming_strings`
 * @returns {(sql: string, at: number) => any} a `sqlTokens` native token reader
 */
export function postgresStrings(conforming) {
  return (sql, at) => {
    const escape = (sql[at] === 'E' || sql[at] === 'e') && sql[at + 1] === "'" && !/[A-Za-z0-9_$]/.test(sql[at - 1] ?? '');
    if (!escape && (conforming || sql[at] !== "'")) return undefined;
    const quoted = quotedSqlToken(sql, escape ? at + 1 : at, true);
    if (!quoted) return null;
    let value = '';
    for (let i = 0; i < quoted.value.length; i++) {
      if (quoted.value[i] !== '\\') { value += quoted.value[i]; continue; }
      if (quoted.value[i + 1] !== '\\') return null;
      value += '\\'; i++;
    }
    return { kind: 'string', value, end: quoted.end };
  };
}

/** PostgreSQL's spelling, for a session whose `standard_conforming_strings` is
 * as given: the stored form `pg_get_expr` deparses (bare lower case names,
 * casts, `= ANY (ARRAY[...])`, lower case truth values) and the text the
 * PostgreSQL rendering writes (quoted names, `IN`, `TRUE`, escape strings).
 * @param {boolean} conforming @returns {PredicateSpelling} */
const postgresSpelling = (conforming) => ({
  truth: (/** @type {{ kind: string, value: string }} */ token) => (token.kind === 'word' && /^(true|false)$/i.test(token.value) ? token.value.toLowerCase() === 'true' : undefined),
  cast: postgresCast,
  nativeToken: postgresStrings(conforming),
  bare: true,
  any: true,
});

/** PostgreSQL's spelling where `standard_conforming_strings` is on (the default). @type {PredicateSpelling} */
export const POSTGRES_PREDICATE = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ postgresSpelling(true));

/** PostgreSQL's spelling for a session whose `standard_conforming_strings` is
 * off, where the server writes a backslash doubled in a plain string. @type {PredicateSpelling} */
export const POSTGRES_PREDICATE_ESCAPED = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ postgresSpelling(false));

/** SQLite's spelling: the text the SQLite rendering writes, which the engine
 * keeps verbatim (quoted names, `IN`, the truth values 1 and 0).
 * @type {PredicateSpelling} */
export const SQLITE_PREDICATE = /* @__PURE__ */ Object.freeze({
  truth: (token) => (token.kind === 'number' && (token.value === '1' || token.value === '0') ? token.value === '1' : undefined),
});

/**
 * How one engine spells the interval CHECK it hands back, beyond what a
 * {@link PredicateSpelling} reads: `typeOf` reads the JSON-type call over
 * the document column at `at` — the column, the path it reads as segments
 * and the token after the call — or answers `undefined`; `integers` says
 * how a bound is held to an integer, by the document's JSON type
 * (`'document'`: one JSON-type call per bound, `IS 'integer'`) or by the
 * column (`'column'`: present, and equal to its own `trunc`).
 * @typedef {PredicateSpelling & {
 *   typeOf: (tokens: { kind: string, value: string }[], at: number) =>
 *     ({ column: string, segments: import('../dialect.js').JsonPathSegment[], end: number } | undefined),
 *   integers: 'document' | 'column' }} IntervalSpelling
 */

/** The bound every declared interval keeps a span within: the safe integers. */
const SAFE_BOUND = Number.MAX_SAFE_INTEGER;

/**
 * Read an interval CHECK back into its declaration — the document column
 * and span path it reads, the two bound columns and the maximum duration —
 * or `null` for text that is not exactly one engine's spelling of the one
 * template: a conjunct missing, doubled, altered or added, a branch more or
 * fewer, a constant other than the template's, a comparison a NULL could
 * satisfy. Conjuncts are read as a set through the engine's own
 * parentheses and casts, so the server's deparse and the text the dialect
 * wrote read as one declaration whatever order the conjuncts come in.
 * @param {string} sql
 * @param {IntervalSpelling} spelling - the engine's
 * @returns {{ column: string, span: import('../dialect.js').JsonPathSegment[],
 *   start: string, end: string, maxDuration: number | null } | null}
 */
export function readIntervalCheck(sql, spelling) {
  const tokens = sqlTokens(String(sql), spelling.nativeToken);
  if (tokens.length === 0) return null;
  const cursor = tokenCursor(tokens);
  const take = cursor.take;
  const COMPARISONS = ['=', '<', '<=', '>='];
  /** A column name at the cursor. */
  const column = () => {
    const token = tokens[cursor.at];
    if (token === undefined || !(token.kind === 'identifier' || (token.kind === 'word' && spelling.bare === true))) return undefined;
    cursor.at++;
    return token.value;
  };
  /** A number literal as the engine spells one: signed, parenthesised, cast. */
  const number = () => {
    const value = scalarAt(cursor, spelling.cast, false, spellsExactly);
    return typeof value === 'number' ? value : undefined;
  };
  /** A string literal, possibly cast. */
  const string = () => {
    const value = scalarAt(cursor, spelling.cast, false);
    return typeof value === 'string' ? value : undefined;
  };
  /** The comparison at the cursor, its two symbols adjacent. */
  const comparison = () => {
    const token = tokens[cursor.at], next = tokens[cursor.at + 1];
    if (token?.kind !== 'symbol') return undefined;
    const pair = next?.kind === 'symbol' && next.at === /** @type {number} */ (token.at) + 1 ? `${token.value}${next.value}` : undefined;
    if (pair !== undefined && COMPARISONS.includes(pair)) { cursor.at += 2; return pair; }
    if (!COMPARISONS.includes(token.value)) return undefined;
    cursor.at++;
    return token.value;
  };
  /** An operand: a JSON-type call, a column, or a difference of two columns, each possibly parenthesised. @returns {any} */
  const operand = () => {
    const start = cursor.at;
    if (take('(')) {
      const inner = operand();
      if (inner !== undefined && take(')')) return inner;
      cursor.at = start;
    }
    const typeOf = spelling.typeOf(tokens, cursor.at);
    if (typeOf !== undefined) {
      cursor.at = typeOf.end;
      return { typeOf: { column: typeOf.column, segments: typeOf.segments } };
    }
    const left = column();
    if (left === undefined) return undefined;
    if (!take('-')) return { column: left };
    const right = column();
    return right === undefined ? undefined : { difference: [left, right] };
  };
  /** One conjunct the template writes, tagged by its kind. @returns {any} */
  const atom = () => {
    const left = operand();
    if (left === undefined) return undefined;
    if (left.typeOf !== undefined) {
      if (take('IS')) {
        if (take('NULL')) return { kind: 'absent', ...left.typeOf };
        return string() === 'integer' ? { kind: 'integer', ...left.typeOf } : undefined;
      }
      return take('=') && string() === 'object' ? { kind: 'object', ...left.typeOf } : undefined;
    }
    if (left.difference !== undefined) {
      if (comparison() !== '<=') return undefined;
      const max = number();
      return max === undefined ? undefined : { kind: 'duration', end: left.difference[0], start: left.difference[1], max };
    }
    const name = left.column;
    if (take('IS')) return take('NOT') && take('NULL') ? { kind: 'present', column: name } : undefined;
    if (take('BETWEEN')) {
      const low = number();
      if (low === undefined || !take('AND')) return undefined;
      const high = number();
      return high === undefined ? undefined : { kind: 'within', column: name, low, high };
    }
    const op = comparison();
    if (op === undefined) return undefined;
    if (op === '=') {
      // the whole-number test: the column equal to its own truncation
      if (!take('TRUNC') || !take('(')) return undefined;
      const same = column();
      return same === name && take(')') ? { kind: 'whole', column: name } : undefined;
    }
    if (op === '<') {
      const end = column();
      return end === undefined ? undefined : { kind: 'before', start: name, end };
    }
    const bound = number();
    if (bound === undefined) return undefined;
    return op === '>=' ? { kind: 'atLeast', column: name, low: bound } : { kind: 'atMost', column: name, high: bound };
  };
  /** A parenthesised conjunction, or one atom. @param {number} depth @returns {any[] | undefined} */
  const term = (depth) => {
    if (depth > READ_DEPTH) return undefined;
    const start = cursor.at;
    if (take('(')) {
      const inner = conjunction(depth + 1);
      if (inner !== undefined && take(')')) return inner;
      cursor.at = start;
    }
    const one = atom();
    return one === undefined ? undefined : [one];
  };
  /** The atoms of a conjunction, nested conjunctions flattened. @param {number} depth @returns {any[] | undefined} */
  const conjunction = (depth) => {
    const atoms = [];
    do {
      const part = term(depth);
      if (part === undefined) return undefined;
      atoms.push(...part);
    } while (take('AND'));
    return atoms;
  };
  /** The two branches of the disjunction, possibly parenthesised as a whole. @param {number} depth @returns {any[][] | undefined} */
  const branches = (depth) => {
    if (depth > READ_DEPTH) return undefined;
    const start = cursor.at;
    if (take('(')) {
      const inner = branches(depth + 1);
      if (inner !== undefined && take(')')) return inner;
      cursor.at = start;
    }
    const first = conjunction(depth);
    if (first === undefined || !take('OR')) return undefined;
    const second = conjunction(depth);
    return second === undefined ? undefined : [first, second];
  };
  const read = branches(0);
  if (read === undefined || cursor.at !== tokens.length) return null;
  // one branch is the absent span alone; the other names the span an
  // object and holds every bound conjunct, once each
  const alone = read.findIndex((branch) => branch.length === 1 && branch[0].kind === 'absent');
  if (alone < 0) return null;
  const absent = read[alone][0];
  const rest = read[1 - alone].flatMap((item) => (item.kind === 'within'
    ? [{ kind: 'atLeast', column: item.column, low: item.low }, { kind: 'atMost', column: item.column, high: item.high }]
    : [item]));
  const before = rest.find((item) => item.kind === 'before');
  if (before === undefined || before.start === before.end) return null;
  const { start, end } = before;
  const integers = spelling.integers === 'document'
    ? ['start', 'end'].map((bound) => ({ kind: 'integer', column: absent.column, segments: [...absent.segments, { name: bound }] }))
    : [start, end].flatMap((name) => [{ kind: 'present', column: name }, { kind: 'whole', column: name }]);
  const expected = [
    { kind: 'object', column: absent.column, segments: absent.segments },
    ...integers,
    ...[start, end].flatMap((name) => [{ kind: 'atLeast', column: name, low: -SAFE_BOUND }, { kind: 'atMost', column: name, high: SAFE_BOUND }]),
    { kind: 'before', start, end },
  ];
  const counts = new Map();
  for (const item of rest) {
    const key = JSON.stringify(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const item of expected) {
    const key = JSON.stringify(item);
    if (counts.get(key) !== 1) return null;
    counts.delete(key);
  }
  const extra = [...counts.keys()].map((key) => JSON.parse(key));
  if (extra.length === 0) return { column: absent.column, span: absent.segments, start, end, maxDuration: null };
  const [duration] = extra;
  if (extra.length !== 1 || counts.get(JSON.stringify(duration)) !== 1 || duration.kind !== 'duration'
    || duration.start !== start || duration.end !== end || !Number.isSafeInteger(duration.max) || duration.max < 1) return null;
  return { column: absent.column, span: absent.segments, start, end, maxDuration: duration.max };
}
