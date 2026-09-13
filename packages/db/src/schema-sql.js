//@ts-check
/** Conservative SQLite declaration identity. Quoted bytes are never formatting. */

/** @typedef {{ kind: string, text: string }} SqlToken */
/** @typedef {{ columnOrder?: 'preserve' | 'ignore' }} DeclaredSqlOptions */

/** @param {string} reason @returns {never} */
function invalid(reason) {
  throw new TypeError(`SQL declaration cannot be compared: ${reason}`);
}

/** SQLite whitespace excludes Unicode identifier characters and vertical tab. */
const whitespace = (/** @type {number} */ code) => code === 32 || code === 9
  || code === 10 || code === 12 || code === 13;
const wordStart = (/** @type {number} */ code) => code >= 128 || code === 95
  || code >= 65 && code <= 90 || code >= 97 && code <= 122;
const wordPart = (/** @type {number} */ code) => wordStart(code) || code === 36
  || code >= 48 && code <= 57;

/** Lex before discarding comments or whitespace; retain each quoted token raw.
 * @param {string} sql @returns {SqlToken[]} */
function tokensOf(sql) {
  if (typeof sql !== 'string') invalid('text is required');
  /** @type {SqlToken[]} */
  const tokens = [];
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    const start = i, c = sql[i];
    if (whitespace(sql.charCodeAt(i))) { i++; continue; }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) invalid('unterminated comment');
      i = end + 2;
      continue;
    }
    const blob = (c === 'x' || c === 'X') && sql[i + 1] === "'";
    if (blob) i++;
    const quote = sql[i];
    if (blob || quote === "'" || quote === '"' || quote === '`' || quote === '[') {
      const close = quote === '[' ? ']' : quote;
      let closed = false;
      for (i++; i < sql.length; i++) {
        if (sql.charCodeAt(i) === 0) invalid('NUL in quoted text');
        if (sql[i] !== close) continue;
        if (quote !== '[' && sql[i + 1] === close) { i++; continue; }
        i++; closed = true; break;
      }
      if (!closed) invalid('unterminated quoted token');
      const text = sql.slice(start, i);
      if (blob && !/^[xX]'(?:[0-9a-fA-F]{2})*'$/.test(text)) invalid('invalid blob literal');
      tokens.push({ kind: blob ? 'blob' : quote === "'" ? 'string' : 'identifier', text });
      continue;
    }
    if (wordStart(sql.charCodeAt(i))) {
      while (++i < sql.length && wordPart(sql.charCodeAt(i))) { /* whole identifier */ }
      tokens.push({ kind: 'word', text: sql.slice(start, i) });
      continue;
    }
    const number = /^(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?)/.exec(sql.slice(i));
    if (number !== null) {
      tokens.push({ kind: 'number', text: number[0] });
      i += number[0].length;
      if (wordPart(sql.charCodeAt(i)) || sql[i] === '.') invalid('invalid numeric token');
      continue;
    }
    const operator = /^(?:->>|->|\|\||<<|>>|<=|>=|==|!=|<>|[(),.;+*/%~&|=<>-])/.exec(sql.slice(i));
    if (operator === null) invalid(`unsupported token at ${i}`);
    const text = operator[0];
    if (text === '(') depth++;
    else if (text === ')' && --depth < 0) invalid('unbalanced parentheses');
    tokens.push({ kind: 'symbol', text });
    i += text.length;
  }
  if (depth !== 0) invalid('unbalanced parentheses');
  if (tokens.length === 0) invalid('empty declaration');
  return tokens;
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

/** Reorder only ordinary named columns with no order-sensitive inline clauses.
 * Table constraints and every token inside a definition retain their order.
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
  // errors or surviving rows even when every access names its columns.
  if (columns.some((item) => item.slice(1).some((token) =>
    ['DEFAULT', 'CHECK', 'UNIQUE', 'REFERENCES', 'COLLATE', 'CONFLICT'].some((word) => isWord(token, word))))) return tokens;
  columns.sort((a, b) => {
    const left = render(a), right = render(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const reordered = [...columns, ...constraints];
  return [...tokens.slice(0, open + 1), ...reordered.flatMap((item, i) =>
    i === 0 ? item : [{ kind: 'symbol', text: ',' }, ...item]), ...tokens.slice(close)];
}

/** A conservative declaration identity, preserving physical column order by default.
 * `ignore` is for managed tables whose consumers address columns by name. Index,
 * trigger and table-constraint order is always preserved; order-sensitive inline
 * constraints and unfamiliar table structures retain strict column order too.
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
