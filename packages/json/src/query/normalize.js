//#region Jaren JSON Query normalizer
// Single recursive pass over a query document (QUERY-FORMAT.md sections
// 3-9) producing the internal AST: plain frozen `{kind, card, docPath, ...}`
// nodes. All classification decisions - object partitioning, the closed
// phrase vocabulary, string forms, scope resolution - happen here, so the
// compiler (compile.js) only ever sees well-formed nodes.
//
// Static cardinality analysis: every node carries `card`, an upper
// approximation of its runtime sequence length (CARD_ONE means "always
// exactly one item"). compile.js uses it to emit singleton-mode closures
// that skip all sequence checks - the query-engine analogue of path.js's
// singular-query fast path.
//
// Scoping: lexical environments map variable names to frame slot indices.
// Each compiled query evaluates against one frame array; slot 0 is the
// input document, every binding site and every external parameter gets its
// own slot from a single allocator (nested FLWOR phrases simply keep
// allocating in the same frame). Free names become external parameters,
// collected in order of first appearance.

import { parseJSONPath, JSONPathSyntaxError, RE_JSONPATH_VARIABLE_HEAD } from '../path.js';
import { isSingularSegments } from '../segments.js';
import { encodeJSONPointerSegment } from '../pointer.js';
import { JsonQueryCompileError } from './errors.js';
import { normalizeLexical } from './lexical.js';
import { deepFreeze, isJsonObject } from '@jarenjs/core/object';
// The operator registry: `name -> { params, result, compile }`. Only
// referenced inside functions (never at module evaluation time), so the
// import cycle normalize.js <-> operators.js is initialization-safe.
import { OPERATORS } from './operators.js';

//#region cardinality

/**
 * The twelve node kinds of the normalized form, sorted — the published
 * AST contract (QUERY-FORMAT.md Appendix C). An exhaustiveness gate
 * asserts a corpus exercising every construct produces exactly this
 * set, so a new kind cannot ship undocumented.
 */
export const NODE_KINDS = Object.freeze([
  'array', 'call', 'flwor', 'let', 'literal', 'map',
  'object', 'op', 'path', 'quant', 'raw', 'var',
]);

/** Statically empty (the node always evaluates to the empty sequence). */
export const CARD_ZERO = 0;
/** Always exactly one item; compile.js skips all sequence checks. */
export const CARD_ONE = 1;
/** Zero or one item. */
export const CARD_OPT = 2;
/** Any number of items (the analysis top). */
export const CARD_MANY = 3;

/**
 * join = least upper bound over {ZERO, ONE, OPT, MANY}: the cardinality
 * of "one of the two branches" ($if).
 * @param {number} a - a CARD_* value
 * @param {number} b - a CARD_* value
 * @returns {number}
 */
export function joinCard(a, b) {
  if (a === b)
    return a;
  if (a === CARD_MANY || b === CARD_MANY)
    return CARD_MANY;
  return CARD_OPT;
}

/**
 * sum = cardinality of two concatenated sequences ($seq); two non-empty
 * contributions can exceed one item, which only MANY can express.
 * @param {number} a - a CARD_* value
 * @param {number} b - a CARD_* value
 * @returns {number}
 */
export function sumCard(a, b) {
  if (a === CARD_ZERO)
    return b;
  if (b === CARD_ZERO)
    return a;
  return CARD_MANY;
}

//#endregion

//#region vocabulary tables

const hasOwn = Object.hasOwn;

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The '$name' head of a variable-rooted path string; shared with the
// json-path-segments format tester so both split at the same point.
const VAR_HEAD_RE = RE_JSONPATH_VARIABLE_HEAD;

// FLWOR clause keys (QUERY-FORMAT.md section 6.1) and quantifier keys
// (section 7). Clauses apply in the fixed semantic order of section 6.1
// regardless of JSON key order (D7).
const FLWOR_KEYS = new Set(['$fold', '$for', '$let', '$as', '$where', '$groupby', '$orderby', '$count', '$return']);
const QUANTIFIER_KEYS = new Set(['$some', '$every', '$satisfies']);

// Keys of the explicit $orderby key-spec form (section 6.6). Contextual:
// they are not operators and stay outside the KNOWN_KEYS vocabulary.
const ORDERBY_SPEC_KEYS = new Set(['$key', '$dir', '$empty', '$collation']);

// Keys of the extended $for binding form (sections 6.2, 6.10): the
// source, a positional variable, the outer-join switch, and the window
// specification. Also contextual - not operators.
const FOR_BINDING_KEYS = new Set(['$in', '$at', '$allowing-empty', '$window', '$size', '$step']);

// Whether a binding source uses the extended object form rather than
// being an ordinary expression. Any of its keys marks it, so a malformed
// combination is diagnosed as a bad binding instead of silently
// normalizing as a map constructor.
function isExtendedBinding(source) {
  if (!isJsonObject(source))
    return false;
  for (const key of FOR_BINDING_KEYS) {
    if (hasOwn(source, key))
      return true;
  }
  return false;
}

// Escape hatches (QUERY-FORMAT.md section 3.5): structural forms with
// dedicated normalizer cases; every other operator lives in the registry.
const ESCAPE_KEYS = new Set(['$const', '$map']);

// The complete closed vocabulary decides JQ0002 (unknown key) versus
// JQ0003 (known keys in an invalid combination) for phrase objects.
// A function, not a precomputed set: the registry must never be read at
// module evaluation time (import cycle with operators.js). Host extension
// operators (ctx.extensions, see validateExtensions) count as vocabulary
// for the compile they were passed to.
function isVocabularyKey(key, ctx) {
  return FLWOR_KEYS.has(key) || QUANTIFIER_KEYS.has(key)
    || ESCAPE_KEYS.has(key) || hasOwn(OPERATORS, key)
    || (ctx.extensions !== null && hasOwn(ctx.extensions, key));
}

//#endregion

//#region helpers

function fail(code, message, docPath, options) {
  throw new JsonQueryCompileError(code, message, docPath, options);
}

/**
 * Project a safe diagnostic string from whatever a host hook threw:
 * no `.message` read on a raw value, no user coercion, no
 * proxy-observable reflection — the compiler must never fail while
 * describing a host failure.
 * @param {unknown} e
 * @returns {string}
 */
export function hostFailureText(e) {
  try {
    if (e instanceof Error) {
      const message = e.message;
      if (typeof message === 'string') return message;
      return 'host error (message unavailable)';
    }
  }
  catch { /* hostile classification or accessor */ }
  if (e === null) return 'null';
  const t = typeof e;
  if (t === 'string') return e.length > 80 ? e.slice(0, 80) + '…' : e;
  if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'undefined') return String(e);
  return t === 'symbol' ? 'a symbol' : t === 'function' ? 'a function' : 'an object';
}

/**
 * Deep-copy a JSON value and freeze every object/array in the copy.
 * Used for `$const` values and the compiled query's `.doc` property, so
 * the engine never freezes (or shares mutable state with) caller objects.
 * @param {any} value - a JSON value
 * @returns {any} an independent, deeply frozen copy
 */
export function deepFreezeCopy(value) {
  if (typeof value !== 'object' || value === null)
    return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++)
      out[i] = deepFreezeCopy(value[i]);
    return Object.freeze(out);
  }
  const out = {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++)
    out[keys[i]] = deepFreezeCopy(value[keys[i]]);
  return Object.freeze(out);
}

//#endregion

//#region strings (Rule 2)

function parsePathString(source, original, docPath, ctx) {
  try {
    return parseJSONPath(source, ctx.pathOptions);
  }
  catch (e) {
    /* c8 ignore next 2 -- parseJSONPath only throws syntax errors */
    if (!(e instanceof JSONPathSyntaxError))
      throw e;
    return fail('JQ0004', `'${original}' is not a valid path: ${e.message}`, docPath);
  }
}

function makeLiteral(value, docPath) {
  return Object.freeze({ kind: 'literal', card: CARD_ONE, docPath, value });
}

function makePathNode(name, rootSlot, external, rootCard, segments, docPath) {
  const singular = isSingularSegments(segments);
  const card = singular
    ? (rootCard === CARD_MANY ? CARD_MANY : CARD_OPT)
    : CARD_MANY;
  return Object.freeze({
    kind: 'path', card, docPath,
    name, rootSlot, external, rootCard, segments: deepFreeze(segments), singular,
  });
}

