//@ts-check
/**
 * @file The linq engine's chain reader. The Chain pane holds a fluent
 * `@jarenjs/linq` chain as TEXT — `from(data).where((u) => u.age.gt(21))` —
 * and this module reads it WITHOUT `eval` or `new Function` (the suite is
 * CSP-safe) and replays it against the real chain surface: every call is the
 * real operator, every callback a closure handing the real recording proxies
 * to the expressions the text spells. So the document the engine shows is the
 * one the same chain written in JavaScript emits.
 *
 * The text is a small, closed subset of JavaScript: one chain starting at
 * `from(data)`, the chain operators of {@link CHAIN_METHODS}, arrow callbacks
 * whose bodies are member reads and the expression methods of
 * {@link EXPRESSION_METHODS}, and JSON-like literals (either quote, comments,
 * trailing commas). It is stricter than JavaScript where JavaScript captures
 * silently wrong: an operator (`>`, `&&`, `!`, `+`, `===`) is refused at its
 * position naming the method that spells it, and a block body — which
 * JavaScript reads as a statement, not an object — is refused too.
 *
 * Safety is provenance: a member is read, and a method called, only on a
 * value the recording proxy produced (a callback parameter, or a read or call
 * on one), so no text ever indexes a host object; a chain operator is called
 * only by a name on the closed list.
 */
import { from } from '@jarenjs/linq';

/** The chain operators the reader offers: each returns a new `Sequence`.
 * Terminals run the chain, so they are not here — the engine answers with
 * `toArray()` and shows `toDocument()` itself. `mapAsync` is asynchronous and
 * `zip` has no document. */
export const CHAIN_METHODS = Object.freeze([
  'where', 'select', 'selectMany', 'orderBy', 'orderByDescending', 'thenBy', 'thenByDescending',
  'groupBy', 'join', 'groupJoin', 'aggregate', 'skip', 'take', 'distinct', 'reverse', 'concat',
  'defaultIfEmpty', 'ofType', 'cast', 'params',
]);

/** The expression methods of the recording proxy (QUERY-PEN §4): a name here
 * read without its call is a method, never a member. */
export const EXPRESSION_METHODS = Object.freeze([
  'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'and', 'or', 'not', 'in',
  'add', 'sub', 'mul', 'div', 'idiv', 'mod', 'neg', 'exists', 'isEmpty',
  'startsWith', 'endsWith', 'contains', 'matches', 'upper', 'lower', 'length', 'concat', 'substring', 'replace',
  'count', 'sum', 'avg', 'min', 'max',
  'year', 'month', 'day', 'hours', 'minutes', 'seconds', 'offset', 'epoch', 'datetime',
  'week', 'weekYear', 'quarter', 'weekday', 'isDate', 'isTime', 'isDatetime', 'isDuration',
  'startOf', 'endOf', 'dateAdd', 'dateSub', 'dateDiff', 'dateFormat',
  'overlaps', 'timeBucket', 'resample', 'rolling', 'asof',
  'bbox', 'geoArea', 'geoLength', 'centroid', 'distance', 'within', 'bboxIntersects', 'geohash',
  'geoParse', 'geoText', 'geohashBounds', 'geohashNeighbours', 'geoSimplify', 'similarity',
  'at', 'all', 'get',
]);

const CHAIN = new Set(CHAIN_METHODS);
const EXPRESSION = new Set(EXPRESSION_METHODS);
const TERMINALS = new Set([
  'toArray', 'toDocument', 'explain', 'first', 'firstOrDefault', 'single', 'singleOrDefault',
  'last', 'lastOrDefault', 'elementAt', 'elementAtOrDefault', 'count', 'sum', 'average', 'min', 'max', 'any', 'all',
]);

