//@ts-check
/** SQLite trigger programs read back as declared database rules
 * (MODEL-FORMAT §13.6). A narrow reader, not a SQL engine: it reads the
 * CREATE text of an application trigger and answers the rule the trigger
 * is exactly equal to — an unconditional guard, a guard over the row's own
 * columns, an `UPDATE OF` guard, a guard that probes another table by its
 * columns, or a revision bump — or the first construct it does not map. A
 * condition keeps SQLite's three-valued logic: each one is read into the
 * two-valued formulas that say when it is true and when it is false, and
 * the rule refuses exactly where the trigger's condition is true. */
import { sqlTokens } from './check-read.js';
import { foldIdentifier as fold } from '../invariants.js';
import { modelPath } from '../model-path.js';

/** What the reader cannot map: thrown inside, answered as a reason. */
class Unmapped {
  /** @param {string} reason */
  constructor(reason) { this.reason = reason; }
}
/** @param {string} reason @returns {never} */
const unmapped = (reason) => { throw new Unmapped(reason); };

/** The column codecs a rule compares, by the column type that reads back as each. */
const CODECS = new Map([['TEXT', 'text'], ['INTEGER', 'integer'], ['REAL', 'number']]);
const COMPARISONS = new Map([['=', '$eq'], ['==', '$eq'], ['<>', '$ne'], ['!=', '$ne'], ['<', '$lt'], ['<=', '$le'], ['>', '$gt'], ['>=', '$ge']]);
const OPPOSITE = new Map([['$eq', '$ne'], ['$ne', '$eq'], ['$lt', '$ge'], ['$ge', '$lt'], ['$gt', '$le'], ['$le', '$gt']]);
const MIRRORED = new Map([['$eq', '$eq'], ['$ne', '$ne'], ['$lt', '$gt'], ['$gt', '$lt'], ['$le', '$ge'], ['$ge', '$le']]);
/** Two-character operators the catalog scanner reads as two symbols. */
const PAIRS = new Set(['<>', '<=', '>=', '==', '!=', '||', '<<', '>>', '->']);
const NAMED_REASONS = new Map([
  ['CASE', 'a CASE expression'], ['LIKE', 'a LIKE pattern'], ['GLOB', 'a GLOB pattern'], ['REGEXP', 'a REGEXP pattern'],
  ['MATCH', 'a MATCH search'], ['BETWEEN', 'a BETWEEN range'], ['COLLATE', 'a COLLATE clause'], ['CAST', 'a CAST'],
  ['ISNULL', 'the ISNULL spelling'], ['NOTNULL', 'the NOTNULL spelling'], ['ESCAPE', 'a LIKE pattern'],
  ['TRUE', 'a boolean literal'], ['FALSE', 'a boolean literal'], ['DISTINCT', 'an IS DISTINCT FROM test'],
  ['CURRENT_TIME', 'the current time'], ['CURRENT_DATE', 'the current time'], ['CURRENT_TIMESTAMP', 'the current time'],
]);
const AGGREGATES = new Set(['COUNT', 'SUM', 'TOTAL', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'STRING_AGG']);

/**
 * The catalog tokens of a trigger's text, a bracket-quoted identifier read as
 * one and the two-character operators joined; `null` for text the scanner
 * does not read.
 * @param {string} sql
 * @returns {{ kind: string, value: string, at: number }[] | null}
 */
function tokensOf(sql) {
  const tokens = sqlTokens(sql, (text, at) => {
    if (text[at] === '[') {
      const end = text.indexOf(']', at + 1);
      return end < 0 ? null : { kind: 'identifier', value: text.slice(at + 1, end), end: end + 1 };
    }
    // a blob literal is a value no rule codec holds
    if ((text[at] === 'x' || text[at] === 'X') && text[at + 1] === "'") {
      const end = text.indexOf("'", at + 2);
      return end < 0 ? null : { kind: 'blob', value: '', end: end + 1 };
    }
    return undefined;
  });
  if (tokens.length === 0) return null;
  const out = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    if (token.kind === 'symbol' && last?.kind === 'symbol' && last.at + last.value.length === token.at
      && PAIRS.has(last.value + token.value)) { out[out.length - 1] = { ...last, value: last.value + token.value }; continue; }
    out.push(token);
  }
  return out;
}

/** A cursor over the tokens, keywords compared case folded. @param {{ kind: string, value: string, at: number }[]} tokens */
function cursorOver(tokens) {
  let at = 0;
  const peek = (offset = 0) => tokens[at + offset];
  /** @param {any} token @param {string} word */
  const isWord = (token, word) => token !== undefined && token.kind === 'word' && token.value.toUpperCase() === word;
  /** @param {any} token @param {string} symbol */
  const isSymbol = (token, symbol) => token !== undefined && token.kind === 'symbol' && token.value === symbol;
  return {
    peek, isWord, isSymbol,
    get at() { return at; },
    set at(value) { at = value; },
    next: () => tokens[at++],
    /** @param {string} word */
    word: (word) => (isWord(tokens[at], word) ? (at++, true) : false),
    /** @param {string} symbol */
    symbol: (symbol) => (isSymbol(tokens[at], symbol) ? (at++, true) : false),
    /** @param {string} symbol @param {string} reason */
    expect(symbol, reason) { if (!isSymbol(tokens[at], symbol)) unmapped(reason); at++; },
    /** An identifier: a word or a quoted one. @param {string} reason */
    name(reason) {
      const token = tokens[at];
      if (token === undefined || (token.kind !== 'word' && token.kind !== 'identifier')) unmapped(reason);
      at++;
      return token.value;
    },
    done: () => at >= tokens.length,
  };
}

/** The reason a token starts no operand the reader maps. @param {any} token @param {any} after */
function constructOf(token, after) {
  if (token === undefined) return 'an incomplete condition';
  if (token.kind === 'blob') return 'a blob literal';
  if (token.kind === 'identifier' && after?.kind === 'symbol' && after.value === '(') return `a function call ('${token.value}')`;
  if (token.kind === 'word') {
    const word = token.value.toUpperCase();
    if (NAMED_REASONS.has(word)) return /** @type {string} */ (NAMED_REASONS.get(word));
    if (after?.kind === 'symbol' && after.value === '(') return AGGREGATES.has(word) ? 'an aggregate over other rows' : `a function call ('${token.value}')`;
    if (word === 'RAISE') return 'a RAISE inside a condition';
    if (word === 'SELECT') return 'a subquery outside a comparison or EXISTS';
  }
  if (token.kind === 'symbol') {
    if (['+', '-', '*', '/', '%'].includes(token.value)) return 'arithmetic';
    if (token.value === '||') return 'a string concatenation';
    if (token.value === '?' || token.value === ':' || token.value === '@') return 'a bound parameter';
  }
  return `the construct '${token.value}'`;
}

/**
 * Read a trigger's CREATE text into its parts: its name, timing, event,
 * `UPDATE OF` columns, table, condition and its one statement.
 * @param {string} sql
 * @returns {any}
 */