// resolve a variable reference: walk the lexical scope chain; a free name
// is an external parameter, allocated a slot on first appearance (spec
// section 9: use is the declaration). Under a closed-world compilation
// (options.externals), only declared names may stay free - every other
// free name is JQ0005 at its own reference site.
function resolveVariable(name, scope, ctx, docPath) {
  for (let sc = scope; sc !== null; sc = sc.parent) {
    if (sc.name === name)
      return { slot: sc.slot, card: sc.card, external: false };
  }
  let slot = ctx.externals.get(name);
  if (slot === undefined) {
    if (ctx.declaredExternals !== null && !ctx.declaredExternals.has(name)) {
      const declared = [...ctx.declaredExternals];
      fail('JQ0005', `'$${name}' is neither bound by an enclosing phrase nor a declared external`
        + (declared.length === 0
          ? ' (this query was compiled closed-world, declaring no externals)'
          : ` (declared externals: ${declared.map((n) => "'" + n + "'").join(', ')})`), docPath);
    }
    slot = ctx.nextSlot++;
    ctx.externals.set(name, slot);
  }
  // an external is bound by the caller to one JSON value: exactly one item
  return { slot, card: CARD_ONE, external: true };
}

function normalizeString(s, docPath, scope, ctx) {
  if (s.charCodeAt(0) !== 0x24) // '$'
    return makeLiteral(s, docPath);
  if (s.length === 1) // '$' alone: the input document, frame slot 0
    return Object.freeze({ kind: 'var', card: CARD_ONE, docPath, slot: 0, external: false, name: '$' });
  const c1 = s.charCodeAt(1);
  if (c1 === 0x24) // '$$' escape: drop exactly one leading '$'
    return makeLiteral(s.slice(1), docPath);
  if (c1 === 0x2E || c1 === 0x5B) { // '$.' | '$[' | '$..' - absolute path
    const ast = parsePathString(s, s, docPath, ctx);
    return makePathNode('$', 0, false, CARD_ONE, ast.segments, docPath);
  }
  const m = VAR_HEAD_RE.exec(s);
  if (m === null)
    return fail('JQ0004', `'${s}' is not a valid path or escape`, docPath);
  const name = m[1];
  const rest = s.slice(m[0].length);
  const ref = resolveVariable(name, scope, ctx, docPath);
  if (rest === '') // bare '$name': whole-variable reference
    return Object.freeze({ kind: 'var', card: ref.card, docPath, slot: ref.slot, external: ref.external, name });
  // variable-rooted path: the grammar is RFC 9535 with the root identifier
  // replaced by the variable reference - parse with a substituted '$'
  const ast = parsePathString('$' + rest, s, docPath, ctx);
  return makePathNode(name, ref.slot, ref.external, ref.card, ast.segments, docPath);
}

//#endregion

//#region objects (Rule 1)

function normalizeObject(obj, docPath, scope, ctx) {
  const keys = Object.keys(obj);
  let dollarCount = 0;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].charCodeAt(0) === 0x24)
      dollarCount++;
  }
  if (dollarCount === 0) { // map constructor ({} constructs the empty object)
    const entries = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const name = keys[i];
      entries[i] = Object.freeze({
        name,
        expr: normalizeExpr(obj[name], docPath + '/' + encodeJSONPointerSegment(name), scope, ctx),
      });
    }
    return Object.freeze({ kind: 'object', card: CARD_ONE, docPath, entries: Object.freeze(entries) });
  }
  if (dollarCount !== keys.length)
    return fail('JQ0001', 'an object cannot mix $-prefixed and plain keys', docPath);
  return normalizePhrase(obj, keys, docPath, scope, ctx);
}

function normalizePhrase(obj, keys, docPath, scope, ctx) {
  // FLWOR phrase shape: only FLWOR clause keys, $return plus $for and/or
  // $let present (section 6.1). The degenerate {$let, $return} phrase
  // keeps the direct 'let' node - it needs no tuple stream.
  let allFlwor = true;
  for (let i = 0; i < keys.length; i++) {
    if (!FLWOR_KEYS.has(keys[i])) {
      allFlwor = false;
      break;
    }
  }
  if (allFlwor && keys.length >= 2 && hasOwn(obj, '$return')
    && (hasOwn(obj, '$for') || hasOwn(obj, '$let') || hasOwn(obj, '$fold'))) {
    if (keys.length === 2 && hasOwn(obj, '$let'))
      return normalizeLetPhrase(obj, docPath, scope, ctx);
    return normalizeFlworPhrase(obj, docPath, scope, ctx);
  }
  // quantifier phrase shape (section 7): {$some|$every, $satisfies}
  if (keys.length === 2 && hasOwn(obj, '$satisfies')
    && (hasOwn(obj, '$some') || hasOwn(obj, '$every')))
    return normalizeQuantifierPhrase(obj, docPath, scope, ctx);

  if (keys.length === 1)
    return normalizeOperator(keys[0], obj[keys[0]], docPath, scope, ctx);

  // multi-key object matching no phrase shape
  for (let i = 0; i < keys.length; i++) {
    if (!isVocabularyKey(keys[i], ctx))
      return failUnknownOperator(keys[i], docPath, ctx);
  }
  return fail('JQ0003', `invalid phrase key combination (${keys.join(', ')})`, docPath);
}

//#endregion

//#region unknown operators ("did you mean")

// Bounded Levenshtein distance (two-row DP); vocabulary keys are short,
// and this only ever runs on the JQ0002 error path.
function levenshtein(a, b) {
  const alen = a.length;
  const blen = b.length;
  let prev = new Array(blen + 1);
  let curr = new Array(blen + 1);
  for (let j = 0; j <= blen; j++)
    prev[j] = j;
  for (let i = 1; i <= alen; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= blen; j++) {
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const t = prev;
    prev = curr;
    curr = t;
  }
  return prev[blen];
}

// suggestion candidates, built lazily (see the isVocabularyKey note)
let VOCABULARY_NAMES = null;

