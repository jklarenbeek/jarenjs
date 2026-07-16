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

import { parseJSONPath, JSONPathSyntaxError } from '../path.js';
import { isSingularSegments } from '../segments.js';
import { JsonQueryCompileError } from './errors.js';
// The operator registry: `name -> { params, result, compile }`. Only
// referenced inside functions (never at module evaluation time), so the
// import cycle normalize.js <-> operators.js is initialization-safe.
import { OPERATORS } from './operators.js';

//#region cardinality

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
const VAR_HEAD_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)/;

// FLWOR clause keys (QUERY-FORMAT.md section 6.1) and quantifier keys
// (section 7). Clauses apply in the fixed semantic order of section 6.1
// regardless of JSON key order (D7).
const FLWOR_KEYS = new Set(['$for', '$let', '$as', '$where', '$groupby', '$orderby', '$count', '$return']);
const QUANTIFIER_KEYS = new Set(['$some', '$every', '$satisfies']);

// Keys of the explicit $orderby key-spec form (section 6.6). Contextual:
// they are not operators and stay outside the KNOWN_KEYS vocabulary.
const ORDERBY_SPEC_KEYS = new Set(['$key', '$dir', '$empty']);

// Escape hatches (QUERY-FORMAT.md section 3.5): structural forms with
// dedicated normalizer cases; every other operator lives in the registry.
const ESCAPE_KEYS = new Set(['$const', '$map']);

// The complete closed vocabulary decides JQ0002 (unknown key) versus
// JQ0003 (known keys in an invalid combination) for phrase objects.
// A function, not a precomputed set: the registry must never be read at
// module evaluation time (import cycle with operators.js).
function isVocabularyKey(key) {
  return FLWOR_KEYS.has(key) || QUANTIFIER_KEYS.has(key)
    || ESCAPE_KEYS.has(key) || hasOwn(OPERATORS, key);
}

//#endregion

//#region helpers

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// RFC 6901 reference token escaping for docPath pointers
function escapeToken(token) {
  if (token.indexOf('~') < 0 && token.indexOf('/') < 0)
    return token;
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function fail(code, message, docPath) {
  throw new JsonQueryCompileError(code, message, docPath);
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

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null)
    return value;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++)
    deepFreeze(value[keys[i]]);
  return Object.freeze(value);
}

//#endregion

//#region strings (Rule 2)