function parseTrigger(sql) {
  const tokens = tokensOf(sql);
  if (tokens === null) unmapped('a trigger text the reader cannot tokenize');
  const c = cursorOver(tokens);
  if (!c.word('CREATE')) unmapped('a text that is not a CREATE TRIGGER statement');
  if (c.word('TEMP') || c.word('TEMPORARY')) unmapped('a temporary trigger');
  if (!c.word('TRIGGER')) unmapped('a text that is not a CREATE TRIGGER statement');
  if (c.word('IF')) { if (!c.word('NOT') || !c.word('EXISTS')) unmapped('an unreadable trigger header'); }
  let name = c.name('an unreadable trigger name');
  if (c.symbol('.')) name = c.name('an unreadable trigger name');
  let timing = 'before';
  if (c.word('BEFORE')) timing = 'before';
  else if (c.word('AFTER')) timing = 'after';
  else if (c.word('INSTEAD')) unmapped('an INSTEAD OF trigger, which writes a view');
  const event = c.next();
  const op = event === undefined ? '' : event.value.toUpperCase();
  if (event?.kind !== 'word' || !['INSERT', 'UPDATE', 'DELETE'].includes(op)) unmapped('an unreadable trigger event');
  /** @type {string[] | null} */
  let of = null;
  if (op === 'UPDATE' && c.word('OF')) {
    of = [c.name('an unreadable UPDATE OF column')];
    while (c.symbol(',')) of.push(c.name('an unreadable UPDATE OF column'));
  }
  if (!c.word('ON')) unmapped('an unreadable trigger header');
  const table = c.name('an unreadable trigger table');
  if (c.symbol('.')) unmapped('a trigger on a table of another schema');
  if (c.word('FOR')) { if (!c.word('EACH') || !c.word('ROW')) unmapped('an unreadable FOR EACH clause'); }
  let when = null;
  if (c.word('WHEN')) when = parseCondition(c, (token) => c.isWord(token, 'BEGIN'));
  if (!c.word('BEGIN')) unmapped('an unreadable trigger header');
  const last = tokens[tokens.length - 1];
  if (!c.isWord(last, 'END')) unmapped('an unreadable trigger program');
  /** @type {{ kind: string, value: string, at: number }[][]} */
  const statements = [];
  let current = [], depth = 0;
  for (let i = c.at; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (token.kind === 'symbol' && token.value === '(') depth++;
    if (token.kind === 'symbol' && token.value === ')') depth--;
    if (depth === 0 && token.kind === 'symbol' && token.value === ';') { if (current.length > 0) statements.push(current); current = []; continue; }
    current.push(token);
  }
  if (current.length > 0) statements.push(current);
  if (statements.length === 0) unmapped('an empty trigger program');
  if (statements.length > 1) unmapped('a trigger program with more than one statement');
  return { name, timing, op: op.toLowerCase(), of, table, when, statement: parseStatement(statements[0]) };
}

/** The one statement of a trigger's program: a RAISE, or an UPDATE of a row.
 * @param {{ kind: string, value: string, at: number }[]} tokens */
function parseStatement(tokens) {
  const c = cursorOver(tokens);
  if (c.word('SELECT')) {
    if (c.isWord(c.peek(), 'CASE')) unmapped('a CASE expression');
    if (!c.word('RAISE')) unmapped('a SELECT that is not a RAISE');
    c.expect('(', 'an unreadable RAISE');
    const kind = c.next();
    const word = kind?.kind === 'word' ? kind.value.toUpperCase() : '';
    if (word === 'IGNORE') unmapped('RAISE(IGNORE), which skips the row instead of refusing the write');
    if (word === 'FAIL' || word === 'ROLLBACK') unmapped(`RAISE(${word}), which keeps or undoes other writes as RAISE(ABORT) does not`);
    if (word !== 'ABORT') unmapped('an unreadable RAISE');
    c.expect(',', 'an unreadable RAISE');
    const message = c.next();
    if (message?.kind !== 'string') unmapped('a RAISE message that is not one text literal');
    c.expect(')', 'a RAISE message that is not one text literal');
    let where = null;
    if (c.word('FROM')) unmapped('a RAISE selected from a table');
    if (c.word('WHERE')) where = parseCondition(c, (token) => token === undefined);
    if (!c.done()) unmapped(constructOf(c.peek(), c.peek(1)));
    return { kind: 'raise', message: message.value, where };
  }
  if (c.word('UPDATE')) {
    if (c.word('OR')) unmapped('an UPDATE with a conflict clause');
    const table = c.name('an unreadable UPDATE');
    if (!c.word('SET')) unmapped('an unreadable UPDATE');
    const column = c.name('an unreadable UPDATE');
    if (c.symbol(',')) unmapped('an UPDATE that sets more than one column');
    c.expect('=', 'an unreadable UPDATE');
    const record = c.next();
    const dot = c.next();
    const read = c.next();
    const plus = c.next();
    const one = c.next();
    if (!(c.isWord(record, 'OLD') || c.isWord(record, 'NEW')) || !c.isSymbol(dot, '.') || read === undefined
      || (read.kind !== 'word' && read.kind !== 'identifier') || !c.isSymbol(plus, '+') || one?.kind !== 'number' || one.value !== '1')
      unmapped('an UPDATE that does not set a column to its old value plus one');
    const from = { kind: 'ref', record: record.value.toLowerCase(), column: read.value };
    if (c.symbol(',')) unmapped('an UPDATE that sets more than one column');
    if (!c.word('WHERE')) unmapped('an UPDATE of every row of a table');
    /** @type {{ column: string, ref: any }[]} */
    const where = [];
    do {
      const left = c.peek();
      const reversed = c.isWord(left, 'NEW') || c.isWord(left, 'OLD');
      const ref = reversed ? operand(c) : null;
      const name = c.name('an UPDATE of rows other than the new row by its key');
      if (c.symbol('.')) unmapped('an UPDATE of rows other than the new row by its key');
      if (!c.symbol('=') && !c.symbol('==')) unmapped('an UPDATE of rows other than the new row by its key');
      if (reversed) { where.push({ column: name, ref }); continue; }
      const value = c.isWord(c.peek(), 'NEW') || c.isWord(c.peek(), 'OLD') ? operand(c) : unmapped('an UPDATE of rows other than the new row by its key');
      where.push({ column: name, ref: value });
    } while (c.word('AND'));
    if (!c.done()) unmapped('an UPDATE of rows other than the new row by its key');
    return { kind: 'update', table, column, from, where };
  }
  const first = tokens[0];
  if (c.isWord(first, 'INSERT') || c.isWord(first, 'DELETE') || c.isWord(first, 'REPLACE'))
    unmapped(`a program that writes rows (${first.value.toUpperCase()})`);
  if (c.isWord(first, 'WITH')) unmapped('a common table expression');
  return unmapped(`a program statement that is not a RAISE (${first.value})`);
}

/**
 * A condition: OR of ANDs of NOT of comparisons, up to a token `stop` says
 * ends it.
 * @param {ReturnType<typeof cursorOver>} c @param {(token: any) => boolean} stop
 * @returns {any}
 */
function parseCondition(c, stop) {
  const node = disjunction(c);
  if (!stop(c.peek())) unmapped(constructOf(c.peek(), c.peek(1)));
  return node;
}

/** @param {ReturnType<typeof cursorOver>} c */
function disjunction(c) {
  const items = [conjunction(c)];
  while (c.word('OR')) items.push(conjunction(c));
  return items.length === 1 ? items[0] : { kind: 'or', items };
}