// SEMANTIC aliases — the names a writer reaches for from other query
// languages (SQL, XPath, JSONata, JS array methods) or a plausible
// synonym, which Levenshtein cannot reach because they are lexically
// far from the real operator. This is the failure mode an LLM lands in
// most: it guesses `$first`/`$filter`/`$map` and, without a pointer,
// abandons the language. Each entry is the CLOSEST real spelling; a
// value of null means "no operator does this — here is how instead".
const OPERATOR_ALIASES = {
  // sequence access
  $first: "$head", $last: "$head of $reverse", $nth: "$get", $at: "$get",
  $take: "$subsequence", $skip: "$subsequence", $slice: "$subsequence",
  $drop: "$subsequence", $limit: "$subsequence",
  // filtering / mapping / folding: these are FLWOR or a JSONPath filter,
  // not operators ($where, $map, $fold, $orderby ARE real keys and never
  // reach here — only the guesses that miss them are listed)
  $filter: "a JSONPath filter like $[?(@.x > 1)] or $where in a $for",
  $select: "a $for phrase with $return", $flatmap: "a $for phrase",
  $reduce: "$fold", $foldl: "$fold", $aggregate: "$fold",
  $group: "$groupby", "$group-by": "$groupby",
  $sortby: "$sort (sorts scalars; order objects via a $for over a sorted key)",
  "$sort-by": "$sort (scalars only)", $order: "$sort",
  // aggregates / arithmetic
  $size: "$count", $len: "$length", $abs: null, $round: null, $floor: "$idiv",
  $ceil: null, $sqrt: null, $pow: null, $modulo: "$mod", $remainder: "$mod",
  $subtract: "$sub", $multiply: "$mul", $divide: "$div", $minus: "$sub",
  $times: "$mul", $negate: "$neg", $product: "$mul", $total: "$sum",
  // strings / collections
  $join: "$string-join", $split: null, $includes: "$contains",
  $indexof: "$index-of", $find: "$index-of", $keys: "$entries",
  $values: "$entries then $get", $has: "$exists", $tostring: "$string",
  $tonumber: "$number", $len_str: "$string-length", $trim: "$normalize-space",
  $lowercase: "$lower", $uppercase: "$upper", $startswith: "$starts-with",
  $endswith: "$ends-with", $unique: "$distinct", $flatten: "a $for phrase",
  // conditionals ($coalesce is a real operator; the guesses are here)
  $case: "$if", $cond: "$if", $switch: "$if", $ternary: "$if",
  $ifnull: "$default", $ifempty: "$default", $nvl: "$default",
  // spatial: the PostGIS/Turf spellings, and the American plural
  $wkt: "$geo-parse to read one, $geo-text to write one",
  "$parse-wkt": "$geo-parse", "$from-wkt": "$geo-parse", $st_geomfromtext: "$geo-parse",
  "$to-wkt": "$geo-text", $st_astext: "$geo-text", "$geo-stringify": "$geo-text",
  "$geohash-decode": "$geohash-bounds", "$geohash-bbox": "$geohash-bounds",
  "$geohash-neighbors": "$geohash-neighbours", "$geohash-adjacent": "$geohash-neighbours",
  $simplify: "$geo-simplify", "$douglas-peucker": "$geo-simplify",
  $intersects: "$bbox-intersects (boxes only — real overlay is deliberately absent)",
  $buffer: null, $union: null, $difference: null,
  // the one absence that needs its reason, not a pointer: a projected
  // position is the same [x, y] array as a geographic one, so an
  // operator making one could not stop it reaching $distance
  $project: "the renderer — the language cannot make a projected coordinate at all, so a measurement can never land on one; measurement here is geodesic",
  "$geo-project": "the renderer, as for '$project'",
  $srid: null, $transform: null,
  // vectors: the spellings a writer reaches for from a ranking library.
  // The metric names all point at the one operator because the packed
  // form is normalized and they then rank identically; `$knn` and its
  // synonyms get the composition, because ordering and windowing are
  // clauses this language already has and a second spelling of them
  // would be the drift, not the convenience
  $cosine: "$similarity", "$cosine-similarity": "$similarity",
  "$cos-sim": "$similarity", "$dot-product": "$similarity",
  $dot: "$similarity", "$inner-product": "$similarity",
  "$vector-distance": "$similarity (higher is closer; there is no distance metric)",
  "$l2-distance": "$similarity (higher is closer; there is no distance metric)",
  $knn: "$orderby on a $similarity key with $dir 'desc', then $subsequence for the k",
  $nearest: "$orderby on a $similarity key with $dir 'desc', then $subsequence for the k",
  "$nearest-neighbours": "$orderby on a $similarity key, then $subsequence",
  "$nearest-neighbors": "$orderby on a $similarity key, then $subsequence",
  "$top-k": "$orderby then $subsequence", $embed: null, $normalize: null,
  // time series: the spellings a writer arrives with from Timescale,
  // pandas, SQL and kdb+. The bucketing family all points at the two
  // operators that exist - the scalar label and the aggregating one -
  // and the fill policies point at `$resample`, because a fill is a
  // MEMBER of a resample spec rather than an operation of its own
  $time_bucket: "$time-bucket", "$date-bin": "$time-bucket",
  $date_bin: "$time-bucket", $bucket: "$time-bucket",
  "$time-bucket-gapfill": "$resample with a 'fill'",
  $gapfill: "$resample with a 'fill'", $locf: "$resample with fill 'locf'",
  $interpolate: "$resample with fill 'linear'",
  $downsample: "$resample", $upsample: "$resample with a 'fill'",
  $rollup: "$resample", $groupbytime: "$resample",
  "$moving-average": "$rolling with aggregate 'mean'",
  $rollingwindow: "$rolling", "$time-window": "$rolling",
  "$as-of": "$asof", "$asof-join": "$asof", $aj: "$asof",
  "$merge-asof": "$asof", "$latest-at": "$asof",
  $overlap: "$overlaps", "$interval-overlaps": "$overlaps",
  $during: "$overlaps", $meets: null, $abuts: null,
  $now: null, "$current-timestamp": null,
};

// JQ0002 for an unknown $-key, with a "did you mean" suggestion. A
// curated SEMANTIC alias wins first (the cross-language guesses
// Levenshtein misses); otherwise the nearest vocabulary key within
// Levenshtein distance 2. Compile-time only; with host extensions the
// candidate list is built per call.
function failUnknownOperator(key, docPath, ctx) {
  if (hasOwn(OPERATOR_ALIASES, key)) {
    const target = OPERATOR_ALIASES[key];
    const hint = target === null
      ? ' (no operator does this in jaren-query)'
      : ` (use ${target.startsWith('$') && !target.includes(' ') ? `'${target}'` : target})`;
    return fail('JQ0002', `unknown operator '${key}'${hint}`, docPath);
  }
  if (VOCABULARY_NAMES === null) {
    VOCABULARY_NAMES = [
      ...FLWOR_KEYS, ...QUANTIFIER_KEYS, ...ESCAPE_KEYS, ...Object.keys(OPERATORS),
    ];
  }
  const candidates = ctx.extensions === null
    ? VOCABULARY_NAMES
    : [...VOCABULARY_NAMES, ...Object.keys(ctx.extensions)];
  let best = null;
  let bestDist = 3;
  for (let i = 0; i < candidates.length; i++) {
    const name = candidates[i];
    const lenDiff = key.length - name.length;
    if (lenDiff > 2 || lenDiff < -2)
      continue;
    const d = levenshtein(key, name);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  const hint = best === null ? '' : ` (did you mean '${best}'?)`;
  return fail('JQ0002', `unknown operator '${key}'${hint}`, docPath);
}

//#endregion

//#region operators

function requireExprArray(op, arg, min, max, docPath) {
  if (!Array.isArray(arg))
    return fail('JQ0003', `'${op}' takes an array of expressions`, docPath);
  if (arg.length < min || arg.length > max) {
    const arity = min === max ? `exactly ${min}` : (max === Infinity ? `at least ${min}` : `${min} to ${max}`);
    return fail('JQ0003', `'${op}' takes ${arity} operand(s), got ${arg.length}`, docPath);
  }
  return arg;
}

function normalizeElements(arg, docPath, scope, ctx) {
  const out = new Array(arg.length);
  for (let i = 0; i < arg.length; i++)
    out[i] = normalizeExpr(arg[i], docPath + '/' + i, scope, ctx);
  return Object.freeze(out);
}

// A JSON Schema literal (the raw schema argument of $valid/$assert and
// the $as clause, QUERY-FORMAT.md section 8.11): taken verbatim - never
// normalized as an expression, since JSON Schema keywords are $-prefixed
// ($ref, $defs) and must not collide with Rule 1 - deep-copied + frozen
// like $const, and compiled once, at query compile time, into a hot-path
// boolean predicate by the host-installed `options.compileTypeTest` hook.
// No hook installed is JQ0008; a hook rejection (invalid schema) is
// JQ0009, both at the owning operator's/clause's docPath.
function compileSchemaLiteral(value, schemaPath, opPath, ctx) {
  if (ctx.compileTypeTest === null) {
    // Analysis mode (QUERY-FORMAT.md Appendix C.1): the schema literal
    // normalizes without a compiled predicate, so a consumer can analyse
    // a document it could not execute. Strictly opt-in — compilation
    // never sets ctx.analysis, so its behaviour is untouched.
    if (ctx.analysis)
      return { schema: deepFreezeCopy(value), test: null };
    fail('JQ0008', 'schema operators require a type-test compiler (options.compileTypeTest)', opPath);
  }
  const schema = deepFreezeCopy(value);
  let test;
  try {
    test = ctx.compileTypeTest(schema, schemaPath);
  }
  catch (e) {
    fail('JQ0009', `invalid schema literal: ${hostFailureText(e)}`, opPath, { cause: e });
  }
  if (typeof test !== 'function')
    fail('JQ0009', 'the type-test compiler did not return a predicate function', opPath);
  return { schema, test };
}

// The inert raw node: a verbatim JSON value captured as compile-time
// data - deep-copied and frozen, walked by nothing, never compiled
// (compileOp hands 'raw' positions a null getter). Also exposed to host
// extension operators through the `normalize` override helpers.
function makeRaw(value, docPath) {
  return Object.freeze({ kind: 'raw', card: CARD_ONE, docPath, value: deepFreezeCopy(value) });
}

// One argument position of a registry operator, per its declared kind:
// 'expr' normalizes an ordinary expression; 'raw' captures the value
// verbatim, unevaluated; 'schema' is 'raw' plus a compiled type-test
// predicate, for schema-literal arguments (`compileSchemaLiteral`); 'name'
// captures a validated variable name string. 'raw', 'schema' and 'name'
// produce inert `raw` nodes - compile-time data, never compiled.
function normalizeArg(kind, value, argPath, scope, ctx, opPath) {
  if (kind === 'expr')
    return normalizeExpr(value, argPath, scope, ctx);
  if (kind === 'raw')
    return makeRaw(value, argPath);
  if (kind === 'schema') {
    const { schema, test } = compileSchemaLiteral(value, argPath, opPath, ctx);
    return Object.freeze({ kind: 'raw', card: CARD_ONE, docPath: argPath, value: schema, test });
  }
  // 'name'
  if (typeof value !== 'string' || !VAR_NAME_RE.test(value))
    fail('JQ0003', 'expected a variable name string', argPath);
  return Object.freeze({ kind: 'raw', card: CARD_ONE, docPath: argPath, value });
}

// Argument list of an operator call, uniformly from its `params`
// descriptor (arity and shape violations are JQ0003).
function normalizeParams(key, params, arg, opPath, scope, ctx) {
  if (typeof params === 'string') // the single form: the value IS the argument
    return [normalizeArg(params, arg, opPath, scope, ctx, opPath)];
  const kinds = params.kinds;
  const max = params.variadic === true ? Infinity : kinds.length;
  const list = requireExprArray(key, arg, params.min, max, opPath);
  const args = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const kind = kinds[i < kinds.length ? i : kinds.length - 1];
    args[i] = normalizeArg(kind, list[i], opPath + '/' + i, scope, ctx, opPath);
  }
  return args;
}