/** The JavaScript operators a proxy cannot capture, and the method that spells each. */
const OPERATORS = {
  __proto__: null,
  '===': '.eq()', '==': '.eq()', '!==': '.ne()', '!=': '.ne()',
  '>=': '.ge()', '<=': '.le()', '>': '.gt()', '<': '.lt()',
  '&&': '.and()', '||': '.or()', '??': '.or()', '!': '.not()',
  '+': '.add() (or .concat() for text)', '-': '.sub() (or .neg())', '*': '.mul()', '/': '.div()', '%': '.mod()',
  '?': '.and() and .or()',
};
const OPERATOR_TOKENS = ['===', '!==', '==', '!=', '>=', '<=', '&&', '||', '??', '>', '<', '!', '+', '-', '*', '/', '%', '?'];
const PUNCTUATION = ['=>', '(', ')', '{', '}', '[', ']', '.', ',', ':', ';'];
const NAME = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES = { __proto__: null, n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\\': '\\', '/': '/', "'": "'", '"': '"' };

/**
 * A chain the reader refuses, located at a 0-based `position` in the Chain
 * pane's text — the syntax family of PLAY-FORMAT §2. A refusal of the linq
 * package itself keeps that package's `code` and message, and is positioned at
 * the call that raised it.
 */
export class ChainError extends Error {
  /** @param {string} message @param {number} position @param {string} [code] */
  constructor(message, position, code = 'PLAY_CHAIN') {
    super(message);
    this.name = 'ChainError';
    this.code = code;
    this.position = position;
  }
}

/** @typedef {{ type: string, value?: any, pos: number }} Token */

/** @param {string} text @returns {Token[]} */
function tokenize(text) {
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith('//', i)) { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new ChainError('a comment opened here is never closed', i);
      i = end + 2; continue;
    }
    NAME.lastIndex = i; NUMBER.lastIndex = i;
    const name = NAME.exec(text);
    if (name) { tokens.push({ type: 'name', value: name[0], pos: i }); i += name[0].length; continue; }
    const number = NUMBER.exec(text);
    if (number) { tokens.push({ type: 'literal', value: Number(number[0]), pos: i }); i += number[0].length; continue; }
    if (c === '"' || c === "'") { const [value, end] = readString(text, i); tokens.push({ type: 'literal', value, pos: i }); i = end; continue; }
    if (c === '`') throw new ChainError('a template literal is not read — join text with .concat()', i);
    const punct = PUNCTUATION.find((p) => text.startsWith(p, i));
    if (punct) { tokens.push({ type: punct, pos: i }); i += punct.length; continue; }
    const op = OPERATOR_TOKENS.find((p) => text.startsWith(p, i));
    if (op) { tokens.push({ type: 'op', value: op, pos: i }); i += op.length; continue; }
    throw new ChainError(`unexpected character ${JSON.stringify(c)}`, i);
  }
  tokens.push({ type: 'end', pos: text.length });
  return tokens;
}

/** @param {string} text @param {number} start @returns {[string, number]} */
function readString(text, start) {
  const quote = text[start];
  let out = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === quote) return [out, i + 1];
    if (c === '\n') break;
    if (c !== '\\') { out += c; continue; }
    const e = text[++i];
    if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) { out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)); i += 4; continue; }
    if (e === undefined || ESCAPES[e] === undefined) throw new ChainError(`an unknown escape \\${e ?? ''}`, i - 1);
    out += ESCAPES[e];
  }
  throw new ChainError('a string opened here is never closed', start);
}

/** The operator refusal: what the proxy cannot capture, and its spelling. @param {Token} t */
function operatorRefusal(t) {
  return new ChainError(`a callback cannot capture the JavaScript operator ${t.value} — spell it with ${OPERATORS[t.value]}`, t.pos);
}

/** A recursive-descent reader over the token list, building a small tree. */
class Reader {
  /** @param {Token[]} tokens */
  constructor(tokens) { this.tokens = tokens; this.i = 0; }
  get peek() { return this.tokens[this.i]; }
  /** @param {number} n */
  ahead(n) { return this.tokens[Math.min(this.i + n, this.tokens.length - 1)]; }
  /** @param {string} type @param {string} what */
  expect(type, what) {
    const t = this.peek;
    if (t.type !== type) throw this.unexpected(what);
    this.i++;
    return t;
  }
  /** @param {string} what */
  unexpected(what) {
    const t = this.peek;
    if (t.type === 'op') return operatorRefusal(t);
    const seen = t.type === 'end' ? 'the end of the chain' : t.type === 'name' ? `'${t.value}'`
      : t.type === 'literal' ? JSON.stringify(t.value) : `'${t.type}'`;
    return new ChainError(`expected ${what}, found ${seen}`, t.pos);
  }

  /** The whole pane: one chain, an optional `;`, nothing after. */
  program() {
    const chain = this.chain();
    if (this.peek.type === ';') this.i++;
    if (this.peek.type !== 'end') throw this.unexpected('the end of the chain');
    return chain;
  }

  /** `from(data)` then `.operator(args)` calls. */
  chain() {
    const start = this.peek;
    if (start.type !== 'name' || start.value !== 'from') throw new ChainError('a chain starts with from(data) — the Data pane is its source', start.pos);
    this.i++;
    this.expect('(', "'(' after from");
    const source = this.peek;
    if (source.type !== 'name' || source.value !== 'data') throw new ChainError('from() reads the Data pane: write from(data)', source.pos);
    this.i++;
    this.expect(')', "')' after from(data");
    const calls = [];
    while (this.peek.type === '.') {
      this.i++;
      const name = this.expect('name', 'a chain operator');
      if (!CHAIN.has(name.value)) {
        throw new ChainError(TERMINALS.has(name.value)
          ? `${name.value}() is a terminal: it runs the chain, and this engine shows the chain's document beside its toArray() answer — end the chain before ${name.value}()`
          : `${name.value} is not a chain operator here (${CHAIN_METHODS.join(', ')})`, name.pos);
      }
      calls.push({ name: name.value, pos: name.pos, args: this.args(() => this.chainArgument()) });
    }
    return { type: 'chain', pos: start.pos, calls };
  }

