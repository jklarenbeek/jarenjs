//@ts-check
/**
 * @file What a PostgreSQL open reads back of the CREATE text the server does
 * not keep — each index condition and each generated column's expression —
 * compared exactly with the plan. The server stores a parsed form and hands
 * back its deparse (`pg_get_expr`), which differs from the planned text only
 * cosmetically: names quoted where they must be, a type on every literal,
 * `ELSE NULL` spelled out, parentheses around every operator, and literals
 * written as the session's `standard_conforming_strings` reads them. Both
 * texts are read into one form that undoes exactly those differences and
 * nothing else, so any other difference — a path, a guard, an operator, a
 * collation, a `COALESCE`, a literal's value — is drift, and a text neither
 * side reads is drift too, never a match. Only the PostgreSQL dialect imports
 * this module.
 */
import { POSTGRES_PREDICATE, POSTGRES_PREDICATE_ESCAPED, decimalText, postgresStrings, readPredicate, sqlTokens } from './check-read.js';

/** How deep an expression the reader follows; a stored one deeper reads as one that differs. */
const READ_DEPTH = 256;
/** The string types a literal of text keeps its value under. */
const STRING_TYPES = new Set(['text', 'character varying', 'varchar', 'character', 'bpchar', 'name', 'unknown']);
/** The type names a deparse writes in two words, by their first. */
const TWO_WORD_TYPES = new Map([['double', 'PRECISION'], ['character', 'VARYING']]);
/** The numeric types a literal keeps its value under. */
const NUMBER_TYPES = new Set(['integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision']);

/**
 * The elements of a PostgreSQL array literal (`{a,"b c"}`), or `null` for a
 * text that spells none: what `#>` and `#>>` read, compared as values so a
 * quoting style never differs from another.
 * @param {string} text @returns {(string | null)[] | null}
 */