function argCards(args) {
  const cards = new Array(args.length);
  for (let i = 0; i < args.length; i++)
    cards[i] = args[i].card;
  return cards;
}

// The operators that read a calendar boundary, and so may be given a
// named zone. `$asof` and `$overlaps` are pure instant arithmetic and
// have no clock to resolve.
const CLOCK_OPERATORS = new Set(['$time-bucket', '$resample', '$rolling']);

// A registry operator call: arity and shape come uniformly from the
// table's `params` descriptor (JQ0003), the static cardinality from its
// `result` - individual operators never re-check structure.
function normalizeOperatorCall(key, entry, arg, docPath, opPath, scope, ctx) {
  const args = normalizeParams(key, entry.params, arg, opPath, scope, ctx);
  /** @type {any} */
  const node = {
    kind: 'op', card: entry.result(argCards(args)), docPath, name: key, args: Object.freeze(args),
  };
  // $range materializes its whole result: the resource guard becomes
  // configurable through the compilation's limits (compileOp hands the
  // node through to the entry's compile)
  if (key === '$range' && ctx.limits !== null) node.limits = ctx.limits;
  // the series operators resolve their wall clock when the query
  // compiles, and a named zone needs the tzdb this suite does not bundle
  // (SERIES D7). The provider is a compilation capability, like a
  // collation, so it reaches the entry the same way $range's guard does
  if (ctx.zoneProvider !== null && CLOCK_OPERATORS.has(key)) node.zoneProvider = ctx.zoneProvider;
  return Object.freeze(node);
}

// Helpers handed to an extension entry's `normalize` override; see
// normalizeExtensionCall. Function declarations hoist, so freezing at
// module evaluation time is safe.
const EXTENSION_HELPERS = Object.freeze({ normalizeExpr, fail, makeRaw });

// A host extension operator call (options.extensions, package-internal):
// the registry contract plus an optional `normalize(arg, docPath, opPath,
// scope, ctx, helpers) -> { args, card? }` override for operators whose
// value shape the uniform `params` descriptor cannot express. `helpers`
// is `{ normalizeExpr, fail, makeRaw }`. The op node is built uniformly
// from the returned args - `card = card ?? entry.result(argCards)` - and
// carries the resolved entry so compileOp can dispatch without the table.
function normalizeExtensionCall(key, entry, arg, docPath, opPath, scope, ctx) {
  let args;
  let card = null;
  if (typeof entry.normalize === 'function') {
    const out = entry.normalize(arg, docPath, opPath, scope, ctx, EXTENSION_HELPERS);
    args = Object.freeze(out.args.slice());
    card = out.card ?? null;
  }
  else {
    args = Object.freeze(normalizeParams(key, entry.params, arg, opPath, scope, ctx));
  }
  return Object.freeze({
    kind: 'op', card: card ?? entry.result(argCards(args)), docPath, name: key, args, entry,
  });
}

function normalizeOperator(key, arg, docPath, scope, ctx) {
  const opPath = docPath + '/' + key;
  ctx.usedOps.add(key); // dependency reporting (query.explain)
  switch (key) {
    case '$lexical': {
      const normalized = normalizeLexical(ctx.lexicalProviders, arg, opPath, EXTENSION_HELPERS, scope, ctx);
      return Object.freeze({ kind: 'op', card: CARD_ONE, docPath, name: key, ...normalized });
    }
    case '$const': // quote: verbatim single item, nothing inside evaluated
      return Object.freeze({ kind: 'literal', card: CARD_ONE, docPath, value: deepFreezeCopy(arg) });

    case '$call': { // a registered trusted host function (options.functions)
      if (!Array.isArray(arg) || arg.length < 1 || typeof arg[0] !== 'string')
        return fail('JQ0010', "'$call' requires ['name', ...argument expressions]", opPath);
      const name = arg[0];
      const fn = ctx.functions !== null && hasOwn(ctx.functions, name)
        ? ctx.functions[name]
        : undefined;
      if (fn === undefined)
        return fail('JQ0010', `'$call' names no registered function '${name}'`, opPath);
      ctx.usedFunctions.add(name);
      const callArgs = new Array(arg.length - 1);
      for (let i = 1; i < arg.length; i++)
        callArgs[i - 1] = normalizeExpr(arg[i], opPath + '/' + i, scope, ctx);
      return Object.freeze({
        kind: 'call', card: CARD_OPT, docPath, name, fn,
        args: Object.freeze(callArgs),
      });
    }

    case '$map': { // general map constructor (section 3.5.2)
      const list = requireExprArray(key, arg, 0, Infinity, opPath);
      const pairs = new Array(list.length);
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        const entryPath = opPath + '/' + i;
        if (!Array.isArray(entry) || entry.length !== 2)
          return fail('JQ0003', 'a $map entry must be an array of exactly two expressions', entryPath);
        pairs[i] = Object.freeze({
          key: normalizeExpr(entry[0], entryPath + '/0', scope, ctx),
          value: normalizeExpr(entry[1], entryPath + '/1', scope, ctx),
        });
      }
      return Object.freeze({ kind: 'map', card: CARD_ONE, docPath, pairs: Object.freeze(pairs) });
    }

    default: {
      // the registry vocabulary (section 8); note the section 6.7
      // collision rule holds by construction: a single-key {"$count": e}
      // object always reaches this lookup and is the operator
      if (hasOwn(OPERATORS, key))
        return normalizeOperatorCall(key, OPERATORS[key], arg, docPath, opPath, scope, ctx);
      // host extension operators: after the core registry, before JQ0002
      if (ctx.extensions !== null && hasOwn(ctx.extensions, key))
        return normalizeExtensionCall(key, ctx.extensions[key], arg, docPath, opPath, scope, ctx);
      if (FLWOR_KEYS.has(key) || QUANTIFIER_KEYS.has(key))
        return fail('JQ0003', `'${key}' cannot form a phrase on its own`, docPath);
      return failUnknownOperator(key, docPath, ctx);
    }
  }
}

//#endregion

//#region FLWOR and quantifier phrases

// One JQ0007 duplicate set spans all of a phrase's binding sites: $for
// names, $at names, $let names, $groupby key names, and the $count name
// (section 6.3). Rebinding a name from an enclosing phrase is ordinary
// shadowing and never hits this check.
function bindPhraseName(name, phraseNames, bindPath) {
  if (!VAR_NAME_RE.test(name))
    fail('JQ0003', `'${name}' is not a valid variable name`, bindPath);
  if (phraseNames.has(name))
    fail('JQ0007', `duplicate binding of variable '${name}' within one phrase`, bindPath);
  phraseNames.add(name);
}

function requireBindingObject(clause, bindObj, clausePath) {
  if (!isJsonObject(bindObj))
    fail('JQ0003', `'${clause}' takes an object of variable bindings`, clausePath);
  const names = Object.keys(bindObj);
  if (names.length === 0)
    fail('JQ0003', `'${clause}' requires at least one binding`, clausePath);
  return names;
}

// $let bindings (section 6.3): each name binds the full sequence of its
// expression - no iteration, no array unpacking. Bindings evaluate
// sequentially in document key order; later sources see earlier names of
// the same object (correlation). Shared by the degenerate {$let, $return}
// phrase and the full FLWOR normalizer; returns the extended scope.
function normalizeLetBindings(letObj, letPath, scope, ctx, phraseNames, bindings) {
  const names = requireBindingObject('$let', letObj, letPath);
  let sc = scope;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const bindPath = letPath + '/' + encodeJSONPointerSegment(name);
    bindPhraseName(name, phraseNames, bindPath);
    const source = letObj[name];
    if (isExtendedBinding(source))
      return fail('JQ0003', "the extended binding form is not available in '$let'", bindPath);
    const expr = normalizeExpr(source, bindPath, sc, ctx);
    const slot = ctx.nextSlot++;
    sc = { name, slot, card: expr.card, parent: sc };
    bindings.push(Object.freeze({ name, slot, expr }));
  }
  return sc;
}

