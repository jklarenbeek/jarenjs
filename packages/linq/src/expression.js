//@ts-check
/**
 * @file Expression capture (D4): a predicate or projection callback
 * receives a RECORDING PROXY, never a stringified function. Member
 * access records a path segment; a method call records an operator; the
 * output is a plain Jaren query expression (QUERY-FORMAT.md §§3–8) —
 * hand-readable JSON, nothing else.
 *
 * Capture is epoch-scoped: every proxy belongs to exactly one `capture`
 * call, and using one outside it (stored and replayed into a later
 * chain) is `JL0002` — a proxy that escaped would otherwise emit a
 * document that silently refers to the wrong binding. (`===` between
 * proxies is untrappable and therefore undetectable; the format doc
 * says so.)
 *
 * Method names shadow member access: `u.eq` is the operator, never the
 * data member — reach a colliding member with `u.get('eq')`.
 */

import { LinqBuildError } from './errors.js';

/** The unwrap key: proxy → its internal record. */
const NODE = Symbol('jaren-linq-node');

/** RFC 9535 shorthand member names travel as `.name`; everything else
 * goes through a bracketed, single-quoted selector. */
const SHORTHAND_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

let activeEpoch = 0;

/** @param {any} record */
function assertLive(record) {
  if (record.epoch !== activeEpoch) {
    throw new LinqBuildError('JL0002',
      'an expression proxy escaped its capture callback; expressions cannot be stored and replayed across operators');
  }
}

/**
 * Embed a literal string as a query expression: plain strings are
 * literals by Rule 2, and a string starting `$` needs the `$$` escape
 * so it stays data.
 * @param {string} s
 */
function embedString(s) {
  return s.charCodeAt(0) === 0x24 ? '$' + s : s;
}

/**
 * True when `value` (a plain JSON tree, no proxies) can embed verbatim.
 * @param {any} value
 */
function isPlainJson(value) {
  if (value === null || typeof value !== 'object') {
    return typeof value !== 'function' && typeof value !== 'symbol'
      && value !== undefined;
  }
  if (value[NODE] !== undefined) return false;
  if (Array.isArray(value)) return value.every(isPlainJson);
  for (const key of Object.keys(value)) {
    if (!isPlainJson(value[key])) return false;
  }
  return true;
}

/**
 * Turn a captured callback result — a proxy, a literal, or a plain
 * object/array tree containing proxies — into a query expression.
 * Objects without `$`-prefixed keys become Rule 1 constructors; a
 * `$`-keyed data object embeds through `$map` so it stays a
 * constructor rather than colliding with the operator vocabulary;
 * pure data trees embed as `$const`.
 * @param {any} value
 * @returns {any} a query expression (plain JSON)
 */
export function toExpression(value) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') return embedString(value);
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'object') {
    const record = value[NODE];
    if (record !== undefined) {
      assertLive(record);
      return record.doc;
    }
    if (isPlainJson(value)) {
      // verbatim data: cheaper and clearer than a constructor tree
      return { $const: value };
    }
    if (Array.isArray(value)) return value.map(toExpression);
    const keys = Object.keys(value);
    if (keys.some((k) => k.charCodeAt(0) === 0x24)) {
      return { $map: keys.map((k) => [embedString(k), toExpression(value[k])]) };
    }
    const out = {};
    for (const key of keys) out[key] = toExpression(value[key]);
    return out;
  }
  throw new LinqBuildError('JL0005',
    `a captured expression cannot embed a ${t === 'undefined' ? 'undefined' : t} value`);
}

/** Binary operator helper. @param {string} op */
const binary = (op) => function (/** @type {any} */ record, /** @type {any} */ operand) {
  return makeExpr({ [op]: [record.doc, toExpression(operand)] }, record.epoch, false);
};

/** Unary operator helper. @param {string} op */
const unary = (op) => function (/** @type {any} */ record) {
  return makeExpr({ [op]: record.doc }, record.epoch, false);
};

/**
 * The operator methods, name → builder(record, ...args). One table so
 * the mapping in LINQ-FORMAT.md §4 has exactly one code counterpart.
 * Null prototype: `constructor`/`toString` must read as member access,
 * never as inherited "methods".
 */
