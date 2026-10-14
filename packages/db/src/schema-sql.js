//@ts-check
/** Conservative SQLite declaration identity. Quoted bytes are never formatting. */
import { QUOTE, SIMPLE, SPACE, WORD_PART, WORD_START, scannerFor } from './dialects/check-read.js';

/** @typedef {{ kind: string, text: string }} SqlToken */
/** @typedef {{ columnOrder?: 'preserve' | 'ignore' }} DeclaredSqlOptions */

/** @param {string} reason @returns {never} */
function invalid(reason) {
  throw new TypeError(`SQL declaration cannot be compared: ${reason}`);
}

/** SQLite's own lexical grammar, strictly: whitespace excludes Unicode
 * characters and vertical tab, every non-ASCII character is a word character,
 * and text it cannot read is refused rather than guessed at.
 * @type {import('./dialects/check-read.js').SqlGrammar} */
const DECLARATION_GRAMMAR = Object.freeze({
  classOf: (code) => code === 32 || code === 9 || code === 10 || code === 12 || code === 13 ? SPACE
    : code >= 128 || code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122 ? WORD_START | WORD_PART
      : code === 39 || code === 34 || code === 96 || code === 91 ? QUOTE
        : code === 36 || code >= 48 && code <= 57 ? WORD_PART : '(),.;+*/%~&'.includes(String.fromCharCode(code)) ? SIMPLE : 0,
  blob: true,
  number: /(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?)/y,
  closedNumbers: true,
  symbol: /->>|->|\|\||<<|>>|<=|>=|==|!=|<>|[(),.;+*/%~&|=<>-]/y,
  nulAnywhere: false,
  declaration: true,
  refuse: invalid,
});

const scanDeclaration = scannerFor(DECLARATION_GRAMMAR);

/** Lex before discarding comments or whitespace; retain each quoted token raw.
 * @param {string} sql @returns {SqlToken[]} */
function tokensOf(sql) {
  if (typeof sql !== 'string') invalid('text is required');
  return scanDeclaration(sql);
}

/** @param {SqlToken | undefined} token @param {string} word */
const isWord = (token, word) => token?.kind === 'word' && token.text.toUpperCase() === word;

/** Remove only the CREATE prefix clause SQLite omits from its catalog.
 * @param {SqlToken[]} tokens @returns {SqlToken[]} */
function withoutExistenceClause(tokens) {
  if (!isWord(tokens[0], 'CREATE')) return tokens;
  let at = 1;
  if (isWord(tokens[at], 'TEMP') || isWord(tokens[at], 'TEMPORARY')) at++;
  if (isWord(tokens[at], 'UNIQUE') || isWord(tokens[at], 'VIRTUAL')) at++;
  if (!['TABLE', 'INDEX', 'TRIGGER', 'VIEW'].some((word) => isWord(tokens[at], word))) return tokens;
  at++;
  return isWord(tokens[at], 'IF') && isWord(tokens[at + 1], 'NOT') && isWord(tokens[at + 2], 'EXISTS')
    ? [...tokens.slice(0, at), ...tokens.slice(at + 3)] : tokens;
}

/** Stable whitespace between tokens; punctuation cannot join words/operators.
 * @param {SqlToken[]} tokens @returns {string} */
function render(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], previous = tokens[i - 1];
    const tight = token.kind === 'symbol' && ['(', ')', ','].includes(token.text)
      || previous?.kind === 'symbol' && ['(', ')', ','].includes(previous.text);
    out += (i === 0 || tight ? '' : ' ') + token.text;
  }
  return out;
}

/** Reorder named columns without reordering anything order-sensitive: a column
 * with an order-sensitive inline clause keeps its place RELATIVE to the other
 * such columns, and the plain columns around them sort freely — so a column a
 * migration appended (`ADD COLUMN` lands after the document) compares equal to
 * a fresh build, while two swapped foreign keys or checks never do. Table
 * constraints and every token inside a definition retain their order.
 * Unrecognized table shapes keep strict order rather than guessing equivalence.
 * @param {SqlToken[]} tokens @returns {SqlToken[]} */