// The degenerate FLWOR phrase {$let, $return}: a straight-line binding
// chain, no tuple stream (the compiler keeps its direct fast path).
function normalizeLetPhrase(obj, docPath, scope, ctx) {
  const bindings = [];
  const sc = normalizeLetBindings(obj.$let, docPath + '/$let', scope, ctx, new Set(), bindings);
  const ret = normalizeExpr(obj.$return, docPath + '/$return', sc, ctx);
  return Object.freeze({
    kind: 'let', card: ret.card, docPath,
    bindings: Object.freeze(bindings), ret,
  });
}

// The window specification of an extended $for binding (section 6.10).
// `$size`/`$step` are integer literals, not expressions: a window width
// that varied per tuple could not be compiled into a specialized loop,
// and no use has asked for one.
//
// A **tumbling** window partitions the item stream - every item lands in
// exactly one window - so its final window is kept even when short,
// because dropping it would silently lose data. A **sliding** window is
// a moving view of fixed width, so a short window is not one of them and
// the tail is not emitted. That is the whole rule.
function normalizeWindowSpec(source, bindPath) {
  const kind = source.$window;
  if (kind !== 'tumbling' && kind !== 'sliding')
    return fail('JQ0003', "'$window' must be 'tumbling' or 'sliding'", bindPath + '/$window');
  if (!hasOwn(source, '$size'))
    return fail('JQ0003', "a '$window' binding requires '$size'", bindPath);
  const size = source.$size;
  if (!Number.isInteger(size) || size < 1)
    return fail('JQ0003', "'$size' must be a positive integer", bindPath + '/$size');
  let step = kind === 'tumbling' ? size : 1;
  if (hasOwn(source, '$step')) {
    step = source.$step;
    if (!Number.isInteger(step) || step < 1)
      return fail('JQ0003', "'$step' must be a positive integer", bindPath + '/$step');
  }
  return Object.freeze({ sliding: kind === 'sliding', size, step });
}

// $for bindings (section 6.2): each name iterates its source, one item
// per tuple (card ONE), with D4 array unpacking at runtime. The extended
// {"$in": expr, "$at": name} form additionally binds a 0-based position
// (D6). Multiple bindings nest left-to-right in document key order and
// may be correlated. Returns the extended scope.
function normalizeForBindings(forObj, forPath, scope, ctx, phraseNames, bindings, tupleSlots) {
  const names = requireBindingObject('$for', forObj, forPath);
  let sc = scope;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const bindPath = forPath + '/' + encodeJSONPointerSegment(name);
    bindPhraseName(name, phraseNames, bindPath);
    let source = forObj[name];
    let sourcePath = bindPath;
    let atName = null;
    let allowingEmpty = false;
    let window = null;
    if (isExtendedBinding(source)) {
      const bindKeys = Object.keys(source);
      for (let k = 0; k < bindKeys.length; k++) {
        if (!FOR_BINDING_KEYS.has(bindKeys[k]))
          return fail('JQ0003', `'${bindKeys[k]}' is not a valid key of an extended '$for' binding`, bindPath);
      }
      if (!hasOwn(source, '$in'))
        return fail('JQ0003', "an extended '$for' binding requires '$in'", bindPath);
      if (hasOwn(source, '$at')) {
        atName = source.$at;
        if (typeof atName !== 'string' || !VAR_NAME_RE.test(atName))
          return fail('JQ0003', "'$at' takes a variable name string", bindPath + '/$at');
      }
      if (hasOwn(source, '$allowing-empty')) {
        if (typeof source['$allowing-empty'] !== 'boolean')
          return fail('JQ0003', "'$allowing-empty' takes a boolean", bindPath + '/$allowing-empty');
        allowingEmpty = source['$allowing-empty'];
      }
      if (hasOwn(source, '$window'))
        window = normalizeWindowSpec(source, bindPath);
      else if (hasOwn(source, '$size') || hasOwn(source, '$step'))
        return fail('JQ0003', "'$size'/'$step' require '$window'", bindPath);
      source = source.$in;
      sourcePath = bindPath + '/$in';
    }
    const expr = normalizeExpr(source, sourcePath, sc, ctx);
    const slot = ctx.nextSlot++;
    // a window variable holds the window's items, and an $allowing-empty
    // binding may hold the empty sequence: neither is the plain
    // exactly-one-item binding the compiler specializes for
    const bindCard = window !== null ? CARD_MANY : (allowingEmpty ? CARD_OPT : CARD_ONE);
    sc = { name, slot, card: bindCard, parent: sc };
    tupleSlots.push({ name, slot });
    let atSlot = -1;
    if (atName !== null) {
      bindPhraseName(atName, phraseNames, bindPath + '/$at');
      atSlot = ctx.nextSlot++;
      sc = { name: atName, slot: atSlot, card: CARD_ONE, parent: sc };
      tupleSlots.push({ name: atName, slot: atSlot });
    }
    bindings.push(Object.freeze({ name, slot, expr, atSlot, allowingEmpty, window }));
  }
  return sc;
}

// One $orderby key spec (section 6.6): an expression (ascending,
// empty-least) or the explicit {"$key", "$dir"?, "$empty"?,
// "$collation"?} form. A $collation names a registered pure compare
// function (options.collations) applied to STRING keys; number keys
// keep numeric order.
function normalizeOrderbySpec(spec, specPath, scope, ctx) {
  let key = spec;
  let keyPath = specPath;
  let desc = false;
  let emptyGreatest = false;
  let collation = null;
  let collationName = null;
  if (isJsonObject(spec)
    && (hasOwn(spec, '$key') || hasOwn(spec, '$dir') || hasOwn(spec, '$empty') || hasOwn(spec, '$collation'))) {
    const specKeys = Object.keys(spec);
    for (let i = 0; i < specKeys.length; i++) {
      if (!ORDERBY_SPEC_KEYS.has(specKeys[i]))
        return fail('JQ0003', `'${specKeys[i]}' is not a valid key of an $orderby key spec`, specPath);
    }
    if (!hasOwn(spec, '$key'))
      return fail('JQ0003', "an explicit $orderby key spec requires '$key'", specPath);
    if (hasOwn(spec, '$dir')) {
      if (spec.$dir !== 'asc' && spec.$dir !== 'desc')
        return fail('JQ0003', "'$dir' must be 'asc' or 'desc'", specPath + '/$dir');
      desc = spec.$dir === 'desc';
    }
    if (hasOwn(spec, '$empty')) {
      if (spec.$empty !== 'least' && spec.$empty !== 'greatest')
        return fail('JQ0003', "'$empty' must be 'least' or 'greatest'", specPath + '/$empty');
      emptyGreatest = spec.$empty === 'greatest';
    }
    if (hasOwn(spec, '$collation')) {
      if (typeof spec.$collation !== 'string')
        return fail('JQ0003', "'$collation' must be a registered collation name", specPath + '/$collation');
      collationName = spec.$collation;
      collation = ctx.collations !== null && hasOwn(ctx.collations, collationName)
        ? ctx.collations[collationName]
        : undefined;
      if (collation === undefined)
        return fail('JQ0010', `'$collation' names no registered collation '${collationName}'`, specPath + '/$collation');
      ctx.usedCollations.add(collationName);
    }
    key = spec.$key;
    keyPath = specPath + '/$key';
  }
  return Object.freeze({
    key: normalizeExpr(key, keyPath, scope, ctx),
    desc, emptyGreatest, collation, collationName, docPath: specPath,
  });
}

// Barrier liveness: $groupby/$orderby materialize only the phrase
// binding slots that later clauses read. Slots written by nested phrases
// before being read merely widen a snapshot harmlessly. The hash-join
// planner (compile.js) reuses this to prove a probe side uncorrelated.
/**
 * Collect the frame slots an expression subtree reads (variable
 * references and path roots) into `out`. Over-approximation is safe.
 * @param {object} node - a frozen AST node
 * @param {Set<number>} out - accumulator of slot indexes
 */