const METHODS = {
  __proto__: null,
  // §8.4 comparisons
  eq: binary('$eq'), ne: binary('$ne'),
  lt: binary('$lt'), le: binary('$le'),
  gt: binary('$gt'), ge: binary('$ge'),
  // §8.6 logic
  and: binary('$and'), or: binary('$or'), not: unary('$not'),
  // §8.5 arithmetic
  add: binary('$add'), sub: binary('$sub'), mul: binary('$mul'),
  div: binary('$div'), idiv: binary('$idiv'), mod: binary('$mod'),
  neg: unary('$neg'),
  // §8.2 existence
  exists: unary('$exists'), isEmpty: unary('$empty'),
  // §8.7 strings
  startsWith: binary('$starts-with'), endsWith: binary('$ends-with'),
  contains: binary('$contains'), matches: binary('$match'),
  upper: unary('$upper'), lower: unary('$lower'),
  length: unary('$string-length'),
  concat: binary('$concat'),
  substring(record, start, len) {
    const args = len === undefined
      ? [record.doc, toExpression(start)]
      : [record.doc, toExpression(start), toExpression(len)];
    return makeExpr({ $substring: args }, record.epoch, false);
  },
  replace(record, pattern, replacement) {
    return makeExpr(
      { $replace: [record.doc, toExpression(pattern), toExpression(replacement)] },
      record.epoch, false);
  },
  // §8.8 aggregates as EXPRESSIONS (a group inside a projection:
  // `(u, g) => ({ n: g.count() })`)
  count: unary('$count'), sum: unary('$sum'), avg: unary('$avg'),
  min: unary('$min'), max: unary('$max'),
  // §8.13 dates (the scalar component family; the full date surface
  // arrives with the relational order)
  year: unary('$year'), month: unary('$month'), day: unary('$day'),
  epoch: unary('$epoch'),
  // path navigation
  at(record, index) {
    if (record.pathable && Number.isInteger(index)) {
      return makeExpr(`${record.doc}[${index}]`, record.epoch, true);
    }
    return makeExpr({ $get: [record.doc, toExpression(index)] }, record.epoch, false);
  },
  all(record) {
    if (!record.pathable) {
      throw new LinqBuildError('JL0005',
        "all() fans out a PATH ('$it.tags[*]'); it cannot follow an operator result");
    }
    return makeExpr(`${record.doc}[*]`, record.epoch, true);
  },
  get(record, name) {
    if (typeof name === 'string' && record.pathable) {
      return makeExpr(`${record.doc}['${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`,
        record.epoch, true);
    }
    return makeExpr({ $get: [record.doc, toExpression(name)] }, record.epoch, false);
  },
};

/**
 * Build one expression proxy.
 * @param {any} doc - the expression JSON so far
 * @param {number} epoch - the owning capture
 * @param {boolean} pathable - whether `doc` is a pure path string that
 *   member access may extend
 * @returns {any}
 */
function makeExpr(doc, epoch, pathable) {
  const record = { doc, epoch, pathable };
  return new Proxy(record, {
    get(target, prop) {
      if (prop === NODE) return target;
      if (typeof prop === 'symbol') return undefined;
      const method = METHODS[prop];
      if (method !== undefined) {
        return (...args) => {
          assertLive(target);
          return method(target, ...args);
        };
      }
      assertLive(target);
      if (target.pathable) {
        const step = SHORTHAND_RE.test(prop)
          ? `${target.doc}.${prop}`
          : `${target.doc}['${prop.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
        return makeExpr(step, target.epoch, true);
      }
      return makeExpr({ $get: [target.doc, prop] }, target.epoch, false);
    },
  });
}

/**
 * The parameters proxy: `p.tenantId` emits the external `$tenantId` —
 * when the name was declared via `.params({...})`. Undeclared use is
 * `JL0004` at BUILD time, with the fix in the message (the engine
 * would say JQ0005 at compile time; earlier and clearer beats later).
 * @param {Set<string>} declared
 * @param {number} epoch
 */
function makeParams(declared, epoch) {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (!declared.has(prop)) {
        throw new LinqBuildError('JL0004',
          `parameter '${prop}' is not declared — declare it first: .params({ ${prop}: value })`);
      }
      return makeExpr('$' + prop, epoch, true);
    },
  });
}

/**
 * Run one capture: `fn` receives a proxy per root (plus the parameters
 * proxy last) and its result becomes an expression via
 * {@link toExpression}. A root is a binding NAME (`'it'` → the pathable
 * `$it`) or a `{ doc, pathable }` record for an expression-valued root
 * (groupJoin's inner group). Proxies die with the capture — reuse is
 * `JL0002`.
 * @param {(...roots: any[]) => any} fn - the user callback
 * @param {readonly (string | { doc: any, pathable: boolean })[]} roots
 * @param {Set<string>} declaredParams
 * @returns {any} the captured expression (plain JSON)
 */
export function captureExpression(fn, roots, declaredParams) {
  const epoch = ++activeEpoch;
  const proxies = roots.map((root) => (typeof root === 'string'
    ? makeExpr('$' + root, epoch, true)
    : makeExpr(root.doc, epoch, root.pathable)));
  proxies.push(makeParams(declaredParams, epoch));
  try {
    return toExpression(fn(...proxies));
  }
  finally {
    activeEpoch++; // every proxy of this capture is now dead
  }
}