/** @param {ReturnType<typeof cursorOver>} c */
function conjunction(c) {
  const items = [negation(c)];
  while (c.word('AND')) items.push(negation(c));
  return items.length === 1 ? items[0] : { kind: 'and', items };
}

/** @param {ReturnType<typeof cursorOver>} c @returns {any} */
function negation(c) {
  if (c.word('NOT')) return { kind: 'not', item: negation(c) };
  if (c.word('EXISTS')) return { kind: 'exists', probe: subquery(c, false) };
  // a parenthesized condition, unless it is a scalar subquery operand
  if (c.isSymbol(c.peek(), '(') && !c.isWord(c.peek(1), 'SELECT')) {
    const start = c.at;
    c.next();
    const inner = disjunction(c);
    if (c.symbol(')')) {
      // a parenthesized operand compared after it is not a condition
      if (!startsComparison(c)) return inner;
    }
    c.at = start;
  }
  return comparison(c);
}

/** @param {ReturnType<typeof cursorOver>} c */
const startsComparison = (c) => {
  const token = c.peek();
  return token !== undefined && ((token.kind === 'symbol' && COMPARISONS.has(token.value))
    || c.isWord(token, 'IS') || c.isWord(token, 'IN') || (c.isWord(token, 'NOT') && c.isWord(c.peek(1), 'IN')));
};

/** @param {ReturnType<typeof cursorOver>} c @returns {any} */
function comparison(c) {
  const left = operand(c);
  const token = c.peek();
  if (token?.kind === 'symbol' && COMPARISONS.has(token.value)) {
    c.next();
    return { kind: 'compare', op: COMPARISONS.get(token.value), left, right: operand(c) };
  }
  if (c.word('IS')) {
    const not = c.word('NOT');
    if (c.isWord(c.peek(), 'DISTINCT')) unmapped('an IS DISTINCT FROM test');
    return { kind: 'is', not, left, right: operand(c) };
  }
  const notIn = c.isWord(token, 'NOT') && c.isWord(c.peek(1), 'IN');
  if (notIn) c.next();
  if (c.word('IN')) {
    c.expect('(', 'an IN over a table or a subquery');
    if (c.isWord(c.peek(), 'SELECT')) unmapped('an IN over a subquery');
    const items = [operand(c)];
    while (c.symbol(',')) items.push(operand(c));
    c.expect(')', 'an unreadable IN list');
    return { kind: 'in', not: notIn, left, items };
  }
  if (c.isWord(token, 'NOT')) {
    const after = c.peek(1);
    unmapped(constructOf(after, c.peek(2)));
  }
  return unmapped(token === undefined || stopWords(c, token) ? 'a column read as a truth value' : constructOf(token, c.peek(1)));
}

/** A keyword that ends a condition, where a bare operand would stand alone. @param {any} c @param {any} token */
const stopWords = (c, token) => ['AND', 'OR', 'BEGIN', 'THEN'].some((word) => c.isWord(token, word)) || c.isSymbol(token, ')');

/**
 * An operand: `NEW.<column>`, `OLD.<column>`, a literal, NULL, or a scalar
 * subquery that reads one column of another row.
 * @param {ReturnType<typeof cursorOver>} c @returns {any}
 */
function operand(c) {
  const token = c.peek();
  if (token === undefined) return unmapped('an incomplete condition');
  if (c.isSymbol(token, '(')) {
    if (!c.isWord(c.peek(1), 'SELECT')) unmapped('a parenthesized operand');
    return { kind: 'subquery', probe: subquery(c, true) };
  }
  if (c.isSymbol(token, '-') && c.peek(1)?.kind === 'number') { c.next(); return number(c.next().value, true); }
  if (token.kind === 'number') { c.next(); return number(token.value, false); }
  if (token.kind === 'string') { c.next(); return { kind: 'literal', value: token.value }; }
  if (c.isWord(token, 'NULL')) { c.next(); return { kind: 'null' }; }
  if ((c.isWord(token, 'NEW') || c.isWord(token, 'OLD')) && c.isSymbol(c.peek(1), '.')) {
    c.next(); c.next();
    const column = c.peek();
    if (column === undefined || (column.kind !== 'word' && column.kind !== 'identifier')) unmapped(`an unreadable ${token.value.toUpperCase()} reference`);
    c.next();
    if (c.isSymbol(c.peek(), '.')) unmapped('a qualified column reference');
    const ref = { kind: 'ref', record: token.value.toLowerCase(), column: column.value };
    refuseFollowing(c);
    return ref;
  }
  if ((token.kind === 'word' || token.kind === 'identifier') && !c.isSymbol(c.peek(1), '(')
    && !NAMED_REASONS.has(token.value.toUpperCase()) && token.kind !== 'blob') {
    if (c.isSymbol(c.peek(1), '.')) unmapped('a column of a table the trigger does not name as NEW or OLD');
    if (token.kind === 'identifier' || !['SELECT', 'RAISE'].includes(token.value.toUpperCase()))
      unmapped('a column outside NEW and OLD');
  }
  return unmapped(constructOf(token, c.peek(1)));
}

/** An operand followed by arithmetic or a COLLATE is no operand the reader maps. @param {ReturnType<typeof cursorOver>} c */
function refuseFollowing(c) {
  const token = c.peek();
  if (token?.kind === 'symbol' && ['+', '-', '*', '/', '%', '||', '&', '|', '<<', '>>', '->'].includes(token.value))
    unmapped(constructOf(token, undefined));
  if (c.isWord(token, 'COLLATE')) unmapped('a COLLATE clause');
}

/** A numeric literal: an integer or a finite real. @param {string} text @param {boolean} negative */
function number(text, negative) {
  const value = Number(text) * (negative ? -1 : 1);
  if (!Number.isFinite(value)) unmapped('a numeric literal past the range of a double');
  const integral = /^[0-9]+$/.test(text);
  if (integral && !Number.isSafeInteger(value)) unmapped('an integer literal past ±(2^53 − 1)');
  return { kind: 'literal', value, integral };
}

/**
 * A subquery over another table: `SELECT <column> FROM <table> WHERE
 * <column> = <value> AND …` (a scalar operand) or `SELECT 1|*|<column> …`
 * (under EXISTS), parentheses included.
 * @param {ReturnType<typeof cursorOver>} c @param {boolean} scalar @returns {any}
 */
