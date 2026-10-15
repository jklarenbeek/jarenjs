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
 * side reads is drift too, never a match. A layout's index condition is the
 * one exception: the application, not the plan, created it, so it is read
 * into a form shared by every spelling the server keeps of one condition
 * (`conditionForm`), and a condition either side does not read is not
 * compared. Only the PostgreSQL dialect imports this module.
 */
import { POSTGRES_PREDICATE, POSTGRES_PREDICATE_ESCAPED, READ_DEPTH, decimalText, postgresStrings, readPredicate, sqlTokens } from './check-read.js';

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
 * branch and collation — is kept as written. A condition (`condition`) also
 * reads the forms the relational rendering writes and the server rewrites:
 * `CAST(x AS type)` (the server's `x::type`), `IN` and `NOT IN` lists, `LIKE`
 * and `NOT LIKE` (the server's `~~` and `!~~`) and `IS [NOT] DISTINCT FROM`.
 * @param {string} sql
 * @param {boolean} conforming - how the text spells a backslash in a plain string
 * @param {boolean} [condition] - whether to read a condition's forms too
 * @returns {any | null} the form, or `null` for text it does not read
 */
export function expressionForm(sql, conforming, condition = false) {
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
    if (condition && take('CAST')) {
      if (!take('(')) return undefined;
      const of = expression(depth + 1);
      const type = of !== undefined && take('AS') ? typeName() : undefined;
      return type !== undefined && take(')') ? cast(of, type) : undefined;
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
  /** The items of a parenthesised list. @param {number} depth @returns {any[] | undefined} */
  const items = (depth) => {
    if (!take('(')) return undefined;
    const out = [];
    do {
      const item = expression(depth + 1);
      if (item === undefined) return undefined;
      out.push(item);
    } while (take(','));
    return take(')') ? out : undefined;
  };
  /** A condition's word operator after its left operand: `[NOT] IN`, `[NOT] LIKE`.
   * @param {any} left @param {number} depth @returns {any} */
  const worded = (left, depth) => {
    const negated = tokens[at]?.kind === 'word' && tokens[at].value.toUpperCase() === 'NOT'
      && tokens[at + 1]?.kind === 'word' && /^(IN|LIKE)$/i.test(tokens[at + 1].value) && ++at > 0;
    if (take('IN')) {
      const list = items(depth);
      return list === undefined ? undefined : { op: negated ? 'not in' : 'in', args: [left, ...list] };
    }
    if (take('LIKE')) {
      const right = infix(depth + 1);
      return right === undefined ? undefined : { op: negated ? '!~~' : '~~', args: [left, right] };
    }
    return left;
  };
  /** @param {number} depth @returns {any} */
  const test = (depth) => {
    const read = infix(depth);
    const left = condition && read !== undefined ? worded(read, depth) : read;
    if (left === undefined || !take('IS')) return left;
    const not = take('NOT');
    if (condition && take('DISTINCT')) {
      const right = take('FROM') ? infix(depth + 1) : undefined;
      return right === undefined ? undefined : { op: not ? 'not distinct' : 'distinct', args: [left, right] };
    }
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

/** What a value of each type compares as: a literal beside it is read as one. */
const CATEGORIES = new Map([...[...STRING_TYPES].map((type) => [type, 'string']), ...[...NUMBER_TYPES].map((type) => [type, 'number']),
  ['boolean', 'boolean']]);
/**
 * The casts the server writes around a column it compares under a wider type
 * of its own family, by the column's type: the condition the server keeps
 * for `n > 5.5` over an integer `n` is `(n)::numeric > 5.5`, the same one.
 */
const WIDER = new Map([
  ['smallint', ['integer', 'bigint', 'numeric', 'real', 'double precision']],
  ['integer', ['bigint', 'numeric', 'real', 'double precision']],
  ['bigint', ['numeric', 'real', 'double precision']],
  ['numeric', ['real', 'double precision']],
  ['real', ['double precision']],
  ['character varying', ['text']], ['character', ['text']], ['name', ['text']],
]);
/** The text a boolean reads from, as the server reads a quoted literal beside a boolean. */
const BOOLEAN_TEXT = new Map([['t', true], ['true', true], ['y', true], ['yes', true], ['on', true], ['1', true],
  ['f', false], ['false', false], ['n', false], ['no', false], ['off', false], ['0', false]]);
/** The comparison each spelling is, and each with its operands swapped and negated. */
const COMPARISONS = new Map([['=', '='], ['<>', '<>'], ['!=', '<>'], ['<', '<'], ['<=', '<='], ['>', '>'], ['>=', '>=']]);
const SWAPPED = new Map([['=', '='], ['<>', '<>'], ['<', '>'], ['>', '<'], ['<=', '>='], ['>=', '<=']]);
const NEGATED = new Map([['=', '<>'], ['<>', '='], ['<', '>='], ['>=', '<'], ['>', '<='], ['<=', '>'],
  ['in', 'not in'], ['not in', 'in'], ['is null', 'is not null'], ['is not null', 'is null'], ['distinct', 'not distinct'], ['not distinct', 'distinct'],
  ['~~', '!~~'], ['!~~', '~~']]);
/** The functions a condition may call, by what each returns: `null` for the type of its arguments. */
const RETURNS = new Map([['lower', 'string'], ['upper', 'string'], ['ltrim', 'string'], ['rtrim', 'string'], ['trim', 'string'],
  ['length', 'number'], ['octet_length', 'number'], ['abs', null], ['round', null], ['coalesce', null], ['nullif', null]]);
/** The argument types of a function a condition calls, where the result's type does not say them. */
const TAKES = new Map([['length', 'string'], ['octet_length', 'string']]);
const UNREAD = Symbol('a condition the reader does not compare');
const isLiteral = (/** @type {any} */ node) => ['s', 'n', 'b', 'null'].some((key) => Object.hasOwn(node, key));
const keyOf = (/** @type {any} */ node) => JSON.stringify(node);
const byKey = (/** @type {any} */ a, /** @type {any} */ b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);

/**
 * A condition read into one form for every spelling the server keeps of it:
 * `AND` and `OR` operands flattened, deduplicated and in one order; a list —
 * `IN`, `= ANY (ARRAY[…])`, an `OR` of equalities — one membership, and its
 * `NOT IN`, `<> ALL` and `AND` of inequalities one exclusion; a comparison
 * with its literal, or its lesser operand, on the right; `NOT` taken into a
 * comparison, a NULL test and a list; a NULL test spelled `IS [NOT] DISTINCT
 * FROM NULL` the test; a boolean compared with `true` or `false` the boolean
 * or its `NOT`; the server's cast of a column to a wider type of its family
 * the column; a quoted literal beside a number or a boolean the number or the
 * boolean it reads as; a catalog function's `pg_catalog.` prefix dropped.
 * Every rewrite holds for the same rows under SQL's three-valued logic, so
 * two forms differ only where the conditions do — and a literal the server
 * rewrites by its type (a date, a uuid), a type it does not compare, a name
 * that is no column of the table (a qualified one), or a form the expression
 * reader does not read, is no form at all.
 * @param {string} sql
 * @param {boolean} conforming - how the text spells a backslash in a plain string
 * @param {(column: string) => string | undefined} typeOf - a column's catalog type (`format_type`)
 * @returns {any | null} the form, or `null` for a condition it does not compare
 */
export function conditionForm(sql, conforming, typeOf) {
  const read = expressionForm(sql, conforming, true);
  if (read === null) return null;
  const unread = () => { throw UNREAD; };
  /** A column's type, its length or precision dropped. @param {string} column */
  const baseType = (column) => typeOf(column)?.toLowerCase().replace(/\([^)]*\)/g, '');
  /** What a node compares as, `undefined` where that is unknown. @param {any} node @returns {string | undefined} */
  const category = (node) => {
    if (Object.hasOwn(node, 'n')) return 'number';
    if (Object.hasOwn(node, 'b')) return 'boolean';
    if (Object.hasOwn(node, 'id')) return CATEGORIES.get(baseType(node.id) ?? '');
    if (Object.hasOwn(node, 'cast')) return CATEGORIES.get(node.cast);
    if (Object.hasOwn(node, 'collate')) return 'string';
    if (Object.hasOwn(node, 'call')) {
      const returns = RETURNS.get(node.call);
      return returns === null ? node.args.map(category).find((found) => found !== undefined) : returns;
    }
    if (Object.hasOwn(node, 'case')) {
      // the server types a CASE of quoted literals alone as text
      const results = [...node.case.map((/** @type {any[]} */ branch) => branch[1]), ...(node.else ? [node.else] : [])];
      return results.map(category).find((found) => found !== undefined) ?? (results.some((result) => Object.hasOwn(result, 's')) ? 'string' : undefined);
    }
    if (!Object.hasOwn(node, 'op')) return undefined;
    if (node.op === '||') return 'string';
    return /^[-+*/%]$/.test(node.op) ? node.args.map(category).find((/** @type {any} */ found) => found !== undefined) : 'boolean';
  };
  /** A literal as the server reads it beside a value that compares as `as`. @param {any} node @param {string | undefined} as */
  const coerce = (node, as) => {
    if (!Object.hasOwn(node, 's') || as === 'string') return node;
    if (as === 'number') { const n = decimalText(node.s); return n === null ? unread() : { n }; }
    if (as === 'boolean') { const b = BOOLEAN_TEXT.get(node.s.toLowerCase()); return b === undefined ? unread() : { b }; }
    return unread();
  };
  /** Values that compare alike: each quoted literal read beside the rest. @param {any[]} nodes */
  const unify = (nodes) => {
    const as = nodes.map(category).find((found) => found !== undefined) ?? (nodes.every((node) => Object.hasOwn(node, 's') || Object.hasOwn(node, 'null')) ? 'string' : undefined);
    return nodes.map((node) => coerce(node, as));
  };
  /** A boolean compared with one boolean literal is the boolean or its NOT. @param {any} node */
  const boolean = (node) => {
    if ((node.op !== 'in' && node.op !== 'not in') || node.args.length !== 2 || !Object.hasOwn(node.args[1], 'b')) return node;
    return node.args[1].b === (node.op === 'in') ? node.args[0] : negate(node.args[0]);
  };
  /** A membership (`in`) or an exclusion (`not in`) of literals. @param {string} op @param {any} subject @param {any[]} values */
  const membership = (op, subject, values) => {
    if (isLiteral(subject)) return unread();
    const as = category(subject);
    const read = values.map((value) => coerce(value, as));
    if (!read.every(isLiteral)) return unread();
    const unique = [...new Map(read.map((value) => [keyOf(value), value])).values()].sort(byKey);
    return boolean({ op, args: [subject, ...unique] });
  };
  /** @param {any} node @returns {any} */
  const negate = (node) => {
    if (Object.hasOwn(node, 'b')) return { b: !node.b };
    if (Object.hasOwn(node, 'null')) return node;
    if (node.op === 'not') return node.args[0];
    if (NEGATED.has(node.op)) return boolean({ op: NEGATED.get(node.op), args: node.args });
    return { op: 'not', args: [node] };
  };
  /** @param {string} op @param {any} left @param {any} right */
  const comparison = (op, left, right) => {
    if (op === '=' && right.call === 'any' && right.args.length === 1 && Object.hasOwn(right.args[0], 'array'))
      return membership('in', left, right.args[0].array);
    if (op === '<>' && right.call === 'all' && right.args.length === 1 && Object.hasOwn(right.args[0], 'array'))
      return membership('not in', left, right.args[0].array);
    // another quantified comparison holds for what its list's bound does, which is no spelling of one condition
    if (right.call === 'any' || right.call === 'all') return unread();
    const [a, b] = unify([left, right]);
    if ((op === '=' || op === '<>') && isLiteral(a) !== isLiteral(b)) return membership(op === '=' ? 'in' : 'not in', isLiteral(a) ? b : a, [isLiteral(a) ? a : b]);
    const swap = isLiteral(a) ? !isLiteral(b) : !isLiteral(b) && byKey(a, b) > 0;
    return swap ? { op: SWAPPED.get(op), args: [b, a] } : { op, args: [a, b] };
  };
  /** Operands of one `AND` or `OR`, flattened, a list's items gathered, deduplicated, ordered. @param {string} op @param {any[]} args */
  const joined = (op, args) => {
    const flat = args.flatMap((arg) => (arg.op === op ? arg.args : [arg]));
    const gather = op === 'or' ? 'in' : 'not in';
    /** @type {Map<string, any[]>} */
    const lists = new Map();
    const rest = [];
    for (const arg of flat) {
      if (arg.op !== gather) { rest.push(arg); continue; }
      const key = keyOf(arg.args[0]);
      lists.set(key, [...(lists.get(key) ?? [arg.args[0]]), ...arg.args.slice(1)]);
    }
    const all = [...rest, ...[...lists.values()].map(([subject, ...values]) => membership(gather, subject, values))];
    const unique = [...new Map(all.map((arg) => [keyOf(arg), arg])).values()].sort(byKey);
    return unique.length === 1 ? unique[0] : { op, args: unique };
  };
  /** @param {any} node @returns {any} */
  const form = (node) => {
    // a name the table has no column under — a qualified one, which the server never writes — is not compared
    if (Object.hasOwn(node, 'id')) return typeOf(node.id) === undefined ? unread() : node;
    if (isLiteral(node) || Object.hasOwn(node, 'path')) return node;
    if (Object.hasOwn(node, 'array')) return { array: node.array.map(form) };
    if (Object.hasOwn(node, 'collate')) return { collate: node.collate, of: form(node.of) };
    if (Object.hasOwn(node, 'cast')) {
      const of = form(node.cast.endsWith(' []') && Object.hasOwn(node.of, 'array')
        ? { array: node.of.array.map((/** @type {any} */ item) => ({ cast: node.cast.slice(0, -3), of: item })) } : node.of);
      if (Object.hasOwn(of, 'array') && node.cast.endsWith(' []')) return of;
      if (Object.hasOwn(of, 'id') && WIDER.get(baseType(of.id) ?? '')?.includes(node.cast)) return of;
      // a literal the server rewrites by its type (a date, a uuid) is compared by no text
      if (isLiteral(of)) {
        const as = CATEGORIES.get(node.cast);
        return Object.hasOwn(of, 'null') || (as !== undefined && (Object.hasOwn(of, 's') || category(of) === as)) ? coerce(of, as) : unread();
      }
      return { cast: node.cast, of };
    }
    if (Object.hasOwn(node, 'case')) {
      const branches = node.case.map((/** @type {any[]} */ [when, then]) => [form(when), form(then)]);
      const otherwise = node.else === undefined ? [] : [form(node.else)];
      const results = unify([...branches.map((/** @type {any[]} */ branch) => branch[1]), ...otherwise]);
      return { case: branches.map((/** @type {any[]} */ [when], /** @type {number} */ i) => [when, results[i]]),
        ...(node.else === undefined ? {} : { else: results[branches.length] }) };
    }
    if (Object.hasOwn(node, 'call')) {
      const name = node.call.startsWith('pg_catalog.') ? node.call.slice('pg_catalog.'.length) : node.call;
      // the list a quantified comparison reads, which the comparison takes apart
      if (name === 'any' || name === 'all') return { call: name, args: node.args.map(form) };
      if (!RETURNS.has(name)) return unread();
      const args = node.args.map(form);
      const takes = TAKES.get(name) ?? RETURNS.get(name);
      return { call: name, args: takes === null ? unify(args) : args.map((/** @type {any} */ arg) => coerce(arg, takes)) };
    }
    const args = node.args.map(form);
    if (node.op === 'and' || node.op === 'or') return joined(node.op, args);
    if (node.op === 'not') return negate(args[0]);
    if (node.op === 'is null' || node.op === 'is not null') return isLiteral(args[0]) ? unread() : { op: node.op, args };
    if (node.op === 'in' || node.op === 'not in') return args.length === 2 ? comparison(node.op === 'in' ? '=' : '<>', args[0], args[1]) : membership(node.op, args[0], args.slice(1));
    if (node.op === 'distinct' || node.op === 'not distinct') {
      const [a, b] = unify(args);
      if (Object.hasOwn(a, 'null') !== Object.hasOwn(b, 'null')) return { op: node.op === 'distinct' ? 'is not null' : 'is null', args: [Object.hasOwn(a, 'null') ? b : a] };
      return { op: node.op, args: [a, b].sort(byKey) };
    }
    if (COMPARISONS.has(node.op)) return comparison(/** @type {string} */ (COMPARISONS.get(node.op)), args[0], args[1]);
    return { op: node.op, args: unify(args) };
  };
  try { return form(read); }
  catch (error) {
    if (error === UNREAD) return null;
    throw error;
  }
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
   * A stored condition read into the query grammar, or `null` where the
   * reader does not cover it — what introspection derives an index `where` from.
   * @param {string} stored - the deparse
   * @param {{ name: string, physical: string, codec: string }[]} columns - the members it may read
   * @param {boolean} conforming - the reading session's `standard_conforming_strings`
   * @returns {any}
   */
  read: (stored, columns, conforming) =>
    readPredicate(stored, conforming ? POSTGRES_PREDICATE : POSTGRES_PREDICATE_ESCAPED, memberOf(columns)),
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
    const have = postgresReadBack.read(stored, columns, conforming);
    const want = readPredicate(planned, POSTGRES_PREDICATE, memberOf(columns));
    return have !== null && want !== null && JSON.stringify(have) === JSON.stringify(want)
      ? null : `has the condition ${stored}, and the model declares WHERE ${planned}`;
  },
  /**
   * Whether a layout index's stored condition is another condition than the
   * declared one: `true` only where both read into one form
   * ({@link conditionForm}) and the forms differ, so a condition either side
   * does not read is never drift.
   * @param {string} stored - the deparse
   * @param {string} planned - the declared condition, rendered for PostgreSQL
   * @param {(column: string) => string | undefined} typeOf - a column's catalog type
   * @param {boolean} conforming - the reading session's `standard_conforming_strings`
   * @returns {boolean}
   */
  layoutConditionDiffers(stored, planned, typeOf, conforming) {
    const have = conditionForm(stored, conforming, typeOf);
    const want = conditionForm(planned, true, typeOf);
    return have !== null && want !== null && JSON.stringify(have) !== JSON.stringify(want);
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