export function collectReadSlots(node, out) {
  switch (node.kind) {
    case 'literal':
      return;
    case 'var':
      out.add(node.slot);
      return;
    case 'path':
      out.add(node.rootSlot);
      return;
    case 'object':
      for (let i = 0; i < node.entries.length; i++)
        collectReadSlots(node.entries[i].expr, out);
      return;
    case 'map':
      for (let i = 0; i < node.pairs.length; i++) {
        collectReadSlots(node.pairs[i].key, out);
        collectReadSlots(node.pairs[i].value, out);
      }
      return;
    case 'array':
      for (let i = 0; i < node.elements.length; i++)
        collectReadSlots(node.elements[i], out);
      return;
    case 'raw': // compile-time data of a registry operator, never evaluated
      return;
    case 'op':
    case 'call':
      for (let i = 0; i < node.args.length; i++)
        collectReadSlots(node.args[i], out);
      return;
    case 'let':
      for (let i = 0; i < node.bindings.length; i++)
        collectReadSlots(node.bindings[i].expr, out);
      collectReadSlots(node.ret, out);
      return;
    case 'quant':
      for (let i = 0; i < node.bindings.length; i++)
        collectReadSlots(node.bindings[i].expr, out);
      collectReadSlots(node.satisfies, out);
      return;
    default: { // 'flwor'
      if (node.fold !== null)
        collectReadSlots(node.fold.expr, out);
      for (let i = 0; i < node.forBindings.length; i++)
        collectReadSlots(node.forBindings[i].expr, out);
      for (let i = 0; i < node.letBindings.length; i++)
        collectReadSlots(node.letBindings[i].expr, out);
      if (node.asChecks !== null) { // reads its own binding slots per tuple
        for (let i = 0; i < node.asChecks.length; i++)
          out.add(node.asChecks[i].slot);
      }
      if (node.where !== null)
        collectReadSlots(node.where, out);
      if (node.groupby !== null) {
        for (let i = 0; i < node.groupby.keys.length; i++)
          collectReadSlots(node.groupby.keys[i].expr, out);
      }
      if (node.orderby !== null) {
        for (let i = 0; i < node.orderby.specs.length; i++)
          collectReadSlots(node.orderby.specs[i].key, out);
      }
      collectReadSlots(node.ret, out);
      return;
    }
  }
}

// The full FLWOR phrase (section 6). Clauses normalize - and their
// bindings scope - in the fixed semantic order of section 6.1 (D7):
// $for -> $let -> $as -> $where -> $groupby -> $orderby -> $count -> $return.
// A $groupby rebinds the phrase's tuple variables for every later
// clause: key names become singletons (card OPT: a key may be the empty
// sequence), every other binding becomes the sequence of its values
// across the group's tuples (card MANY) - same slots, new static cards.
function normalizeFlworPhrase(obj, docPath, scope, ctx) {
  const phraseNames = new Set();
  const tupleSlots = []; // {name, slot} per pre-group binding site, in order
  const forBindings = [];
  const letBindings = [];
  let sc = scope;

  // $fold (section 6.9): the accumulator clause. Its initial value is
  // evaluated ONCE, in the enclosing scope, before the tuple stream
  // starts; $return then yields the accumulator's next value per
  // surviving tuple, and the phrase's value is the final accumulator
  // instead of the collected $return sequence. This is what gives the
  // language its fold without giving JSON a way to spell a function
  // value: the accumulator is a binding, not a lambda parameter.
  let fold = null;
  if (hasOwn(obj, '$fold')) {
    const foldPath = docPath + '/$fold';
    const names = requireBindingObject('$fold', obj.$fold, foldPath);
    if (names.length !== 1)
      return fail('JQ0003', "'$fold' takes exactly one accumulator binding", foldPath);
    const name = names[0];
    const bindPath = foldPath + '/' + encodeJSONPointerSegment(name);
    bindPhraseName(name, phraseNames, bindPath);
    // the initial value cannot see this phrase's own bindings
    const expr = normalizeExpr(obj.$fold[name], bindPath, scope, ctx);
    fold = { name, slot: ctx.nextSlot++, expr, docPath: bindPath };
  }

  if (hasOwn(obj, '$for'))
    sc = normalizeForBindings(obj.$for, docPath + '/$for', sc, ctx, phraseNames, forBindings, tupleSlots);
  // the accumulator binds after $for - a $for source is iterated once and
  // must not depend on a value that changes per tuple - and before $let,
  // so later clauses can read it. Group/order barriers consume their
  // prefix before returns update the accumulator; that prefix sees init.
  if (fold !== null)
    sc = { name: fold.name, slot: fold.slot, card: CARD_MANY, parent: sc };
  if (hasOwn(obj, '$let')) {
    const before = letBindings.length;
    sc = normalizeLetBindings(obj.$let, docPath + '/$let', sc, ctx, phraseNames, letBindings);
    for (let i = before; i < letBindings.length; i++)
      tupleSlots.push({ name: letBindings[i].name, slot: letBindings[i].slot });
  }

  // $as (section 6.4): schema assertions on the phrase's own bindings,
  // applied per tuple after $for/$let and before $where. A $for/$at
  // variable is validated as its one bound item; a $let variable per item
  // of its bound sequence. The names must be binding sites of THIS phrase
  // (JQ0005 otherwise); each schema compiles once via compileSchemaLiteral.
  let asChecks = null;
  if (hasOwn(obj, '$as')) {
    const asPath = docPath + '/$as';
    const asObj = obj.$as;
    if (!isJsonObject(asObj))
      return fail('JQ0003', "'$as' takes an object of variable-name to schema members", asPath);
    const names = Object.keys(asObj);
    if (names.length === 0)
      return fail('JQ0003', "'$as' requires at least one member", asPath);
    const checks = new Array(names.length);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const checkPath = asPath + '/' + encodeJSONPointerSegment(name);
      let slot = -1;
      for (let j = 0; j < tupleSlots.length; j++) {
        if (tupleSlots[j].name === name) {
          slot = tupleSlots[j].slot;
          break;
        }
      }
      if (slot < 0)
        return fail('JQ0005', `'$as' names '${name}', which is not bound by this phrase's '$for'/'$let'`, checkPath);
      let isLet = false;
      for (let j = 0; j < letBindings.length; j++) {
        if (letBindings[j].name === name) {
          isLet = true;
          break;
        }
      }
      const { schema, test } = compileSchemaLiteral(asObj[name], checkPath, checkPath, ctx);
      checks[i] = Object.freeze({ name, slot, isLet, schema, test, docPath: checkPath });
    }
    asChecks = Object.freeze(checks);
  }

  const where = hasOwn(obj, '$where')
    ? normalizeExpr(obj.$where, docPath + '/$where', sc, ctx)
    : null;

  let groupby = null;
  if (hasOwn(obj, '$groupby')) {
    const groupPath = docPath + '/$groupby';
    const names = requireBindingObject('$groupby', obj.$groupby, groupPath);
    const keys = new Array(names.length);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const bindPath = groupPath + '/' + encodeJSONPointerSegment(name);
      bindPhraseName(name, phraseNames, bindPath);
      // key expressions evaluate per tuple, in the pre-group scope
      const expr = normalizeExpr(obj.$groupby[name], bindPath, sc, ctx);
      keys[i] = Object.freeze({ name, slot: ctx.nextSlot++, expr, docPath: bindPath });
    }
    // post-group scope: same slots, rebound cards
    sc = scope;
    // the accumulator is not a tuple variable - $groupby does not rebind
    // it, it keeps accumulating, now once per group
    if (fold !== null)
      sc = { name: fold.name, slot: fold.slot, card: CARD_MANY, parent: sc };
    for (let i = 0; i < tupleSlots.length; i++)
      sc = { name: tupleSlots[i].name, slot: tupleSlots[i].slot, card: CARD_MANY, parent: sc };
    for (let i = 0; i < keys.length; i++)
      sc = { name: keys[i].name, slot: keys[i].slot, card: CARD_OPT, parent: sc };
    groupby = { keys: Object.freeze(keys), docPath: groupPath, accSlots: null };
  }

  let orderby = null;
  if (hasOwn(obj, '$orderby')) {
    const orderPath = docPath + '/$orderby';
    const raw = obj.$orderby;
    let specs;
    if (Array.isArray(raw)) { // always a list of key specs, major to minor
      if (raw.length === 0)
        return fail('JQ0003', "'$orderby' takes a key spec or a non-empty array of key specs", orderPath);
      specs = new Array(raw.length);
      for (let i = 0; i < raw.length; i++)
        specs[i] = normalizeOrderbySpec(raw[i], orderPath + '/' + i, sc, ctx);
    }
    else {
      specs = [normalizeOrderbySpec(raw, orderPath, sc, ctx)];
    }
    orderby = { specs: Object.freeze(specs), docPath: orderPath, liveSlots: null };
  }

  let count = null;
  if (hasOwn(obj, '$count')) {
    const countPath = docPath + '/$count';
    const name = obj.$count;
    if (typeof name !== 'string')
      return fail('JQ0003', "'$count' takes a variable name string", countPath);
    bindPhraseName(name, phraseNames, countPath);
    const slot = ctx.nextSlot++;
    sc = { name, slot, card: CARD_ONE, parent: sc };
    count = Object.freeze({ name, slot });
  }

  const ret = normalizeExpr(obj.$return, docPath + '/$return', sc, ctx);

  // barrier liveness (compile-time): $groupby accumulates - and $orderby
  // snapshots - only the binding slots that later clauses actually read.
  // The $count slot is written after both barriers and is never live.
  const retReads = new Set();
  collectReadSlots(ret, retReads);
  if (groupby !== null) {
    const laterReads = new Set(retReads);
    if (orderby !== null) {
      for (let i = 0; i < orderby.specs.length; i++)
        collectReadSlots(orderby.specs[i].key, laterReads);
    }
    const accSlots = [];
    for (let i = 0; i < tupleSlots.length; i++) {
      if (laterReads.has(tupleSlots[i].slot))
        accSlots.push(tupleSlots[i].slot);
    }
    groupby.accSlots = Object.freeze(accSlots);
  }
  if (orderby !== null) {
    // slots that still vary per tuple at the $orderby barrier
    const barrierSlots = [];
    if (groupby !== null) {
      for (let i = 0; i < groupby.keys.length; i++)
        barrierSlots.push(groupby.keys[i].slot);
      for (let i = 0; i < groupby.accSlots.length; i++)
        barrierSlots.push(groupby.accSlots[i]);
    }
    else {
      for (let i = 0; i < tupleSlots.length; i++)
        barrierSlots.push(tupleSlots[i].slot);
    }
    const liveSlots = [];
    for (let i = 0; i < barrierSlots.length; i++) {
      if (retReads.has(barrierSlots[i]))
        liveSlots.push(barrierSlots[i]);
    }
    orderby.liveSlots = Object.freeze(liveSlots);
  }

  // phrase cardinality: MANY unless provably otherwise - a $let-only
  // phrase yields exactly one tuple ($where may still drop it)
  let card;
  if (fold !== null)
    // the phrase IS the accumulator: either it never updated (the initial
    // value) or it holds some $return result
    card = joinCard(fold.expr.card, ret.card);
  else if (forBindings.length !== 0 || groupby !== null)
    card = CARD_MANY;
  else
    card = where !== null ? joinCard(ret.card, CARD_ZERO) : ret.card;

  return Object.freeze({
    kind: 'flwor', card, docPath,
    fold: fold === null ? null : Object.freeze(fold),
    forBindings: Object.freeze(forBindings),
    letBindings: Object.freeze(letBindings),
    asChecks, where,
    groupby: groupby === null ? null : Object.freeze(groupby),
    orderby: orderby === null ? null : Object.freeze(orderby),
    count, ret,
    limits: ctx.limits,
  });
}

