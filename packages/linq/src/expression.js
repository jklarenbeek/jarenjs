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

let epochCounter = 0;

/**
 * The captures in progress, innermost last. A proxy is LIVE while its
 * capture is on this stack and CURRENT only at the top: a nested
 * capture (a chain built and run inside another callback) leaves the
 * enclosing proxies usable once it returns, while a proxy of the
 * enclosing capture used INSIDE the nested one is refused by name —
 * the inner document would rebind `$it`, so the outer reference would
 * silently point at the wrong item.
 * @type {number[]}
 */
const captureStack = [];

/** @param {any} record */
function assertLive(record) {
  if (record.epoch === captureStack[captureStack.length - 1]) return;
  if (captureStack.includes(record.epoch)) {
    throw new LinqBuildError('JL0002',
      'an expression proxy of an enclosing capture was used inside a nested capture — '
      + 'a correlated subquery cannot be spelled this way (the inner document rebinds the '
      + 'item); compute the inner query first and use its result');
  }
  throw new LinqBuildError('JL0002',
    'an expression proxy escaped its capture callback; expressions cannot be stored and replayed across operators');
}

/**
 * A member name as an RFC 9535 bracketed name selector. Backslashes and
 * quotes are escaped, and so are the control characters the grammar
 * forbids unescaped (U+0000–U+001F): without this a key holding a tab
 * emitted a path the engine refused at RUN time (`JQ0004`), while
 * `get()` is documented as the way to reach any key at all.
 * @param {string} name
 * @returns {string}
 */
function bracketName(name) {
  let escaped = '';
  for (const c of name) {
    const code = c.charCodeAt(0);
    if (c === '\\') escaped += '\\\\';
    else if (c === "'") escaped += "\\'";
    else if (code >= 0x20) escaped += c;
    else if (c === '\b') escaped += '\\b';
    else if (c === '\f') escaped += '\\f';
    else if (c === '\n') escaped += '\\n';
    else if (c === '\r') escaped += '\\r';
    else if (c === '\t') escaped += '\\t';
    else escaped += '\\u' + code.toString(16).padStart(4, '0');
  }
  return `['${escaped}']`;
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
 * True when `value` is a plain JSON tree (no proxies) that can embed
 * verbatim.
 *
 * "Plain JSON" is checked, not assumed. Walking `Object.keys` alone
 * accepted every value whose own enumerable keys happen to be JSON —
 * which a `Date`, a `Map`, a `RegExp`, a `Set` and every class instance
 * satisfy vacuously, because `Object.keys` reports nothing for them. Each
 * one then embedded as `{}` and the query filtered on an empty object.
 * The numeric domain matters just as much: `NaN` and `±Infinity` are not
 * JSON numbers, and `-0` is a legal number that shares JSON text with
 * `0` while dividing to the opposite infinity. So the prototype is
 * required to be plain and the numeric domain is required to be finite,
 * and a captured constant outside that boundary is refused at capture —
 * where the caller can see which value it was.
 * @param {any} value
 */
export function isPlainJson(value) {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (type !== 'object') return false; // undefined, function, symbol, bigint
  if (value[NODE] !== undefined) return false;
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    return proto === Array.prototype && value.every(isPlainJson);
  }
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Object.keys(value)) {
    if (!isPlainJson(value[key])) return false;
  }
  return true;
}

/**
 * Refuse a parameter value that is not query data. A binding travels
 * into a document as an external, and later into a provider as a bound
 * SQL parameter, so a `Date`, `Map`, `NaN` or `-0` here would compare
 * against nothing and answer `[]` with no error anywhere. One check for
 * both surfaces, one message.
 * @param {string} name
 * @param {any} value
 */
export function requireJsonBinding(name, value) {
  if (isPlainJson(value)) return;
  const what = value !== null && typeof value === 'object'
    ? `a ${value.constructor?.name ?? 'non-plain'} instance`
    : typeof value === 'number' ? String(value) : `a ${typeof value}`;
  throw new LinqBuildError('JL0004',
    `parameter '${name}' is bound to ${what}, which is not query data — convert it `
    + 'first (a Date to its ISO string or epoch number, a Map to an object, NaN or -0 to a number)');
}