  /** `( item, item, )` @param {() => any} item */
  args(item) {
    this.expect('(', "'('");
    const out = [];
    while (this.peek.type !== ')') {
      out.push(item());
      if (this.peek.type !== ',') break;
      this.i++;
    }
    this.expect(')', "',' or ')'");
    return out;
  }

  /** A chain operator's argument: a callback, a nested chain, or a literal. */
  chainArgument() {
    if (this.atLambda()) return this.lambda();
    if (this.peek.type === 'name' && this.peek.value === 'from') return this.chain();
    return this.expression(null);
  }

  /** `u =>` or `(a, b) =>` starts here. */
  atLambda() {
    if (this.peek.type === 'name') return this.ahead(1).type === '=>';
    if (this.peek.type !== '(') return false;
    let n = 1;
    if (this.ahead(n).type === ')') return this.ahead(n + 1).type === '=>';
    for (;;) {
      if (this.ahead(n).type !== 'name') return false;
      n++;
      if (this.ahead(n).type === ')') return this.ahead(n + 1).type === '=>';
      if (this.ahead(n).type !== ',') return false;
      n++;
    }
  }

  lambda() {
    /** @type {string[]} */
    const params = [];
    if (this.peek.type === 'name') params.push(this.expect('name', 'a parameter').value);
    else {
      this.expect('(', "'('");
      while (this.peek.type === 'name') {
        params.push(this.expect('name', 'a parameter').value);
        if (this.peek.type !== ',') break;
        this.i++;
      }
      this.expect(')', "')'");
    }
    this.expect('=>', "'=>'");
    if (this.peek.type === '{') {
      throw new ChainError('a callback body that opens with { is a block in JavaScript, not an object — wrap the object in parentheses: (u) => ({ … })', this.peek.pos);
    }
    return { type: 'lambda', params, body: this.expression(params) };
  }

  /**
   * One expression. `scope` is the enclosing callback's parameter names, or
   * `null` at the chain level, where only literals are written.
   * @param {string[] | null} scope
   */
  expression(scope) {
    // an operator after it is refused where the caller expects ',' or a
    // closing bracket ({@link Reader#unexpected})
    return this.postfix(this.primary(scope), scope);
  }

  /** @param {string[] | null} scope */
  primary(scope) {
    const t = this.peek;
    if (t.type === 'literal') { this.i++; return { type: 'literal', value: t.value, captured: false, pos: t.pos }; }
    if (t.type === 'op' && t.value === '-' && this.ahead(1).type === 'literal' && typeof this.ahead(1).value === 'number') {
      this.i += 2;
      return { type: 'literal', value: -this.ahead(-1).value, captured: false, pos: t.pos };
    }
    if (t.type === 'name') {
      this.i++;
      if (t.value === 'true' || t.value === 'false') return { type: 'literal', value: t.value === 'true', captured: false, pos: t.pos };
      if (t.value === 'null') return { type: 'literal', value: null, captured: false, pos: t.pos };
      if (scope !== null && scope.includes(t.value)) return { type: 'binding', name: t.value, captured: true, pos: t.pos };
      throw new ChainError(scope === null
        ? `'${t.value}' is not a value here — a chain operator takes a callback, a literal or from(data)`
        : `'${t.value}' is not a parameter of this callback (${scope.join(', ') || 'it has none'}) — a callback reads only its own parameters`, t.pos);
    }
    if (t.type === '[') {
      this.i++;
      const items = [];
      while (this.peek.type !== ']') {
        items.push(this.expression(scope));
        if (this.peek.type !== ',') break;
        this.i++;
      }
      this.expect(']', "',' or ']'");
      return { type: 'array', items, captured: false, pos: t.pos };
    }
    if (t.type === '{') {
      this.i++;
      const members = [];
      while (this.peek.type !== '}') {
        const key = this.peek;
        if (key.type !== 'name' && !(key.type === 'literal' && typeof key.value === 'string')) throw this.unexpected('a member name');
        this.i++;
        this.expect(':', `':' after the member ${JSON.stringify(key.value)}`);
        members.push([String(key.value), this.expression(scope)]);
        if (this.peek.type !== ',') break;
        this.i++;
      }
      this.expect('}', "',' or '}'");
      return { type: 'object', members, captured: false, pos: t.pos };
    }
    if (t.type === '(') {
      this.i++;
      const inner = this.expression(scope);
      this.expect(')', "')'");
      return inner;
    }
    throw this.unexpected('a value');
  }