function subquery(c, scalar) {
  c.expect('(', 'an EXISTS without a subquery');
  if (!c.word('SELECT')) unmapped('an EXISTS without a subquery');
  if (c.isWord(c.peek(), 'DISTINCT') || c.isWord(c.peek(), 'ALL')) unmapped('a SELECT DISTINCT subquery');
  let column = null;
  const head = c.peek();
  if (head !== undefined && (head.kind === 'word' || head.kind === 'identifier') && c.isSymbol(c.peek(1), '('))
    unmapped(constructOf(head, c.peek(1)));
  if (scalar) column = c.name('a subquery that reads no column');
  else if (c.symbol('*')) column = null;
  else if (head?.kind === 'number') c.next();
  else column = c.name('an unreadable EXISTS subquery');
  if (c.symbol(',')) unmapped('a subquery that reads more than one column');
  if (c.symbol('.')) unmapped('a qualified column in a subquery');
  if (!c.word('FROM')) unmapped('a subquery over no table');
  const table = c.name('an unreadable subquery table');
  if (c.symbol('.')) unmapped('a subquery over a table of another schema');
  if (c.symbol(',') || c.isWord(c.peek(), 'JOIN') || c.isWord(c.peek(), 'LEFT') || c.isWord(c.peek(), 'INNER')
    || c.isWord(c.peek(), 'CROSS') || c.isWord(c.peek(), 'NATURAL')) unmapped('a subquery over more than one table');
  if (c.word('AS') || (c.peek()?.kind === 'word' && !c.isWord(c.peek(), 'WHERE'))) unmapped('a subquery with a table alias');
  if (!c.word('WHERE')) unmapped('a subquery that reads every row of a table');
  /** @type {{ column: string, value: any }[]} */
  const terms = [];
  do {
    const left = c.peek();
    if (left === undefined || c.isSymbol(left, '(')) unmapped('a subquery condition other than equalities joined by AND');
    let target = null, value;
    if ((left.kind === 'word' || left.kind === 'identifier') && !c.isWord(left, 'NEW') && !c.isWord(left, 'OLD')
      && !c.isSymbol(c.peek(1), '(') && !NAMED_REASONS.has(left.value.toUpperCase())) {
      c.next();
      if (c.symbol('.')) unmapped('a qualified column in a subquery');
      target = left.value;
      if (!c.symbol('=') && !c.symbol('==')) unmapped('a subquery condition other than equalities joined by AND');
      value = operand(c);
    }
    else {
      value = operand(c);
      if (!c.symbol('=') && !c.symbol('==')) unmapped('a subquery condition other than equalities joined by AND');
      target = c.name('a subquery condition other than equalities joined by AND');
      if (c.symbol('.')) unmapped('a qualified column in a subquery');
    }
    if (value.kind === 'subquery') unmapped('a nested subquery');
    if (value.kind === 'null') unmapped('a subquery equality with NULL, which matches no row');
    refuseFollowing(c);
    terms.push({ column: target, value });
  } while (c.word('AND'));
  if (c.word('OR')) unmapped('a subquery condition other than equalities joined by AND');
  for (const word of ['GROUP', 'ORDER', 'LIMIT', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT'])
    if (c.isWord(c.peek(), word)) unmapped(`a subquery with ${word}`);
  c.expect(')', 'a subquery condition other than equalities joined by AND');
  return { table, column, terms };
}

/**
 * What a table offers a rule: its columns with their codecs and nullability,
 * its key, the column sets that hold one row at most, whether any text of it
 * compares under a collation other than BINARY, and its row id alias.
 * @param {any} table @returns {any}
 */
export function triggerTableFacts(table) {
  const tokens = tokensOf(String(table.sql ?? '')) ?? [];
  const words = tokens.filter((token) => token.kind === 'word').map((token) => token.value.toUpperCase());
  const collated = tokens.some((token, i) => token.kind === 'word' && token.value.toUpperCase() === 'COLLATE'
    && (tokens[i + 1]?.value ?? '').toUpperCase() !== 'BINARY');
  const withoutRowid = words.some((word, i) => word === 'WITHOUT' && words[i + 1] === 'ROWID');
  const keys = table.primaryKey ?? [];
  const typeOf = (/** @type {string} */ name) => String(table.columns.find((/** @type {any} */ c) => c.name === name)?.type ?? '').toUpperCase();
  const rowid = !withoutRowid && keys.length === 1 && typeOf(keys[0]) === 'INTEGER' ? keys[0] : null;
  const columns = new Map(table.columns.map((/** @type {any} */ column) => [fold(column.name), {
    name: column.name, codec: CODECS.get(String(column.type).toUpperCase()) ?? null,
    nullable: column.nullable && column.name !== rowid, generated: column.generated === true,
  }]));
  const unique = [keys, ...table.indexes.filter((/** @type {any} */ index) => index.unique && !index.partial
    && index.columns.every((/** @type {any} */ name) => name !== null)).map((/** @type {any} */ index) => index.columns)]
    .filter((set) => set.length > 0);
  return { name: table.name, columns, keys, unique, collated, rowid };
}

/** A member path into the row the rule judges. @param {string} record @param {string} member */
const pathOf = (record, member) => modelPath([{ name: record }, { name: member }]);

/** A text literal as the query language reads it: one that starts with `$` is written `$$`. @param {any} value */
const literalOf = (value) => (typeof value === 'string' && value.startsWith('$') ? `$${value}` : value);

/** @param {any[]} items @returns {any} */
function and(items) {
  const out = [];
  for (const item of items) {
    if (item === false) return false;
    if (item === true) continue;
    if (item?.$and !== undefined) out.push(...item.$and); else out.push(item);
  }
  return out.length === 0 ? true : out.length === 1 ? out[0] : { $and: out };
}

/** @param {any[]} items @returns {any} */
function or(items) {
  const out = [];
  for (const item of items) {
    if (item === true) return true;
    if (item === false) continue;
    if (item?.$or !== undefined) out.push(...item.$or); else out.push(item);
  }
  return out.length === 0 ? false : out.length === 1 ? out[0] : { $or: out };
}

/** Negation in the rule's two-valued logic, where every leaf is true or false: pushed through
 * `$and` and `$or`, and an equality turned into its inequality. @param {any} node @returns {any} */
function not(node) {
  if (node === true) return false;
  if (node === false) return true;
  if (node.$not !== undefined) return node.$not;
  if (node.$and !== undefined) return or(node.$and.map(not));
  if (node.$or !== undefined) return and(node.$or.map(not));
  if (node.$eq !== undefined && !isSeq(node.$eq[1])) return { $ne: node.$eq };
  if (node.$ne !== undefined) return { $eq: node.$ne };
  return { $not: node };
}
/** @param {any} value */
const isSeq = (value) => value !== null && typeof value === 'object' && Array.isArray(value.$seq);

/**
 * Read one application trigger back as the rule it is exactly equal to.
 * @param {{ name: string, owner: string, sql: string }} trigger
 * @param {(table: string) => any} factsOf - a table's {@link triggerTableFacts}, or `undefined` for a table this read did not include or that is a view
 * @param {{ name: string, op: string, of: string[] | null, table: string }[]} siblings - the other triggers of the database, as `triggerEventOf` reads their events, each with its name
 * @returns {{ rule: any, owner: string, targets: string[], timing: string, message: string | null } | { reason: string }}
 */
export function sqliteTriggerRule(trigger, factsOf, siblings) {
  try {
    const parsed = parseTrigger(String(trigger.sql));
    return translate(parsed, factsOf, siblings, trigger.owner);
  }
  catch (error) {
    if (error instanceof Unmapped) return { reason: error.reason };
    throw error;
  }
}

/**
 * The event a trigger fires on — its operation and `UPDATE OF` columns —
 * or `null` where its header is not one the reader reads, so a
 * revision bump can name another trigger its own UPDATE fires again.
 * @param {string} sql @returns {{ op: string, of: string[] | null } | null}
 */
export function triggerEventOf(sql) {
  const tokens = tokensOf(sql);
  if (tokens === null) return null;
  const c = cursorOver(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const op = tokens[i].value.toUpperCase();
    if (tokens[i].kind !== 'word' || !['INSERT', 'UPDATE', 'DELETE'].includes(op)) continue;
    c.at = i + 1;
    try {
      /** @type {string[] | null} */
      let of = null;
      if (op === 'UPDATE' && c.word('OF')) { of = [c.name('')]; while (c.symbol(',')) of.push(c.name('')); }
      if (!c.word('ON')) continue;
      return { op: op.toLowerCase(), of: of === null ? null : of.map(fold) };
    }
    catch (error) {
      if (error instanceof Unmapped) return null;
      throw error;
    }
  }
  return null;
}

/** @param {any} parsed @param {(table: string) => any} factsOf @param {any[]} siblings @param {string} ownerName */
function translate(parsed, factsOf, siblings, ownerName) {
  if (fold(parsed.table) !== fold(ownerName)) unmapped('a trigger whose table the catalog names otherwise');
  const owner = factsOf(ownerName);
  if (owner === undefined) unmapped('a trigger on a table this read does not derive as an entity');
  const op = parsed.op;
  /** @type {Set<string>} */
  const targets = new Set();
  /** A column of the trigger's own row. @param {any} ref */
  const own = (ref) => {
    if (op === 'insert' && ref.record === 'old') unmapped('a read of OLD in an INSERT trigger');
    if (op === 'delete' && ref.record === 'new') unmapped('a read of NEW in a DELETE trigger');
    const column = owner.columns.get(fold(ref.column));
    if (column === undefined) unmapped(`a column the table does not have ('${ref.column}')`);
    if (column.generated) unmapped(`a read of the generated column '${column.name}'`);
    if (column.codec === null) unmapped(`a read of the column '${column.name}', whose type no rule codec reads`);
    if (column.codec === 'text' && owner.collated) unmapped(`a text comparison on '${owner.name}', which declares a collation other than BINARY`);
    if (parsed.timing === 'before' && op === 'insert' && column.name === owner.rowid)
      unmapped(`a BEFORE INSERT read of the row id '${column.name}', which SQLite has not yet allocated`);
    return { path: pathOf(ref.record, column.name), codec: column.codec, nullable: column.nullable };
  };
  /** A literal's codec family: text, or a number. @param {any} node */
  const familyOf = (node) => (typeof node.value === 'string' ? 'text' : 'number');
  /** @param {string} codec */
  const family = (codec) => (codec === 'text' ? 'text' : 'number');
  /** The probe of another table a subquery reads. @param {any} probe */
  const probeOf = (probe) => {
    if (fold(probe.table) === fold(owner.name)) unmapped('a probe of the trigger\'s own table');
    const target = factsOf(probe.table);
    if (target === undefined) unmapped(`a probe of '${probe.table}', which this read does not derive as an entity`);
    targets.add(target.name);
    /** @type {Record<string, any>} */
    const match = {};
    for (const term of probe.terms) {
      const column = target.columns.get(fold(term.column));
      if (column === undefined) unmapped(`a probe of a column '${probe.table}' does not have ('${term.column}')`);
      if (column.codec === null || column.generated) unmapped(`a probe of the column '${column.name}', whose type no rule codec reads`);
      if (column.codec === 'text' && target.collated) unmapped(`a probe of '${target.name}', which declares a collation other than BINARY`);
      if (Object.hasOwn(match, column.name)) unmapped('a probe that matches one column twice');
      if (term.value.kind === 'ref') {
        const read = own(term.value);
        if (family(read.codec) !== family(column.codec)) unmapped(`a probe that compares '${column.name}' with a column of another type`);
        // `=` never matches SQL NULL where a probe's other members compare null-safely: the two agree
        // unless both sides can hold SQL NULL
        if (read.nullable && column.nullable) unmapped(`a probe that matches the nullable '${column.name}' with a nullable column`);
        match[column.name] = read.path;
      }
      else {
        if (familyOf(term.value) !== family(column.codec)) unmapped(`a probe that compares '${column.name}' with a literal of another type`);
        match[column.name] = literalOf(term.value.value);
      }
    }
    return { target, match, entity: target.name };
  };
  const exists = (/** @type {string} */ entity, /** @type {any} */ match) => ({ '$exists-row': { entity, match } });

  /** The rule formulas for when a condition is true and when it is false. @param {any} node @returns {[any, any]} */
  const truth = (node) => {
    switch (node.kind) {
      case 'and': { const parts = node.items.map(truth); return [and(parts.map((p) => p[0])), or(parts.map((p) => p[1]))]; }
      case 'or': { const parts = node.items.map(truth); return [or(parts.map((p) => p[0])), and(parts.map((p) => p[1]))]; }
      case 'not': { const [t, f] = truth(node.item); return [f, t]; }
      case 'exists': { const probe = probeOf(node.probe); const e = exists(probe.entity, probe.match); return [e, not(e)]; }
      case 'compare': return compare(node);
      case 'is': return is(node);
      case 'in': return within(node);
      default: return unmapped('an unreadable condition');
    }
  };
  /** A non-null value read: true where the operand holds one. @param {any} side */
  const present = (side) => (side.nullable ? { $ne: [side.path, null] } : true);
  /** An operand of a same-row comparison. @param {any} node */
  const side = (node) => {
    if (node.kind === 'ref') return { ...own(node), kind: 'ref' };
    if (node.kind === 'literal') return { kind: 'literal', path: literalOf(node.value), family: familyOf(node), nullable: false };
    if (node.kind === 'null') return unmapped('a comparison with NULL, which is never true');
    return unmapped('a subquery compared with a column');
  };
  /** @param {any} a @param {any} b */
  const sameFamily = (a, b) => {
    const fa = a.kind === 'ref' ? family(a.codec) : a.family, fb = b.kind === 'ref' ? family(b.codec) : b.family;
    if (fa !== fb) unmapped('a comparison of a column with a value of another type, which SQLite converts by affinity');
    if (a.kind === 'literal' && b.kind === 'literal') unmapped('a comparison of two literals');
  };
  /** A comparison over two values that are null at most where the column is. @param {any} a @param {string} rule @param {any} b */
  const leaf = (a, rule, b) => {
    // an inequality holds null-safely, and so does an equality of two columns: each value must be present
    const guarded = rule === '$ne' || (rule === '$eq' && a.kind === 'ref' && b.kind === 'ref');
    return and([...(guarded ? [present(a), present(b)] : []), { [rule]: [a.path, b.path] }]);
  };
  /** @param {any} node @returns {[any, any]} */
  const compare = (node) => {
    let { left, right, op: rule } = node;
    if (left.kind !== 'subquery' && right.kind === 'subquery') { [left, right] = [right, left]; rule = MIRRORED.get(rule); }
    if (left.kind === 'subquery') return compareProbe(left, rule, right);
    const a = side(left), b = side(right);
    sameFamily(a, b);
    if (a.kind === 'literal') return [leaf(b, /** @type {string} */ (MIRRORED.get(rule)), a), leaf(b, /** @type {string} */ (OPPOSITE.get(MIRRORED.get(rule))), a)];
    return [leaf(a, rule, b), leaf(a, /** @type {string} */ (OPPOSITE.get(rule)), b)];
  };
  /** A scalar subquery's one row: by the key or a unique index, and the column it reads. @param {any} node */
  const scalar = (node) => {
    const probe = probeOf(node.probe);
    const covered = probe.target.unique.some((/** @type {string[]} */ set) => set.every((name) => Object.hasOwn(probe.match, name)));
    if (!covered) unmapped(`a scalar subquery over '${probe.target.name}' by columns no key or unique index covers, which reads its first row`);
    const column = probe.target.columns.get(fold(node.probe.column));
    if (column === undefined) unmapped(`a subquery of a column '${probe.target.name}' does not have ('${node.probe.column}')`);
    if (column.codec === null || column.generated) unmapped(`a subquery of the column '${column.name}', whose type no rule codec reads`);
    if (column.codec === 'text' && probe.target.collated) unmapped(`a probe of '${probe.target.name}', which declares a collation other than BINARY`);
    if (Object.hasOwn(probe.match, column.name)) unmapped('a subquery that reads a column it matches');
    return { ...probe, column };
  };
  /** @param {any} value @param {any} column */
  const literalFor = (value, column) => {
    if (value.kind !== 'literal') unmapped('a subquery compared with something other than a literal');
    if (familyOf(value) !== family(column.codec)) unmapped('a comparison of a column with a value of another type, which SQLite converts by affinity');
    return literalOf(value.value);
  };
  /** @param {any} node @param {string} rule @param {any} value @returns {[any, any]} */
  const compareProbe = (node, rule, value) => {
    const probe = scalar(node);
    if (rule !== '$eq' && rule !== '$ne') unmapped('an ordered comparison of another row\'s column');
    // the subquery reads SQL NULL where no row matches: on a nullable column a NULL value is that too
    if (probe.column.nullable) unmapped(`a comparison of the nullable '${probe.target.name}.${probe.column.name}' read by a subquery, whose SQL NULL the comparison passes as it does a missing row`);
    const literal = literalFor(value, probe.column);
    const found = exists(probe.entity, probe.match);
    const equal = exists(probe.entity, { ...probe.match, [probe.column.name]: literal });
    const t = equal, f = and([found, not(equal)]);
    return rule === '$eq' ? [t, f] : [f, t];
  };
  /** @param {any} node @returns {[any, any]} */
  const is = (node) => {
    let { left, right } = node;
    if (left.kind === 'null' || (left.kind === 'literal' && right.kind !== 'literal')) [left, right] = [right, left];
    /** @type {any} */
    let t;
    if (left.kind === 'subquery') {
      const probe = scalar(left);
      const found = exists(probe.entity, probe.match);
      if (right.kind === 'null') t = probe.column.nullable ? or([not(found), exists(probe.entity, { ...probe.match, [probe.column.name]: null })]) : not(found);
      else t = exists(probe.entity, { ...probe.match, [probe.column.name]: literalFor(right, probe.column) });
    }
    else {
      const a = side(left);
      if (right.kind === 'null') t = a.nullable ? { $eq: [a.path, null] } : false;
      else {
        const b = side(right);
        sameFamily(a, b);
        t = { $eq: [a.path, b.path] };
      }
    }
    return node.not ? [not(t), t] : [t, not(t)];
  };
  /** @param {any} node @returns {[any, any]} */
  const within = (node) => {
    if (node.items.some((/** @type {any} */ item) => item.kind !== 'literal')) unmapped('an IN list of something other than literals');
    if (node.left.kind === 'subquery') {
      const probe = scalar(node.left);
      if (probe.column.nullable) unmapped(`a comparison of the nullable '${probe.target.name}.${probe.column.name}' read by a subquery, whose SQL NULL the comparison passes as it does a missing row`);
      const found = exists(probe.entity, probe.match);
      const t = or(node.items.map((/** @type {any} */ item) => exists(probe.entity, { ...probe.match, [probe.column.name]: literalFor(item, probe.column) })));
      const f = and([found, not(t)]);
      return node.not ? [f, t] : [t, f];
    }
    const a = side(node.left);
    for (const item of node.items) sameFamily(a, side(item));
    const t = { $eq: [a.path, { $seq: node.items.map((/** @type {any} */ item) => literalOf(item.value)) }] };
    const f = and([present(a), { $not: t }]);
    return node.not ? [f, t] : [t, f];
  };

  const name = parsed.name;
  const base = { name, on: [op] };
  if (parsed.of !== null) {
    if (parsed.statement.kind !== 'raise') unmapped('a revision bump on UPDATE OF');
    const members = [];
    for (const column of parsed.of) {
      const found = owner.columns.get(fold(column));
      if (found === undefined) unmapped(`an UPDATE OF column the table does not have ('${column}')`);
      if (found.generated) unmapped(`an UPDATE OF the generated column '${found.name}'`);
      if (members.includes(found.name)) unmapped('an UPDATE OF that names a column twice');
      members.push(found.name);
    }
    Object.assign(base, { columns: members });
  }
  else if (op === 'update') Object.assign(base, { when: 'assigned' });

  if (parsed.statement.kind === 'update') return bump(parsed, owner, siblings, base);
  const conditions = [parsed.when, parsed.statement.where].filter((node) => node !== null);
  const [refused] = conditions.length === 0 ? [true] : truth(conditions.length === 1 ? conditions[0] : { kind: 'and', items: conditions });
  return { rule: { ...base, enforcement: 'database', assert: not(refused) }, owner: owner.name, targets: [...targets].sort(),
    timing: parsed.timing, message: parsed.statement.message };
}

/** A revision bump: `AFTER UPDATE … WHEN NEW.c = OLD.c BEGIN UPDATE t SET c = OLD.c + 1 WHERE <key> = NEW.<key>; END`.
 * @param {any} parsed @param {any} owner @param {any[]} siblings @param {any} base */
function bump(parsed, owner, siblings, base) {
  const statement = parsed.statement;
  if (parsed.timing !== 'after' || parsed.op !== 'update') unmapped(`an UPDATE in a ${parsed.timing.toUpperCase()} ${parsed.op.toUpperCase()} trigger`);
  if (fold(statement.table) !== fold(owner.name)) unmapped('a program that writes another table');
  const column = owner.columns.get(fold(statement.column));
  if (column === undefined) unmapped(`an UPDATE of a column the table does not have ('${statement.column}')`);
  if (statement.from.record !== 'old' || fold(statement.from.column) !== fold(column.name))
    unmapped('an UPDATE that does not set a column to its old value plus one');
  if (column.codec !== 'integer' || column.nullable || owner.keys.includes(column.name))
    unmapped(`a bump of '${column.name}', which is no non-key NOT NULL INTEGER column`);
  // the row: every key column equal to the new row's, and nothing else
  const keyed = new Set();
  for (const term of statement.where) {
    const key = owner.columns.get(fold(term.column));
    if (term.ref.record !== 'new' || key === undefined || fold(term.ref.column) !== fold(key.name) || !owner.keys.includes(key.name) || keyed.has(key.name))
      unmapped('an UPDATE of rows other than the new row by its key');
    keyed.add(key.name);
  }
  if (keyed.size !== owner.keys.length) unmapped('an UPDATE of rows other than the new row by its key');
  // it bumps when the writer left the revision alone, and on no other condition
  const when = parsed.when;
  const sides = when?.kind === 'compare' && when.op === '$eq' ? [when.left, when.right]
    : when?.kind === 'is' && !when.not ? [when.left, when.right] : null;
  if (sides === null || !sides.every((side) => side.kind === 'ref' && fold(side.column) === fold(column.name))
    || new Set(sides.map((side) => side.record)).size !== 2)
    unmapped(`a bump under a condition other than NEW.${column.name} = OLD.${column.name}`);
  // the bump's own UPDATE fires every other UPDATE trigger of the table that the column's assignment fires,
  // which the rule's program, one trigger with its increment last, does not
  const again = siblings.find((other) => other.name !== parsed.name && other.table === fold(owner.name) && other.op === 'update'
    && (other.of === null || other.of.includes(fold(column.name))));
  if (again !== undefined) unmapped(`a bump whose own UPDATE fires the table's trigger '${again.name}' again, which the rule's program does not`);
  return { rule: { ...base, enforcement: 'database', assert: true, effects: [{ increment: column.name }] }, owner: owner.name, targets: [],
    timing: parsed.timing, message: null };
}

/**
 * The parenthesised tree of a token run: each `(`…`)` one nested array.
 * `null` where the parentheses do not balance.
 * @param {{ kind: string, value: string }[]} tokens
 * @returns {any[] | null}
 */
function groupsOf(tokens) {
  /** @type {any[][]} */
  const stack = [[]];
  for (const token of tokens) {
    if (token.kind === 'symbol' && token.value === '(') { stack.push([]); continue; }
    if (token.kind === 'symbol' && token.value === ')') {
      if (stack.length === 1) return null;
      const group = /** @type {any[]} */ (stack.pop());
      stack[stack.length - 1].push(group);
      continue;
    }
    stack[stack.length - 1].push(token);
  }
  return stack.length === 1 ? stack[0] : null;
}

/** @param {any} item @param {string} word */
const isWordItem = (item, word) => !Array.isArray(item) && item?.kind === 'word' && item.value.toUpperCase() === word;
/** @param {any} item @param {string} symbol */
const isSymbolItem = (item, symbol) => !Array.isArray(item) && item?.kind === 'symbol' && item.value === symbol;

/**
 * The items of a run split at each top-level keyword or symbol (`AND`, `OR`,
 * `,`, `;`).
 * @param {any[]} items @param {string} at @returns {any[][]}
 */
function splitAt(items, at) {
  /** @type {any[][]} */
  const parts = [[]];
  for (const item of items) {
    if (isSymbolItem(item, at) || isWordItem(item, at)) parts.push([]);
    else parts[parts.length - 1].push(item);
  }
  return parts;
}

/**
 * A rule's assertion read back from the text the SQLite rule lowering wrote
 * for it (`row-predicate.js`, trigger rendering): a candidate for the
 * re-planning that decides, never the decision itself — a reading is kept
 * only where the rules it gives plan exactly the stored text. `columns` the
 * entity's columns by their physical name, with the codec each reads as;
 * `probed` the same of a table a probe reads.
 * @param {any[]} items - the assertion's parenthesised tree
 * @param {(record: string, physical: string) => { path: string, codec: string } | null} member
 * @param {(table: string, physical: string) => string | null} probed - the member a probe target's column maps
 * @returns {any} the assertion, `undefined` for a text it does not read
 */
function storeAssertion(items, member, probed) {
  /** A member read `(NEW."x" COLLATE BINARY)`, `NEW."x"` raw, or a literal; `kind` says which. @param {any[]} run */
  const operand = (run) => {
    if (run.length === 1 && Array.isArray(run[0])) {
      const inner = run[0];
      if (inner.length === 5 && isWordItem(inner[3], 'COLLATE') && isWordItem(inner[4], 'BINARY')) return reference(inner.slice(0, 3));
      return undefined;
    }
    return reference(run) ?? literal(run);
  };
  /** @param {any[]} run */
  const reference = (run) => {
    if (run.length !== 3 || !(isWordItem(run[0], 'NEW') || isWordItem(run[0], 'OLD')) || !isSymbolItem(run[1], '.') || run[2]?.kind !== 'identifier') return undefined;
    const read = member(run[0].value.toLowerCase(), run[2].value);
    return read === null ? undefined : { kind: 'member', ...read };
  };
  /** @param {any[]} run */
  const literal = (run) => {
    if (run.length === 1 && run[0]?.kind === 'string') return { kind: 'literal', value: run[0].value.startsWith('$') ? `$${run[0].value}` : run[0].value };
    if (run.length === 1 && isWordItem(run[0], 'NULL')) return { kind: 'literal', value: null };
    const negative = isSymbolItem(run[0], '-');
    const digits = run[negative ? 1 : 0];
    if (run.length !== (negative ? 2 : 1) || digits?.kind !== 'number') return undefined;
    const value = Number(digits.value);
    return Number.isFinite(value) ? { kind: 'literal', value: negative ? -value : value, number: true } : undefined;
  };
  /** A literal beside a member of a boolean column is its stored `1` or `0`. @param {any} side @param {any} other */
  const valueOf = (side, other) => {
    if (side.kind === 'member') return side.path;
    if (side.number === true && other?.codec === 'boolean') return side.value === 1 ? true : side.value === 0 ? false : undefined;
    return side.value;
  };
  const EQUALITY = /** @type {const} */ ([['IS', 'NOT', '$ne'], ['IS', null, '$eq']]);
  /** `L IS [NOT] R`, `L op R` or `L IN (…)` @param {any[]} run @returns {any} */
  const comparison = (run) => {
    const isAt = run.findIndex((item) => isWordItem(item, 'IS'));
    if (isAt > 0) {
      const negated = isWordItem(run[isAt + 1], 'NOT');
      const key = EQUALITY.find(([, not]) => (not === 'NOT') === negated)?.[2];
      const left = operand(run.slice(0, isAt)), right = operand(run.slice(isAt + (negated ? 2 : 1)));
      if (left === undefined || right === undefined || key === undefined) return undefined;
      const sides = [valueOf(left, right), valueOf(right, left)];
      return sides.includes(undefined) ? undefined : { [key]: sides };
    }
    const inAt = run.findIndex((item) => isWordItem(item, 'IN'));
    if (inAt > 0 && inAt === run.length - 2 && Array.isArray(run[inAt + 1])) {
      const left = operand(run.slice(0, inAt));
      if (left?.kind !== 'member') return undefined;
      const values = splitAt(run[inAt + 1], ',').map((part) => literal(part));
      if (values.some((value) => value === undefined)) return undefined;
      const list = values.map((value) => valueOf(value, left));
      return list.includes(undefined) ? undefined : { $eq: [left.path, { $seq: list }] };
    }
    const opAt = run.findIndex((item) => !Array.isArray(item) && item.kind === 'symbol' && COMPARISONS.has(item.value));
    if (opAt <= 0) return undefined;
    const key = COMPARISONS.get(run[opAt].value);
    const left = operand(run.slice(0, opAt)), right = operand(run.slice(opAt + 1));
    if (left === undefined || right === undefined || key === '$eq' || key === '$ne') return undefined;
    const sides = [valueOf(left, right), valueOf(right, left)];
    return sides.includes(undefined) ? undefined : { [key]: sides };
  };
  /** `EXISTS (SELECT 1 FROM "T" AS "_jaren_row" WHERE …)` @param {any[]} select @returns {any} */
  const probe = (select) => {
    if (!isWordItem(select[0], 'SELECT') || select[1]?.value !== '1' || !isWordItem(select[2], 'FROM') || select[3]?.kind !== 'identifier'
      || !isWordItem(select[4], 'AS') || select[5]?.value !== '_jaren_row' || !isWordItem(select[6], 'WHERE')) return undefined;
    const table = select[3].value;
    /** @type {Record<string, any>} */
    const match = {};
    for (const condition of splitAt(select.slice(7), 'AND')) {
      const keyed = !isWordItem(condition[0], 'NOT');
      const run = keyed ? condition : condition.length === 2 && Array.isArray(condition[1]) ? condition[1] : null;
      if (run === null || run[0]?.kind !== 'identifier' || run[0].value !== '_jaren_row' || !isSymbolItem(run[1], '.') || run[2]?.kind !== 'identifier') return undefined;
      const name = probed(table, run[2].value);
      if (name === null || Object.hasOwn(match, name)) return undefined;
      const rest = keyed ? (isSymbolItem(run[3], '=') ? run.slice(4) : null)
        : isWordItem(run[3], 'IS') && isWordItem(run[4], 'NOT') && isWordItem(run.at(-2), 'COLLATE') && isWordItem(run.at(-1), 'BINARY') ? run.slice(5, -2) : null;
      const value = rest === null ? undefined : operand(rest);
      if (value === undefined) return undefined;
      match[name] = value.kind === 'member' ? value.path : value.value;
    }
    return { '$exists-row': { entity: table, match } };
  };
  /** One operand of a conjunction or disjunction. @param {any[]} run @returns {any} */
  const primary = (run) => {
    if (run.length === 1 && run[0]?.kind === 'number' && (run[0].value === '1' || run[0].value === '0')) return run[0].value === '1';
    if (run.length === 1 && Array.isArray(run[0])) return group(run[0]);
    if (run.length === 2 && isWordItem(run[0], 'COALESCE') && Array.isArray(run[1])) {
      const [inner, fallback] = splitAt(run[1], ',');
      return fallback?.length === 1 && fallback[0].value === '0' && inner.length === 1 && Array.isArray(inner[0]) ? comparison(inner[0]) : undefined;
    }
    if (run.length === 2 && isWordItem(run[0], 'EXISTS') && Array.isArray(run[1])) return probe(run[1]);
    return undefined;
  };
  /** A parenthesised predicate. @param {any[]} inner @returns {any} */
  const group = (inner) => {
    if (inner.length === 1 && Array.isArray(inner[0])) return group(inner[0]);
    if (inner.length === 2 && isWordItem(inner[0], 'NOT') && Array.isArray(inner[1])) {
      const negated = group(inner[1]);
      return negated === undefined ? undefined : { $not: negated };
    }
    const ors = splitAt(inner, 'OR');
    if (ors.length > 1) {
      const operands = ors.map(primary);
      return operands.includes(undefined) ? undefined : { $or: operands };
    }
    const ands = splitAt(inner, 'AND');
    // a guard: bare presence tests of the columns an absent member leaves SQL NULL, then the comparison they guard
    const presence = (/** @type {any[]} */ run) => run.length === 6 && reference(run.slice(0, 3)) !== undefined
      && isWordItem(run[3], 'IS') && isWordItem(run[4], 'NOT') && isWordItem(run[5], 'NULL');
    if (ands.length === 1) return presence(ands[0]) ? { $exists: /** @type {any} */ (reference(ands[0].slice(0, 3))).path } : comparison(ands[0]);
    if (ands.slice(0, -1).every(presence)) {
      const last = ands[ands.length - 1];
      return last.length === 1 && Array.isArray(last[0]) ? comparison(last[0]) ?? primary(last) : primary(last);
    }
    const operands = ands.map(primary);
    return operands.includes(undefined) ? undefined : { $and: operands };
  };
  return primary(items);
}

/**
 * The rule checks a store-owned table's SQLite rule program holds, read from
 * its CREATE text as candidates (`storeAssertion`): per `SELECT RAISE(ABORT,
 * 'jaren invariant:<rule>')` statement, the rule, whether its update check is
 * guarded by an assignment, and its assertion — or a reason.
 * @param {string} sql - the trigger's CREATE text
 * @param {(record: string, physical: string) => { path: string, codec: string } | null} member
 * @param {(table: string, physical: string) => string | null} probed
 * @returns {{ op: string, columns: string[], checks: { rule: string, guarded: boolean, assert: any }[] } | { reason: string }}
 */
export function storeRuleProgram(sql, member, probed) {
  const tokens = tokensOf(sql);
  const items = tokens === null ? null : groupsOf(tokens);
  if (items === null) return { reason: 'its text is not one the reader tokenizes' };
  const begin = items.findIndex((item) => isWordItem(item, 'BEGIN'));
  const on = items.findIndex((item) => isWordItem(item, 'ON'));
  const head = items.slice(0, on);
  const at = head.findIndex((item) => isWordItem(item, 'AFTER'));
  if (begin < 0 || on < 0 || at < 0 || !isWordItem(items.at(-1), 'END')) return { reason: 'it is not an AFTER trigger the rule lowering writes' };
  const op = String(head[at + 1]?.value ?? '').toLowerCase();
  const columns = isWordItem(head[at + 2], 'OF') ? splitAt(head.slice(at + 3), ',').map((part) => String(part[0]?.value)) : [];
  /** @type {{ rule: string, guarded: boolean, assert: any }[]} */
  const checks = [];
  for (const statement of splitAt(items.slice(begin + 1, -1), ';').filter((part) => part.length > 0)) {
    const [select, raise, args, where, ...when] = statement;
    const [abort, message] = Array.isArray(args) ? splitAt(args, ',') : [];
    if (!isWordItem(select, 'SELECT') || !isWordItem(raise, 'RAISE') || !isWordItem(abort?.[0], 'ABORT') || message?.[0]?.kind !== 'string'
      || !message[0].value.startsWith('jaren invariant:') || !isWordItem(where, 'WHERE'))
      return { reason: 'a statement of its program is no check the rule lowering writes (a store-owned layout\'s rules write no row)' };
    const tail = when.slice(-3);
    if (tail.length !== 3 || !isWordItem(tail[0], 'IS') || !isWordItem(tail[1], 'NOT') || !isWordItem(tail[2], 'TRUE'))
      return { reason: 'a check is not the lowering\'s `… IS NOT TRUE`' };
    const guard = when.slice(0, -3);
    const guarded = guard.length === 3 && Array.isArray(guard[0]) && isWordItem(guard[1], 'AND') && Array.isArray(guard[2]);
    const body = guarded ? guard[2] : guard.length === 1 && Array.isArray(guard[0]) ? guard[0] : null;
    // the domains the reads collect come first; the assertion is the last operand
    const assertion = body === null ? undefined : splitAt(body, 'AND').at(-1);
    const assert = assertion === undefined ? undefined : storeAssertion(assertion, member, probed);
    if (assert === undefined) return { reason: `the check of the rule '${message[0].value.slice('jaren invariant:'.length)}' is not an assertion the reader reads` };
    checks.push({ rule: message[0].value.slice('jaren invariant:'.length), guarded, assert });
  }
  return { op, columns, checks };
}