function arrayElements(text) {
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  const body = text.slice(1, -1);
  /** @type {(string | null)[]} */
  const out = [];
  if (body.trim() === '') return out;
  for (let i = 0; ;) {
    while (body[i] === ' ') i++;
    if (body[i] === '"') {
      let value = '';
      for (i++; i < body.length && body[i] !== '"'; i++) {
        if (body[i] === '\\') i++;
        if (i >= body.length) return null;
        value += body[i];
      }
      if (body[i] !== '"') return null;
      out.push(value);
      i++;
    }
    else {
      let end = i;
      while (end < body.length && body[end] !== ',') end++;
      const raw = body.slice(i, end).trim();
      if (raw === '' || /["\\{}]/.test(raw)) return null;
      out.push(raw.toUpperCase() === 'NULL' ? null : raw);
      i = end;
    }
    while (body[i] === ' ') i++;
    if (i >= body.length) return out;
    if (body[i] !== ',') return null;
    i++;
  }
}

/**
 * An expression read into the one form the planned text and the server's
 * deparse share: a literal of a string or a numeric type is its value (a
 * number as its exact decimal), an `ELSE NULL` is no `ELSE`, the path a `#>`
 * or `#>>` reads is its elements, a bare name is folded to lower case.
 * Everything else — every operator, call, cast of a non-literal, `CASE`
 * branch and collation — is kept as written.
 * @param {string} sql
 * @param {boolean} conforming - how the text spells a backslash in a plain string
 * @returns {any | null} the form, or `null` for text it does not read
 */
export function expressionForm(sql, conforming) {
  const tokens = sqlTokens(String(sql), postgresStrings(conforming));
  if (tokens.length === 0) return null;
  let at = 0;
  /** @param {string} value */
  const take = (value) => {
    const token = tokens[at];
    if (token && token.kind !== 'string' && token.kind !== 'identifier' && token.value.toUpperCase() === value) { at++; return true; }
    return false;
  };
  /** An operator: a run of adjacent operator symbols. */
  const operator = () => {
    const first = tokens[at];
    if (first?.kind !== 'symbol' || !/^[-+*/<>=~!@#%^&|`?]$/.test(first.value)) return undefined;
    let text = first.value, end = at + 1;
    while (tokens[end]?.kind === 'symbol' && /^[-+*/<>=~!@#%^&|`?]$/.test(tokens[end].value)
      && tokens[end].at === /** @type {number} */ (tokens[end - 1].at) + 1) text += tokens[end++].value;
    return { text, end };
  };
  /** A name: words or quoted identifiers joined by dots; a bare word folded. */
  const name = () => {
    const parts = [];
    do {
      const token = tokens[at];
      if (token?.kind !== 'word' && token?.kind !== 'identifier') return undefined;
      parts.push(token.kind === 'word' ? token.value.toLowerCase() : token.value);
      at++;
    } while (tokens[at]?.value === '.' && tokens[at]?.kind === 'symbol' && ++at);
    return parts.join('.');
  };
  /** A type name — one word, or `double precision` and `character varying`,
   * the two-word names a deparse writes — possibly an array of it. */
  const typeName = () => {
    const first = tokens[at];
    if (first?.kind !== 'word' && first?.kind !== 'identifier') return undefined;
    at++;
    const words = [first.kind === 'word' ? first.value.toLowerCase() : first.value];
    const second = first.kind === 'word' ? TWO_WORD_TYPES.get(words[0]) : undefined;
    if (second !== undefined && take(second)) words.push(second.toLowerCase());
    if (take('[')) { if (!take(']')) return undefined; words.push('[]'); }
    return words.join(' ');
  };
  /** A cast, its literal operand read as the value it keeps. @param {any} of @param {string} type */
  const cast = (of, type) => {
    if (Object.hasOwn(of, 'null')) return of;
    if (Object.hasOwn(of, 's') && (STRING_TYPES.has(type) || type === 'text []')) return of;
    if (Object.hasOwn(of, 's') && NUMBER_TYPES.has(type)) {
      const n = decimalText(of.s);
      return n === null ? { cast: type, of } : { n };
    }
    if (Object.hasOwn(of, 'n') && NUMBER_TYPES.has(type)) return of;
    if (Object.hasOwn(of, 'b') && type === 'boolean') return of;
    return { cast: type, of };
  };
  /** @param {number} depth @returns {any} */
  const primary = (depth) => {
    const token = tokens[at];
    if (token === undefined || depth > READ_DEPTH) return undefined;
    if (take('(')) {
      const inner = expression(depth + 1);
      return inner !== undefined && take(')') ? inner : undefined;
    }
    if (take('CASE')) {
      const branches = [];
      while (take('WHEN')) {
        const when = expression(depth + 1);
        if (when === undefined || !take('THEN')) return undefined;
        const then = expression(depth + 1);
        if (then === undefined) return undefined;
        branches.push([when, then]);
      }
      const otherwise = take('ELSE') ? expression(depth + 1) : { null: true };
      if (branches.length === 0 || otherwise === undefined || !take('END')) return undefined;
      // no ELSE and ELSE NULL are one CASE
      return Object.hasOwn(otherwise, 'null') ? { case: branches } : { case: branches, else: otherwise };
    }
    if (token.kind === 'string') { at++; return { s: token.value }; }
    if (token.kind === 'number') { at++; return { n: /** @type {string} */ (decimalText(token.value)) }; }
    if (token.kind === 'word' && /^(true|false)$/i.test(token.value)) { at++; return { b: token.value.toLowerCase() === 'true' }; }
    if (token.kind === 'word' && token.value.toUpperCase() === 'NULL') { at++; return { null: true }; }
    if (take('ARRAY')) {
      if (!take('[')) return undefined;
      const items = [];
      if (!take(']')) {
        do {
          const item = expression(depth + 1);
          if (item === undefined) return undefined;
          items.push(item);
        } while (take(','));
        if (!take(']')) return undefined;
      }
      return { array: items };
    }
    const called = name();
    if (called === undefined) return undefined;
    if (!take('(')) return { id: called };
    const args = [];
    if (!take(')')) {
      do {
        const arg = expression(depth + 1);
        if (arg === undefined) return undefined;
        args.push(arg);
      } while (take(','));
      if (!take(')')) return undefined;
    }
    return { call: called, args };
  };
  /** A primary with its casts and collations. @param {number} depth @returns {any} */
  const postfix = (depth) => {
    let node = primary(depth);
    while (node !== undefined) {
      if (take('::')) {
        const type = typeName();
        node = type === undefined ? undefined : cast(node, type);
      }
      else if (take('COLLATE')) {
        const collation = name();
        node = collation === undefined ? undefined : { collate: collation, of: node };
      }
      else return node;
    }
    return undefined;
  };
  /** A minus where an operand starts is a sign: of a number, part of it, as
   * the server keeps a negative constant. @param {number} depth @returns {any} */
  const prefix = (depth) => {
    if (depth > READ_DEPTH) return undefined;
    const sign = tokens[at];
    if (sign?.kind !== 'symbol' || sign.value !== '-') return postfix(depth);
    at++;
    const of = prefix(depth + 1);
    if (of === undefined) return undefined;
    if (Object.hasOwn(of, 'n')) return { n: of.n === '0' ? '0' : of.n.startsWith('-') ? of.n.slice(1) : `-${of.n}` };
    return { op: '-', args: [of] };
  };
  /** Operators, left to right: the deparse brackets every one, so no precedence is read. @param {number} depth @returns {any} */
  const infix = (depth) => {
    let left = prefix(depth);
    for (let found = operator(); left !== undefined && found !== undefined; found = operator()) {
      at = found.end;
      const right = prefix(depth + 1);
      if (right === undefined) return undefined;
      // the path a #> or #>> reads is its elements, however the literal quotes them
      const path = (found.text === '#>' || found.text === '#>>') && Object.hasOwn(right, 's') ? arrayElements(right.s) : null;
      left = { op: found.text, args: [left, path === null ? right : { path }] };
    }
    return left;
  };
  /** @param {number} depth @returns {any} */
  const test = (depth) => {
    const left = infix(depth);
    if (left === undefined || !take('IS')) return left;
    const not = take('NOT');
    return take('NULL') ? { op: not ? 'is not null' : 'is null', args: [left] } : undefined;
  };
  /** @param {number} depth @returns {any} */
  const negation = (depth) => {
    if (!take('NOT')) return test(depth);
    const of = depth > READ_DEPTH ? undefined : negation(depth + 1);
    return of === undefined ? undefined : { op: 'not', args: [of] };
  };
  /** @param {string} word @param {(depth: number) => any} next @param {number} depth @returns {any} */
  const joined = (word, next, depth) => {
    const first = next(depth);
    if (first === undefined || !take(word)) return first;
    const args = [first];
    do {
      const arg = next(depth);
      if (arg === undefined) return undefined;
      args.push(arg);
    } while (take(word));
    return { op: word.toLowerCase(), args };
  };
  /** @param {number} depth @returns {any} */
  const expression = (depth) => joined('OR', (d) => joined('AND', negation, d), depth);
  const form = expression(0);
  return form !== undefined && at === tokens.length ? form : null;
}

/** The member a column of the table holds, by its physical name.
 * @param {{ name: string, physical: string, codec: string }[]} columns */
const memberOf = (columns) => (/** @type {string} */ identifier) => {
  const column = columns.find((c) => c.physical === identifier);
  return column === undefined ? null : { path: `$.${column.name}`, codec: column.codec };
};

/**
 * The read-back the PostgreSQL dialect hands the open (`dialect.readBack`).
 * The planner asks first whether a planned condition or expression reads back
 * at all, and refuses one that does not (`JD0004`) rather than meet it as
 * drift; the open then compares the catalog's deparse with the plan.
 */
export const postgresReadBack = Object.freeze({
  /** Whether a planned index condition reads back.
   * @param {string} planned @param {{ name: string, physical: string, codec: string }[]} columns */
  conditionReads: (planned, columns) => readPredicate(planned, POSTGRES_PREDICATE, memberOf(columns)) !== null,
  /**
   * How an index's stored condition differs from the planned one, or `null`.
   * @param {string | null} stored - the deparse, `null` for none
   * @param {string | undefined} planned - the rendered condition, `undefined` for none
   * @param {{ name: string, physical: string, codec: string }[]} columns - the members it may read
   * @param {boolean} conforming - the reading session's `standard_conforming_strings`
   * @returns {string | null}
   */
  condition(stored, planned, columns, conforming) {
    if (stored === null) return planned === undefined ? null : `has no condition, and the model declares WHERE ${planned}`;
    if (planned === undefined) return `has the condition ${stored}, which the model does not declare`;
    const have = readPredicate(stored, conforming ? POSTGRES_PREDICATE : POSTGRES_PREDICATE_ESCAPED, memberOf(columns));
    const want = readPredicate(planned, POSTGRES_PREDICATE, memberOf(columns));
    return have !== null && want !== null && JSON.stringify(have) === JSON.stringify(want)
      ? null : `has the condition ${stored}, and the model declares WHERE ${planned}`;
  },
  /** Whether a planned generated column's expression reads back. @param {string} planned */
  expressionReads: (planned) => expressionForm(planned, true) !== null,
  /**
   * How a generated column's stored expression differs from the planned one, or `null`.
   * @param {string} stored - the deparse @param {string} planned - the planned expression
   * @param {boolean} conforming - the reading session's `standard_conforming_strings`
   * @returns {string | null}
   */
  expression(stored, planned, conforming) {
    const have = expressionForm(stored, conforming);
    const want = expressionForm(planned, true);
    return have !== null && want !== null && JSON.stringify(have) === JSON.stringify(want)
      ? null : `computes ${stored}, and the model declares ${planned}`;
  },
});