// Quantifier phrases (section 7): {$some|$every, $satisfies}. The
// binding object follows $for rules (names, key-order nesting,
// correlation, D4 unpacking) except the extended $in/$at form (JQ0003).
function normalizeQuantifierPhrase(obj, docPath, scope, ctx) {
  const some = hasOwn(obj, '$some');
  const clause = some ? '$some' : '$every';
  const clausePath = docPath + '/' + clause;
  const bindObj = obj[clause];
  const names = requireBindingObject(clause, bindObj, clausePath);
  const phraseNames = new Set();
  const bindings = new Array(names.length);
  let sc = scope;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const bindPath = clausePath + '/' + encodeJSONPointerSegment(name);
    bindPhraseName(name, phraseNames, bindPath);
    const source = bindObj[name];
    if (isExtendedBinding(source))
      return fail('JQ0003', 'the extended binding form is not available in quantifiers', bindPath);
    const expr = normalizeExpr(source, bindPath, sc, ctx);
    const slot = ctx.nextSlot++;
    sc = { name, slot, card: CARD_ONE, parent: sc };
    bindings[i] = Object.freeze({ name, slot, expr });
  }
  const satisfies = normalizeExpr(obj.$satisfies, docPath + '/$satisfies', sc, ctx);
  return Object.freeze({
    kind: 'quant', card: CARD_ONE, docPath, some,
    bindings: Object.freeze(bindings), satisfies,
  });
}

//#endregion

//#region entry points

// Validate `options.extensions` (package-internal, used by the JSLT
// layer; not a public contract): a plain object of `name -> entry`.
// Every name must start with '$' and must not collide with the core
// vocabulary - the closed format is unchanged, extensions are host
// machinery. Violations are host programming errors (TypeError), not
// JQ0xxx document errors.
// True when `name` is already part of the closed query vocabulary — a
// FLWOR/quantifier/escape key, a reserved member, or a core operator.
// A host extension (options.extensions) or a registry pack (the JSLT
// operator registry) must not shadow any of these. Exported so the
// registry builder can reject a colliding pack at `.use()` time with the
// same rule the compiler enforces at normalize time.
export function isReservedQueryName(name) {
  return FLWOR_KEYS.has(name) || QUANTIFIER_KEYS.has(name) || ESCAPE_KEYS.has(name)
    || ORDERBY_SPEC_KEYS.has(name) || name === '$in' || name === '$at'
    || name === '$query' || name === '$expr' || hasOwn(OPERATORS, name);
}

function validateExtensions(extensions) {
  if (!isJsonObject(extensions))
    throw new TypeError('options.extensions must be a plain object of operator entries');
  const names = Object.keys(extensions);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name.charCodeAt(0) !== 0x24) // '$'
      throw new TypeError(`extension operator '${name}' must start with '$'`);
    if (isReservedQueryName(name))
      throw new TypeError(`extension operator '${name}' collides with the core vocabulary`);
  }
  return extensions;
}

// Validate a named registry of trusted pure host functions
// (options.functions / options.collations): a plain object of
// `name -> function`. Violations are host programming errors
// (TypeError), like options.extensions.
function validateNamedFunctions(value, what) {
  if (!isJsonObject(value))
    throw new TypeError(`options.${what} must be a plain object of named functions`);
  for (const name in value) {
    // the schema twins require non-empty names (minLength 1); the
    // registry enforces the same, so document and runtime agree
    if (name === '')
      throw new TypeError(`options.${what} must not register an empty-string name`);
    if (typeof value[name] !== 'function')
      throw new TypeError(`options.${what}['${name}'] must be a function`);
  }
  return value;
}

// Validate the injected time-zone provider (options.zoneProvider): the
// two-question seam SERIES D7 fixes, because this suite bundles no
// tzdb and a JSON document cannot carry one. Violations are host
// programming errors (TypeError), like options.extensions.
function validateZoneProvider(value) {
  if (value === null || typeof value !== 'object'
    || typeof value.toParts !== 'function' || typeof value.toEpoch !== 'function') {
    throw new TypeError('options.zoneProvider must be an object with'
      + ' toParts(epoch, zone) and toEpoch(parts, zone, disambiguation)');
  }
  return value;
}

// The known limits (section 8.12). Only limits the engine actually
// enforces are accepted - an accepted-but-unenforced limit would be a
// silent false guarantee.
const LIMIT_NAMES = new Set(['sequenceItems', 'resultItems', 'steps', 'depth']);

function validateLimits(value) {
  if (!isJsonObject(value))
    throw new TypeError('options.limits must be a plain object');
  for (const name in value) {
    if (!LIMIT_NAMES.has(name))
      throw new TypeError(`options.limits.${name} is not a known limit`);
    const v = value[name];
    if (!Number.isInteger(v) || v < 1)
      throw new TypeError(`options.limits.${name} must be a positive integer`);
  }
  return Object.freeze({
    sequenceItems: value.sequenceItems ?? null,
    resultItems: value.resultItems ?? null,
    steps: value.steps ?? null,
    depth: value.depth ?? null,
  });
}