function parsePathString(source, original, docPath) {
  try {
    return parseJSONPath(source);
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
// section 9: use is the declaration)
function resolveVariable(name, scope, ctx) {
  for (let sc = scope; sc !== null; sc = sc.parent) {
    if (sc.name === name)
      return { slot: sc.slot, card: sc.card, external: false };
  }
  let slot = ctx.externals.get(name);
  if (slot === undefined) {
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
    const ast = parsePathString(s, s, docPath);
    return makePathNode('$', 0, false, CARD_ONE, ast.segments, docPath);
  }
  const m = VAR_HEAD_RE.exec(s);
  if (m === null)
    return fail('JQ0004', `'${s}' is not a valid path or escape`, docPath);
  const name = m[1];
  const rest = s.slice(m[0].length);
  const ref = resolveVariable(name, scope, ctx);
  if (rest === '') // bare '$name': whole-variable reference
    return Object.freeze({ kind: 'var', card: ref.card, docPath, slot: ref.slot, external: ref.external, name });
  // variable-rooted path: the grammar is RFC 9535 with the root identifier
  // replaced by the variable reference - parse with a substituted '$'
  const ast = parsePathString('$' + rest, s, docPath);
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
        expr: normalizeExpr(obj[name], docPath + '/' + escapeToken(name), scope, ctx),
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
  if (allFlwor && keys.length >= 2 && hasOwn(obj, '$return') && (hasOwn(obj, '$for') || hasOwn(obj, '$let'))) {
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
    if (!isVocabularyKey(keys[i]))
      return failUnknownOperator(keys[i], docPath);
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

// JQ0002 for an unknown $-key, with a "did you mean" suggestion when a
// vocabulary key is within Levenshtein distance 2 (compile-time only).
function failUnknownOperator(key, docPath) {
  if (VOCABULARY_NAMES === null) {
    VOCABULARY_NAMES = [
      ...FLWOR_KEYS, ...QUANTIFIER_KEYS, ...ESCAPE_KEYS, ...Object.keys(OPERATORS),
    ];
  }
  let best = null;
  let bestDist = 3;
  for (let i = 0; i < VOCABULARY_NAMES.length; i++) {
    const name = VOCABULARY_NAMES[i];
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
  if (ctx.compileTypeTest === null)
    fail('JQ0008', 'schema operators require a type-test compiler (options.compileTypeTest)', opPath);
  const schema = deepFreezeCopy(value);
  let test;
  try {
    test = ctx.compileTypeTest(schema, schemaPath);
  }
  catch (e) {
    fail('JQ0009', `invalid schema literal: ${e.message}`, opPath);
  }
  if (typeof test !== 'function')
    fail('JQ0009', 'the type-test compiler did not return a predicate function', opPath);
  return { schema, test };
}

// One argument position of a registry operator, per its declared kind:
// 'expr' normalizes an ordinary expression; 'raw' captures the value
// verbatim, unevaluated; 'schema' is 'raw' plus a compiled type-test
// predicate (the type-system work order's schema arguments); 'name'
// captures a validated variable name string. 'raw', 'schema' and 'name'
// produce inert `raw` nodes - compile-time data, never compiled.
function normalizeArg(kind, value, argPath, scope, ctx, opPath) {
  if (kind === 'expr')
    return normalizeExpr(value, argPath, scope, ctx);
  if (kind === 'raw')
    return Object.freeze({ kind: 'raw', card: CARD_ONE, docPath: argPath, value: deepFreezeCopy(value) });
  if (kind === 'schema') {
    const { schema, test } = compileSchemaLiteral(value, argPath, opPath, ctx);
    return Object.freeze({ kind: 'raw', card: CARD_ONE, docPath: argPath, value: schema, test });
  }
  // 'name'
  if (typeof value !== 'string' || !VAR_NAME_RE.test(value))
    fail('JQ0003', 'expected a variable name string', argPath);
  return Object.freeze({ kind: 'raw', card: CARD_ONE, docPath: argPath, value });
}

// A registry operator call: arity and shape come uniformly from the
// table's `params` descriptor (JQ0003), the static cardinality from its
// `result` - individual operators never re-check structure.
function normalizeOperatorCall(key, entry, arg, docPath, opPath, scope, ctx) {
  const params = entry.params;
  let args;
  if (typeof params === 'string') { // the single form: the value IS the argument
    args = [normalizeArg(params, arg, opPath, scope, ctx, opPath)];
  }
  else {
    const kinds = params.kinds;
    const max = params.variadic === true ? Infinity : kinds.length;
    const list = requireExprArray(key, arg, params.min, max, opPath);
    args = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const kind = kinds[i < kinds.length ? i : kinds.length - 1];
      args[i] = normalizeArg(kind, list[i], opPath + '/' + i, scope, ctx, opPath);
    }
  }
  const cards = new Array(args.length);
  for (let i = 0; i < args.length; i++)
    cards[i] = args[i].card;
  return Object.freeze({
    kind: 'op', card: entry.result(cards), docPath, name: key, args: Object.freeze(args),
  });
}

function normalizeOperator(key, arg, docPath, scope, ctx) {
  const opPath = docPath + '/' + key;
  switch (key) {
    case '$const': // quote: verbatim single item, nothing inside evaluated
      return Object.freeze({ kind: 'literal', card: CARD_ONE, docPath, value: deepFreezeCopy(arg) });

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
      if (FLWOR_KEYS.has(key) || QUANTIFIER_KEYS.has(key))
        return fail('JQ0003', `'${key}' cannot form a phrase on its own`, docPath);
      return failUnknownOperator(key, docPath);
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
  if (!isPlainObject(bindObj))
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
    const bindPath = letPath + '/' + escapeToken(name);
    bindPhraseName(name, phraseNames, bindPath);
    const source = letObj[name];
    if (isPlainObject(source) && (hasOwn(source, '$in') || hasOwn(source, '$at')))
      return fail('JQ0003', "the extended '$in'/'$at' binding form is not available in '$let'", bindPath);
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
    const bindPath = forPath + '/' + escapeToken(name);
    bindPhraseName(name, phraseNames, bindPath);
    let source = forObj[name];
    let sourcePath = bindPath;
    let atName = null;
    if (isPlainObject(source) && (hasOwn(source, '$in') || hasOwn(source, '$at'))) {
      if (Object.keys(source).length !== 2 || !hasOwn(source, '$in') || !hasOwn(source, '$at'))
        return fail('JQ0003', "the extended binding form takes exactly the keys '$in' and '$at'", bindPath);
      atName = source.$at;
      if (typeof atName !== 'string' || !VAR_NAME_RE.test(atName))
        return fail('JQ0003', "'$at' takes a variable name string", bindPath + '/$at');
      source = source.$in;
      sourcePath = bindPath + '/$in';
    }
    const expr = normalizeExpr(source, sourcePath, sc, ctx);
    const slot = ctx.nextSlot++;
    sc = { name, slot, card: CARD_ONE, parent: sc };
    tupleSlots.push({ name, slot });
    let atSlot = -1;
    if (atName !== null) {
      bindPhraseName(atName, phraseNames, bindPath + '/$at');
      atSlot = ctx.nextSlot++;
      sc = { name: atName, slot: atSlot, card: CARD_ONE, parent: sc };
      tupleSlots.push({ name: atName, slot: atSlot });
    }
    bindings.push(Object.freeze({ name, slot, expr, atSlot }));
  }
  return sc;
}

// One $orderby key spec (section 6.6): an expression (ascending,
// empty-least) or the explicit {"$key", "$dir"?, "$empty"?} form.
function normalizeOrderbySpec(spec, specPath, scope, ctx) {
  let key = spec;
  let keyPath = specPath;
  let desc = false;
  let emptyGreatest = false;
  if (isPlainObject(spec) && (hasOwn(spec, '$key') || hasOwn(spec, '$dir') || hasOwn(spec, '$empty'))) {
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
    key = spec.$key;
    keyPath = specPath + '/$key';
  }
  return Object.freeze({
    key: normalizeExpr(key, keyPath, scope, ctx),
    desc, emptyGreatest, docPath: specPath,
  });
}

// Collect the frame slots an expression subtree reads (variable
// references and path roots). Barrier liveness: $groupby/$orderby
// materialize only the phrase binding slots that later clauses read.
// Over-approximation is safe; slots written by nested phrases before
// being read merely widen a snapshot harmlessly.
function collectReadSlots(node, out) {
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

  if (hasOwn(obj, '$for'))
    sc = normalizeForBindings(obj.$for, docPath + '/$for', sc, ctx, phraseNames, forBindings, tupleSlots);
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
    if (!isPlainObject(asObj))
      return fail('JQ0003', "'$as' takes an object of variable-name to schema members", asPath);
    const names = Object.keys(asObj);
    if (names.length === 0)
      return fail('JQ0003', "'$as' requires at least one member", asPath);
    const checks = new Array(names.length);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const checkPath = asPath + '/' + escapeToken(name);
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
      const bindPath = groupPath + '/' + escapeToken(name);
      bindPhraseName(name, phraseNames, bindPath);
      // key expressions evaluate per tuple, in the pre-group scope
      const expr = normalizeExpr(obj.$groupby[name], bindPath, sc, ctx);
      keys[i] = Object.freeze({ name, slot: ctx.nextSlot++, expr, docPath: bindPath });
    }
    // post-group scope: same slots, rebound cards
    sc = scope;
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
  if (forBindings.length !== 0 || groupby !== null)
    card = CARD_MANY;
  else
    card = where !== null ? joinCard(ret.card, CARD_ZERO) : ret.card;

  return Object.freeze({
    kind: 'flwor', card, docPath,
    forBindings: Object.freeze(forBindings),
    letBindings: Object.freeze(letBindings),
    asChecks, where,
    groupby: groupby === null ? null : Object.freeze(groupby),
    orderby: orderby === null ? null : Object.freeze(orderby),
    count, ret,
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
    const bindPath = clausePath + '/' + escapeToken(name);
    bindPhraseName(name, phraseNames, bindPath);
    const source = bindObj[name];
    if (isPlainObject(source) && (hasOwn(source, '$in') || hasOwn(source, '$at')))
      return fail('JQ0003', "the extended '$in'/'$at' binding form is not available in quantifiers", bindPath);
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
 * @returns {{ root: object, frameSize: number, externals: {name: string, slot: number}[] }}
 *   the AST root, the frame size, and the external parameters in order of
 *   first appearance (slot order)
 * @throws {JsonQueryCompileError} on any JQ0xxx condition
 */
export function normalizeQuery(doc, options = {}) {
  const compileTypeTest = typeof options.compileTypeTest === 'function'
    ? options.compileTypeTest
    : null;
  const ctx = { nextSlot: 1, externals: new Map(), compileTypeTest };
  let expr = doc;
  let rootPath = '';
  // the version envelope is only recognized at the top level (section 4)
  if (isPlainObject(doc) && (hasOwn(doc, '$query') || hasOwn(doc, '$expr'))) {
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
  const externals = new Array(ctx.externals.size);
  let i = 0;
  for (const [name, slot] of ctx.externals)
    externals[i++] = Object.freeze({ name, slot });
  return { root, frameSize: ctx.nextSlot, externals: Object.freeze(externals) };
}

//#endregion

//#endregion