  /** `.member`, `.method(args)` @param {any} node @param {string[] | null} scope */
  postfix(node, scope) {
    for (;;) {
      const t = this.peek;
      if (t.type === '[') throw new ChainError('an index is written .at(i), and an odd member name .get(\'…\')', t.pos);
      if (t.type !== '.') return node;
      if (!node.captured) throw new ChainError('a literal has no members here — only a callback\'s parameters are read with "."', t.pos);
      this.i++;
      const name = this.expect('name', 'a member or method name');
      if (this.peek.type === '(') {
        node = { type: 'call', target: node, name: name.value, pos: name.pos, args: this.args(() => this.expression(scope)), captured: true };
      }
      else node = { type: 'member', target: node, name: name.value, pos: name.pos, captured: true };
    }
  }
}

/** A constructed object whose every key is an OWN member (`__proto__` included). */
function ownObject(entries) {
  const out = {};
  for (const [key, value] of entries) Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  return out;
}

/** Run `fn`, re-raising a non-reader error as a ChainError at `pos`. @param {() => any} fn @param {number} pos */
function at(fn, pos) {
  try { return fn(); }
  catch (err) {
    if (err instanceof ChainError) throw err;
    const e = /** @type {any} */ (err);
    throw new ChainError(String(e?.message ?? e), pos, typeof e?.code === 'string' ? e.code : undefined);
  }
}

/** @param {any} node @param {Map<string, any>} bindings @param {any} source @param {object} options */
function evaluate(node, bindings, source, options) {
  switch (node.type) {
    case 'literal': return node.value;
    case 'array': return node.items.map((n) => evaluate(n, bindings, source, options));
    case 'object': return ownObject(node.members.map(([k, n]) => [k, evaluate(n, bindings, source, options)]));
    case 'binding': {
      const value = bindings.get(node.name);
      if (value === undefined) throw new ChainError(`'${node.name}' receives nothing here — this callback is handed fewer arguments`, node.pos);
      return value;
    }
    case 'member': {
      const target = evaluate(node.target, bindings, source, options);
      // the target is a recording proxy (provenance), so this read is its trap
      const value = at(() => target[node.name], node.pos);
      // a method name read without its call is a function, which JavaScript
      // would hand on as a wrong value; a parameter of that name (`p.min`) is
      // a member of the parameters proxy and reads as one
      if (typeof value === 'function' && (EXPRESSION.has(node.name) || node.name === 'toJSON')) {
        throw new ChainError(`.${node.name} is a method: call it, .${node.name}(…), or read a member of that name with .get('${node.name}')`, node.pos);
      }
      return value;
    }
    case 'call': {
      const target = evaluate(node.target, bindings, source, options);
      const args = node.args.map((n) => evaluate(n, bindings, source, options));
      return at(() => {
        // the target is a recording proxy (provenance), so this read is its
        // trap: an expression method, or a member — callable only when it is
        // named like a host method, whose call is the proxy's own refusal
        const fn = target[node.name];
        if (typeof fn !== 'function') throw new ChainError(`.${node.name}() is not a method of the expression surface`, node.pos);
        return fn(...args);
      }, node.pos);
    }
    case 'lambda':
      return (/** @type {any[]} */ ...received) => evaluate(node.body,
        new Map(node.params.map((/** @type {string} */ p, /** @type {number} */ i) => [p, received[i]])), source, options);
    case 'chain': {
      let seq = at(() => from(source, options), node.pos);
      for (const call of node.calls) {
        const args = call.args.map((n) => evaluate(n, bindings, source, options));
        seq = at(() => seq[call.name](...args), call.pos);
      }
      return seq;
    }
    /* c8 ignore next 2 -- the reader builds no other node */
    default: throw new ChainError(`an unknown node ${node.type}`, node.pos);
  }
}

/**
 * Read a chain's text and replay it against `@jarenjs/linq` over `source`.
 * @param {string} text - the Chain pane: `from(data).where(…)…`
 * @param {any} source - the parsed Data pane `from(data)` reads
 * @param {object} [options] - `from()`'s options (`compileTypeTest`)
 * @returns {import('@jarenjs/linq').Sequence<any>}
 * @throws {ChainError} on text the reader refuses, located at its position
 */
export function readChain(text, source, options = {}) {
  const tree = new Reader(tokenize(text)).program();
  return evaluate(tree, new Map(), source, options);
}