function namedColumnOrder(tokens) {
  if (!isWord(tokens[0], 'CREATE')) return tokens;
  let at = 1;
  if (isWord(tokens[at], 'TEMP') || isWord(tokens[at], 'TEMPORARY')) at++;
  if (!isWord(tokens[at++], 'TABLE')) return tokens;
  const name = (/** @type {SqlToken | undefined} */ token) => token?.kind === 'word' || token?.kind === 'identifier';
  if (!name(tokens[at++])) return tokens;
  if (tokens[at]?.text === '.') {
    at++;
    if (!name(tokens[at++])) return tokens;
  }
  if (tokens[at]?.text !== '(') return tokens;
  const open = at++;
  /** @type {SqlToken[][]} */
  const items = [];
  let start = at, depth = 0, close = -1;
  for (; at < tokens.length; at++) {
    const token = tokens[at];
    if (token.kind !== 'symbol') continue;
    if (token.text === '(') depth++;
    else if (token.text === ')') {
      if (depth === 0) { items.push(tokens.slice(start, at)); close = at; break; }
      depth--;
    }
    else if (token.text === ',' && depth === 0) { items.push(tokens.slice(start, at)); start = at + 1; }
  }
  if (close < 0 || items.some((item) => item.length === 0)) return tokens;
  const constraint = (/** @type {SqlToken[]} */ item) => ['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN']
    .some((word) => isWord(item[0], word));
  const firstConstraint = items.findIndex(constraint);
  const split = firstConstraint < 0 ? items.length : firstConstraint;
  const columns = items.slice(0, split), constraints = items.slice(split);
  if (constraints.some((item) => !constraint(item)) || columns.some((item) => !name(item[0]))) return tokens;
  // Default evaluation and check/conflict/cascade order can change values,
  // errors or surviving rows even when every access names its columns: those
  // columns keep their relative order. A plain column evaluates nothing, so
  // where it sits among them changes nothing a by-name access can observe.
  const ordered = (/** @type {SqlToken[]} */ item) => item.slice(1).some((token) =>
    ['DEFAULT', 'CHECK', 'UNIQUE', 'REFERENCES', 'COLLATE', 'CONFLICT'].some((word) => isWord(token, word)));
  const plain = columns.filter((item) => !ordered(item)).sort((a, b) => {
    const left = render(a), right = render(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const reordered = [...columns.filter(ordered), ...plain, ...constraints];
  return [...tokens.slice(0, open + 1), ...reordered.flatMap((item, i) =>
    i === 0 ? item : [{ kind: 'symbol', text: ',' }, ...item]), ...tokens.slice(close)];
}

/** A conservative declaration identity, preserving physical column order by default.
 * `ignore` is for managed tables whose consumers address columns by name. Index,
 * trigger and table-constraint order is always preserved; columns with
 * order-sensitive inline constraints keep their order relative to each other,
 * and unfamiliar table structures retain strict column order.
 * Quoted bytes are exact. Comments and ordinary token whitespace are formatting.
 * @param {string} sql
 * @param {DeclaredSqlOptions} [options]
 * @returns {string}
 * @throws {TypeError} for malformed/unsupported lexical input or policy
 */
export function comparableDeclaredSql(sql, options = {}) {
  const columnOrder = options.columnOrder ?? 'preserve';
  if (!['preserve', 'ignore'].includes(columnOrder)) invalid('unknown columnOrder policy');
  const tokens = withoutExistenceClause(tokensOf(sql));
  return render(columnOrder === 'ignore' ? namedColumnOrder(tokens) : tokens);
}

/** Normalize formatting only, through the declaration comparison owner.
 * @param {string} sql @returns {string} */
export function normalizeDeclaredSql(sql) {
  return comparableDeclaredSql(sql);
}