/**
 * Turn a captured callback result — a proxy, a literal, or a plain
 * object/array tree containing proxies — into a query expression.
 * Objects without `$`-prefixed keys become Rule 1 constructors; a
 * `$`-keyed data object embeds through `$map` so it stays a
 * constructor rather than colliding with the operator vocabulary;
 * pure data trees embed as `$const` — unless `fold` is false, when
 * they are spelled as constructor trees too (a stylesheet body writes
 * its output the way the format's own examples do: `{ "level":
 * "unknown" }`, not `{ "$const": … }` — the same value, the published
 * spelling).
 * @param {any} value
 * @param {boolean} [fold] - whether a pure data tree folds into one `$const`
 * @returns {any} a query expression (plain JSON)
 */
export function toExpression(value, fold = true) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') return embedString(value);
  if (t === 'boolean') return value;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new LinqBuildError('JL0005',
        `a captured expression cannot embed ${String(value)} — the query data model is `
        + 'JSON, which has no NaN or Infinity, and lenient serialization would fold it '
        + 'into null');
    }
    if (Object.is(value, -0)) {
      throw new LinqBuildError('JL0005',
        'a captured expression cannot embed -0 — it shares its JSON text with 0 while '
        + 'dividing to the opposite infinity, so a document holding it cannot be '
        + 'keyed, stored or compared faithfully; use 0, or negate at query time');
    }
    return value;
  }
  if (t === 'object') {
    const record = value[NODE];
    if (record !== undefined) {
      assertLive(record);
      return record.doc;
    }
    if (fold && isPlainJson(value)) {
      // verbatim data: cheaper and clearer than a constructor tree
      return { $const: value };
    }
    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (proto !== Array.prototype) {
        throw new LinqBuildError('JL0005',
          'a captured expression cannot embed an Array subclass instance — its behaviour '
          + 'is not expressible as query data');
      }
      return value.map((v) => toExpression(v, fold));
    }
    if (proto !== Object.prototype && proto !== null) {
      // a Date, Map, Set, RegExp or class instance: `Object.keys` reports
      // nothing for it, so embedding it verbatim produced `{}` and the
      // query silently compared against an empty object
      throw new LinqBuildError('JL0005',
        `a captured expression cannot embed a ${value.constructor?.name ?? 'non-plain'} `
        + 'instance — it carries no own enumerable members, so it would embed as {}. '
        + 'Convert it to query data first (a Date to its ISO string or epoch number, a '
        + 'Map to an object), or bind it through params().');
    }
    const keys = Object.keys(value);
    if (keys.some((k) => k.charCodeAt(0) === 0x24)) {
      return { $map: keys.map((k) => [embedString(k), toExpression(value[k], fold)]) };
    }
    const out = {};
    // an own `__proto__` member is DATA here; plain assignment would set
    // the builder's prototype and drop the member
    for (const key of keys) {
      Object.defineProperty(out, key, {
        value: toExpression(value[key], fold),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
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
 * A unary operator that ranges over ITEMS: on a root that stands for
 * an array value with a fanned twin (`groupJoin`'s group is bound as an
 * array so `at`/`all`/member position work, and its aggregates count
 * the members, not the array), the operator applies to the fanned
 * path; elsewhere it is `unary`.
 * @param {string} op
 */
const fanned = (op) => function (/** @type {any} */ record) {
  return makeExpr({ [op]: record.seq ?? record.doc }, record.epoch, false);
};

/**
 * `$date-add` / `$date-sub`: `[date, duration]` or `[date, amount, unit]`.
 * @param {any} record
 * @param {any} amount - an ISO 8601 duration, or a number of units
 * @param {any} [unit] - the calendar unit, when `amount` is a number
 * @returns {any[]}
 */
function shiftArgs(record, amount, unit) {
  return unit === undefined
    ? [record.doc, toExpression(amount)]
    : [record.doc, toExpression(amount), toExpression(unit)];
}

/**
 * A §8.16 spec: captured data, embedded verbatim.
 *
 * These are the one place this surface hands the compiler something it
 * must NOT evaluate — a width, an aggregate, a fill policy and a row
 * selector are read once when the query compiles, which is what makes
 * them checkable at all. `toExpression` would turn `{ every: 'PT1H' }`
 * into a map constructor and `{ at: '$.on' }` into a path; the spec is
 * therefore embedded as it was written, and every rule about what it may
 * contain stays where it already is, in the query compiler (`JQ0003`).
 *
 * @param {any} spec
 * @param {string} method - for the message
 * @returns {any} the spec, verbatim
 */
function literalSpec(spec, method) {
  if (!isPlainJson(spec) || spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new LinqBuildError('JL0005',
      `${method}() takes a plain literal spec object; it is read once when the query`
      + ' compiles, so it cannot be an expression or carry a captured value');
  }
  return spec;
}

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
  exists: fanned('$exists'), isEmpty: fanned('$empty'),
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
  count: fanned('$count'), sum: fanned('$sum'), avg: fanned('$avg'),
  min: fanned('$min'), max: fanned('$max'),
  // §8.13 dates — the whole family, not a corner of it. A date in this
  // suite is an RFC 3339 STRING, so every one of these is an ordinary
  // string operator with a calendar's worth of rules behind it, and
  // every one lowers to the operator of the same name: there is no
  // LINQ-only date semantics to learn and nothing here a hand-written
  // document could not have said.
  //
  // `dateFormat` rather than `format`, and `dateAdd`/`dateSub` rather
  // than `add`/`sub`, because `add` is already `$add` on this surface —
  // the same reason §8.14 spells `geoArea`. Where no method name is
  // taken, the operator's own name is used unprefixed (`week`,
  // `quarter`, `startOf`).
  year: unary('$year'), month: unary('$month'), day: unary('$day'),
  hours: unary('$hours'), minutes: unary('$minutes'), seconds: unary('$seconds'),
  offset: unary('$offset'), epoch: unary('$epoch'), datetime: unary('$datetime'),
  week: unary('$week'), weekYear: unary('$week-year'),
  quarter: unary('$quarter'), weekday: unary('$weekday'),
  isDate: unary('$is-date'), isTime: unary('$is-time'),
  isDatetime: unary('$is-datetime'), isDuration: unary('$is-duration'),
  startOf: binary('$start-of'), endOf: binary('$end-of'),
  dateFormat: binary('$date-format'),
  dateAdd(record, amount, unit) {
    return makeExpr({ '$date-add': shiftArgs(record, amount, unit) }, record.epoch, false);
  },
  dateSub(record, amount, unit) {
    return makeExpr({ '$date-sub': shiftArgs(record, amount, unit) }, record.epoch, false);
  },
  dateDiff(record, to, unit) {
    return makeExpr(
      { '$date-diff': [record.doc, toExpression(to), toExpression(unit)] },
      record.epoch, false);
  },
  // §8.16 time series. The three sequence-valued operators take a
  // VERBATIM spec literal, so the argument is embedded with `$const`'s
  // discipline - it is captured data, never an expression - and the
  // compiler owns every rule about what it may say.
  overlaps: binary('$overlaps'),
  timeBucket(record, every, origin, context) {
    const args = [record.doc, toExpression(every)];
    if (origin !== undefined || context !== undefined)
      args.push(origin === undefined ? null : toExpression(origin));
    if (context !== undefined)
      args.push(literalSpec(context, 'timeBucket'));
    return makeExpr({ '$time-bucket': args }, record.epoch, false);
  },
  resample(record, spec) {
    return makeExpr({ $resample: [record.doc, literalSpec(spec, 'resample')] },
      record.epoch, false);
  },
  rolling(record, spec) {
    return makeExpr({ $rolling: [record.doc, literalSpec(spec, 'rolling')] },
      record.epoch, false);
  },
  asof(record, right, spec) {
    const args = [record.doc, toExpression(right)];
    if (spec !== undefined)
      args.push(literalSpec(spec, 'asof'));
    return makeExpr({ $asof: args }, record.epoch, false);
  },
  // §8.14 spatial. `geoArea`/`geoLength` rather than `area`/`length`:
  // `length` is already `$string-length` on this surface and renaming a
  // shipped method for symmetry is a breaking change for a cosmetic
  // gain, while a bare `area()` on an arbitrary expression reads as
  // arithmetic. The prefix names the family the way `geoParse`/`geoText`
  // do, and it is the same reason `$length` and `$string-length` are two
  // operators in the first place.
  bbox: unary('$bbox'), geoArea: unary('$area'),
  geoLength: unary('$length'), centroid: unary('$centroid'),
  distance: binary('$distance'), within: binary('$within'),
  bboxIntersects: binary('$bbox-intersects'),
  geoParse: unary('$geo-parse'), geoText: unary('$geo-text'),
  geohashBounds: unary('$geohash-bounds'),
  geohashNeighbours: unary('$geohash-neighbours'),
  geoSimplify: binary('$geo-simplify'),
  // §8.15 vectors. One method for one operator: the metric is cosine
  // and there is no distance spelling to choose between. A member
  // literally named `similarity` is read with `get('similarity')`, the
  // same escape every method name needs.
  similarity: binary('$similarity'),
  geohash(record, precision) {
    const args = precision === undefined
      ? record.doc
      : [record.doc, toExpression(precision)];
    return makeExpr({ $geohash: args }, record.epoch, false);
  },
  // path navigation
  at(record, index) {
    if (record.pathable && Number.isInteger(index)) {
      return makeExpr(`${record.doc}[${index}]`, record.epoch, true);
    }
    return makeExpr({ $get: [record.doc, toExpression(index)] }, record.epoch, false);
  },
  all(record) {
    if (record.seq !== undefined) return makeExpr(record.seq, record.epoch, true);
    if (!record.pathable) {
      throw new LinqBuildError('JL0005',
        "all() fans out a PATH ('$it.tags[*]'); it cannot follow an operator result");
    }
    return makeExpr(`${record.doc}[*]`, record.epoch, true);
  },
  get(record, name) {
    if (typeof name === 'string' && record.pathable) {
      return makeExpr(`${record.doc}${bracketName(name)}`, record.epoch, true);
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
 * @param {string} [seq] - for a root standing for an array VALUE: the
 *   fanned path its aggregates range over (`'$g[*]'`)
 * @returns {any}
 */
function makeExpr(doc, epoch, pathable, seq = undefined) {
  const record = { doc, epoch, pathable, seq };
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
          : `${target.doc}${bracketName(prop)}`;
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
 * `$it`) or a `{ doc, pathable, seq? }` record for a bound root
 * (groupJoin's group: the `$g` array, whose aggregates fan over
 * `$g[*]`). Captures nest — a chain built and run inside a callback is
 * ordinary — but a proxy used outside its capture, or an enclosing
 * capture's proxy used inside a nested one, is `JL0002`.
 * @param {(...roots: any[]) => any} fn - the user callback
 * @param {readonly (string | { doc: any, pathable: boolean, seq?: string })[]} roots
 * @param {Set<string>} declaredParams
 * @param {boolean} [fold] - whether a pure data tree folds into one
 *   `$const` (the chain's spelling) or is a constructor tree (a pen's)
 * @returns {any} the captured expression (plain JSON)
 */
export function captureExpression(fn, roots, declaredParams, fold = true) {
  const epoch = ++epochCounter;
  const proxies = roots.map((root) => (typeof root === 'string'
    ? makeExpr('$' + root, epoch, true)
    : makeExpr(root.doc, epoch, root.pathable, root.seq)));
  proxies.push(makeParams(declaredParams, epoch));
  captureStack.push(epoch);
  try {
    return toExpression(fn(...proxies), fold);
  }
  finally {
    captureStack.pop(); // every proxy of this capture is now dead
  }
}

/**
 * Whether `value` is an expression proxy of some capture (live or not).
 * A pen walking a captured result before it lowers needs to tell a
 * proxy from the plain object it would otherwise descend into.
 * @param {any} value
 * @returns {boolean}
 */
export function isExpression(value) {
  return value !== null && typeof value === 'object' && value[NODE] !== undefined;
}

/**
 * Lift a hand-spelled operator expression into the capture in
 * progress: the escape for an operator the method table does not name
 * — a registered one (`{ $npv: [...] }`, JSLT-FORMAT §13) or a
 * body-local one (`$apply`, §6). The document is taken as given — the
 * engine's compiler is the judge of it (`JQ0002` for an operator it
 * does not know) — and the proxy it answers is bound to the innermost
 * capture, so it composes with that capture's own proxies and dies
 * with them. Outside a capture there is nothing to bind it to:
 * `JL0005`.
 * @param {any} doc - the operator expression, plain JSON
 * @returns {any} an expression proxy over `doc`
 */
export function liftExpression(doc) {
  if (captureStack.length === 0) {
    throw new LinqBuildError('JL0005',
      'an operator expression can only be lifted inside a capture callback — no capture '
      + 'is in progress to bind it to');
  }
  return makeExpr(doc, captureStack[captureStack.length - 1], false);
}