// Validate `options.externals`: the closed-world declaration list. An
// array of variable names (without the '$' sigil); `[]` declares none,
// so every free variable is JQ0005. Absent means the open world, where
// use is the declaration (section 9).
function validateDeclaredExternals(value) {
  if (!Array.isArray(value))
    throw new TypeError('options.externals must be an array of variable names');
  const set = new Set();
  for (let i = 0; i < value.length; i++) {
    const name = value[i];
    if (typeof name !== 'string' || !VAR_NAME_RE.test(name))
      throw new TypeError(`options.externals[${i}] must be a variable name string (no '$' sigil)`);
    set.add(name);
  }
  return set;
}

// Maximum expression nesting of a normalized AST. The language has no
// recursion - no user-defined functions, no self-reference - so the
// compiled closure tree's evaluation depth is exactly this static depth,
// which is why `limits.depth` is a compile-time check (JQ0011) rather
// than a runtime counter: exact, and free at evaluation time. Returns
// the deepest node found alongside its depth, for the error position.
function measureDepth(node, depth, worst) {
  if (depth > worst.depth) {
    worst.depth = depth;
    worst.docPath = node.docPath;
  }
  const next = depth + 1;
  switch (node.kind) {
    case 'literal':
    case 'var':
    case 'path':
    case 'raw':
      return;
    case 'object':
      for (let i = 0; i < node.entries.length; i++)
        measureDepth(node.entries[i].expr, next, worst);
      return;
    case 'map':
      for (let i = 0; i < node.pairs.length; i++) {
        measureDepth(node.pairs[i].key, next, worst);
        measureDepth(node.pairs[i].value, next, worst);
      }
      return;
    case 'array':
      for (let i = 0; i < node.elements.length; i++)
        measureDepth(node.elements[i], next, worst);
      return;
    case 'op':
    case 'call':
      for (let i = 0; i < node.args.length; i++)
        measureDepth(node.args[i], next, worst);
      return;
    case 'let':
      for (let i = 0; i < node.bindings.length; i++)
        measureDepth(node.bindings[i].expr, next, worst);
      measureDepth(node.ret, next, worst);
      return;
    case 'quant':
      for (let i = 0; i < node.bindings.length; i++)
        measureDepth(node.bindings[i].expr, next, worst);
      measureDepth(node.satisfies, next, worst);
      return;
    default: { // 'flwor'
      for (let i = 0; i < node.forBindings.length; i++)
        measureDepth(node.forBindings[i].expr, next, worst);
      for (let i = 0; i < node.letBindings.length; i++)
        measureDepth(node.letBindings[i].expr, next, worst);
      if (node.fold !== null)
        measureDepth(node.fold.expr, next, worst);
      if (node.where !== null)
        measureDepth(node.where, next, worst);
      if (node.groupby !== null) {
        for (let i = 0; i < node.groupby.keys.length; i++)
          measureDepth(node.groupby.keys[i].expr, next, worst);
      }
      if (node.orderby !== null) {
        for (let i = 0; i < node.orderby.specs.length; i++)
          measureDepth(node.orderby.specs[i].key, next, worst);
      }
      measureDepth(node.ret, next, worst);
      return;
    }
  }
}

function normalizeExpr(value, docPath, scope, ctx) {
  switch (typeof value) {
    case 'string':
      return normalizeString(value, docPath, scope, ctx);
    case 'number':
    case 'boolean':
      return makeLiteral(value, docPath);
    case 'object': {
      if (value === null)
        return makeLiteral(null, docPath);
      if (Array.isArray(value)) { // Rule 3: array constructor
        return Object.freeze({
          kind: 'array', card: CARD_ONE, docPath,
          elements: normalizeElements(value, docPath, scope, ctx),
        });
      }
      return normalizeObject(value, docPath, scope, ctx);
    }
    default:
      return fail('JQ0003', `a query document cannot contain a ${typeof value}`, docPath);
  }
}

/**
 * Normalize a query document into the internal AST.
 * @param {any} doc - the query document (any JSON value)
 * @param {object} [options] - compile options
 * @param {(schemaJson: any, docPath: string) => ((value: any) => boolean)}
 *   [options.compileTypeTest] - host hook compiling a JSON Schema literal
 *   into a boolean item predicate (QUERY-FORMAT.md section 8.11). Called
 *   once per schema literal, at query compile time. Without it, schema
 *   operators ($valid/$assert/$as) are compile error JQ0008.
 * @param {object} [options.extensions] - package-internal operator
 *   extension point, the operator analogue of `compileTypeTest` (used by
 *   the JSLT layer; not a public contract). A plain object of
 *   `name -> entry`, where entry follows the operator registry contract
 *   (`params`/`result`/`compile`, operators.js header) plus an optional
 *   `normalize(arg, docPath, opPath, scope, ctx, helpers) -> {args, card?}`
 *   override for polymorphic value shapes. Names must start with '$' and
 *   must not collide with the core vocabulary (TypeError - a host
 *   programming error, not a JQ0xxx document error). The published format
 *   and its schema are unchanged: without extensions, the same documents
 *   fail JQ0002.
 * @returns {{ root: object, frameSize: number, externals: {name: string, slot: number}[] }}
 *   the AST root, the frame size, and the external parameters in order of
 *   first appearance (slot order)
 * @throws {JsonQueryCompileError} on any JQ0xxx condition
 */
export function normalizeQuery(doc, options = {}) {
  const compileTypeTest = typeof options.compileTypeTest === 'function'
    ? options.compileTypeTest
    : null;
  const extensions = options.extensions == null ? null : validateExtensions(options.extensions);
  const functions = options.functions == null ? null : validateNamedFunctions(options.functions, 'functions');
  const collations = options.collations == null ? null : validateNamedFunctions(options.collations, 'collations');
  const zoneProvider = options.zoneProvider == null ? null : validateZoneProvider(options.zoneProvider);
  const limits = options.limits == null ? null : validateLimits(options.limits);
  const declaredExternals = options.externals == null
    ? null
    : validateDeclaredExternals(options.externals);
  // JSONPath function extensions are a separate registry from
  // options.functions ($call's host functions): they extend the RFC 9535
  // grammar inside path strings, not the query vocabulary. Built once
  // per compile so parsePathString hands the parser the same object.
  const pathOptions = options.pathFunctions == null
    ? undefined
    : { pathFunctions: options.pathFunctions };
  const ctx = {
    nextSlot: 1, externals: new Map(), compileTypeTest, extensions,
    functions, collations, zoneProvider, limits, pathOptions, declaredExternals, lexicalProviders: options.lexicalProviders,
    // package-internal: set only by analyzeQuery (Appendix C.1); the
    // compile entry point never passes it
    analysis: options.analysis === true,
    usedOps: new Set(), usedFunctions: new Set(), usedCollations: new Set(),
  };
  let expr = doc;
  let rootPath = '';
  // the version envelope is only recognized at the top level (section 4)
  if (isJsonObject(doc) && (hasOwn(doc, '$query') || hasOwn(doc, '$expr'))) {
    const keys = Object.keys(doc);
    let allDollar = true;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].charCodeAt(0) !== 0x24)
        allDollar = false;
    }
    if (allDollar) {
      if (hasOwn(doc, '$query') && doc.$query !== '0.1')
        fail('JQ0006', `unknown query format version ${JSON.stringify(doc.$query)}`, '/$query');
      if (!hasOwn(doc, '$query') || !hasOwn(doc, '$expr') || keys.length !== 2)
        fail('JQ0003', "the version envelope requires exactly the keys '$query' and '$expr'", '');
      expr = doc.$expr;
      rootPath = '/$expr';
    }
  }
  const root = normalizeExpr(expr, rootPath, null, ctx);
  if (limits !== null && limits.depth !== null) {
    const worst = { depth: 0, docPath: rootPath };
    measureDepth(root, 1, worst);
    if (worst.depth > limits.depth)
      fail('JQ0011', `the query nests ${worst.depth} expressions deep, more than limits.depth (${limits.depth})`, worst.docPath);
  }
  // limits.steps instruments every node evaluation; the counter lives in
  // its own frame slot, so nothing is threaded through the closures
  const stepSlot = limits !== null && limits.steps !== null ? ctx.nextSlot++ : -1;
  const externals = new Array(ctx.externals.size);
  let i = 0;
  for (const [name, slot] of ctx.externals)
    externals[i++] = Object.freeze({ name, slot });
  return {
    root, frameSize: ctx.nextSlot, externals: Object.freeze(externals),
    limits, stepSlot,
    usedOps: ctx.usedOps,
    usedFunctions: ctx.usedFunctions,
    usedCollations: ctx.usedCollations,
  };
}

//#endregion

//#endregion
