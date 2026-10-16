//@ts-check
/**
 * @file `diffContracts(a, b)`: what changed from contract `a` to contract
 * `b`, classified by the published rule table (docs/CONTRACT-FORMAT.md
 * §13, rows R1–R16) into `breaking`, `additive`, `neutral` and `unknown`
 * — where `unknown` is the honest fourth class: a schema construct the
 * checker does not model (`if`, `not`, a union whose variants overlap,
 * a changed `pattern`, an external `$ref` that moved) is REPORTED,
 * never silently classed.
 *
 * The schema comparison walks the two sides in parallel over the resolved
 * same-document structure — a bare `{ "$ref": "#/$defs/X" }` hop is
 * followed with the same rules the compiler used — and models exactly the
 * R6 keyword set (`type`, `const`, `enum`, `maximum`, `minimum`,
 * `maxLength`, `minLength`, `pattern`) plus object structure
 * (`properties`, `required`, `additionalProperties`) and `items`, and
 * walks the branches of the applicators whose direction is decidable —
 * an `allOf`, a `then`/`else` under the same `if`, a `dependentSchemas`
 * member, a `prefixItems` entry, an `anyOf`/`oneOf` whose variants a type
 * or a discriminator tells apart (paired by that key, wherever they sit) —
 * branch against branch with the same rules. Pure annotations (`title`,
 * `description`, `examples`, `$comment`, `deprecated`) never move a wire
 * byte and are ignored; every other keyword that differs between the two
 * sides lands in `unknown` (R15).
 * "Differs" is read through every same-document `$ref`: a construct the
 * walk does not model is equal only when what its references resolve to
 * is, so a change behind an unchanged spelling is reported, never lost.
 *
 * A nullable node has two spellings — `type: [T, 'null']` and a
 * two-branch `anyOf`/`oneOf` with a null-only branch — and the walk reads
 * them through `canonicalNullable` (`@jarenjs/core/schema`). Where they
 * accept the same values a respelling is neutral R16, and a change beside
 * it is read on the type-array spelling (its `docPath` names that
 * spelling's keyword). Where they may not (a `$query`, an `enum` or a
 * `$ref` in the branch), nothing is canonicalized and the walk above
 * reports what differs.
 *
 * A `Change`'s `docPath` points into the document that carries it — a
 * removal into `a`, everything else into `b` — composed over the RESOLVED
 * structure, so a constraint reached through a `$ref` reports the path a
 * validator error would name, not the `$defs` entry's.
 */

import { decodeJSONPointerSegment, encodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import {
  canonicalNullable, splitNullable, SCHEMA_VALUE_KEYWORDS, SCHEMA_MAP_KEYWORDS, SCHEMA_LIST_KEYWORDS,
} from '@jarenjs/core/schema';
import { collectSameDocumentAnchors, resolveSameDocumentRef } from '@jarenjs/validate/normalize';

import { compileContract } from './compile.js';
import { ContractHostError } from './errors.js';
import { bareMedia } from './http/wire.js';
import { isCompiledContract } from './public.js';
import { pathShape } from '@jarenjs/core/route';

export { isCompatible, compatReason } from './compat.js';

/**
 * @typedef {import('./compile.js').Contract} Contract
 * @typedef {import('./compile.js').CompiledOperation} CompiledOperation
 */

/**
 * One classified change.
 * @typedef {Object} Change
 * @property {string} kind - a stable slug naming what changed (`'operation-removed'`, `'input-narrowed'`, …)
 * @property {string} op - the operation id
 * @property {string} docPath - RFC 6901 pointer to the change (into `a` for a removal, into `b` otherwise)
 * @property {unknown} [from] - the old value, where one exists
 * @property {unknown} [to] - the new value, where one exists
 * @property {string} rule - the §13 row: `'R1'`–`'R16'`
 * @property {string} [note] - the honesty rider some rows carry (R5's "now ignored, not validated")
 * @property {'server'} [audience] - present, under `audience: 'all'`, on every
 *   change of a server-audience operation
 */

/**
 * @typedef {Object} ContractDiff
 * @property {Change[]} breaking
 * @property {Change[]} additive
 * @property {Change[]} neutral
 * @property {Change[]} unknown
 */

/** Keywords compared as constraints (the R6 set). */
const CONSTRAINTS = ['type', 'const', 'enum', 'maximum', 'minimum', 'maxLength', 'minLength', 'pattern'];
const CONSTRAINT_SET = new Set(CONSTRAINTS);

/** Keywords the object-structure pass owns. */
const STRUCTURE = new Set(['properties', 'required', 'additionalProperties', 'items']);

/** Pure annotations — no wire behavior, never reported. */
const ANNOTATIONS = new Set(['title', 'description', 'examples', '$comment', 'deprecated']);

/** Resolution artifacts the parallel walk consults, never compares. */
const RESOLUTION = new Set(['$ref', '$defs', 'definitions', '$anchor', '$id', '$schema']);

/** The stable canonical text of any JSON value (for deep equality). */
const canon = (/** @type {unknown} */ v) => (v === undefined ? 'undefined' : canonicalizeJson(v));

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One side of the parallel walk: the schema resolution scope.
 * @typedef {{ doc: any, anchors: Map<string, object> }} Side
 */

/**
 * Resolve bare `{ $ref }` hops (same-document only). Returns the resolved
 * node, or a marker for the shapes the walk cannot model.
 * @param {any} node
 * @param {Side} side
 * @returns {{ node: any } | { external: string } | { opaque: true }}
 */
function resolveHops(node, side) {
  const seen = new Set();
  while (isObject(node) && typeof node.$ref === 'string') {
    if (Object.keys(node).length > 1) return { opaque: true }; // $ref with siblings — not modeled
    if (!node.$ref.startsWith('#')) return { external: node.$ref };
    if (seen.has(node)) return { opaque: true };
    seen.add(node);
    const target = resolveSameDocumentRef(node.$ref, side.doc, side.anchors);
    if (target === undefined) return { opaque: true };
    node = target;
  }
  return { node };
}

/** Keywords whose value is one schema (a tuple `items` included). */
const SCHEMA_VALUES = new Set([...SCHEMA_VALUE_KEYWORDS, 'additionalItems']);
/** Keywords whose value maps names to schemas (`dependencies` may also map a name to a list of names). */
const SCHEMA_MAPS = new Set([...SCHEMA_MAP_KEYWORDS, 'dependencies']);
/** Keywords whose value lists schemas. */
const SCHEMA_LISTS = new Set(SCHEMA_LIST_KEYWORDS);
/** Data keywords whose value is a set: a reorder accepts the same values. */
const VALUE_SETS = new Set(['type', 'enum', 'required']);

/**
 * Where two schema values first accept different values once every
 * same-document `$ref` on each side is followed into its own document:
 * the pointer (over the resolved structure, from `path`) and the two
 * values there, or `null` when they validate alike. Two spellings that
 * are equal as text can still differ here, because a `$ref` names a
 * location, not a schema — the walk below compares by text wherever it
 * does not model a construct, and this is what keeps such a construct
 * from reading as unchanged. Annotations and resolution artifacts are
 * skipped, as the walk skips them; `enum`, `required` and `type` compare
 * as sets; every other keyword that is not a schema position compares
 * as data, so a `$ref` inside a `const` is never followed.
 * @param {string} key - the keyword holding `x` and `y`
 * @param {unknown} x
 * @param {unknown} y
 * @param {string} path - pointer to the keyword's value
 * @param {Side} a
 * @param {Side} b
 * @param {Map<object, Set<object>>} pairs - schema pairs under comparison (a recursive schema terminates)
 * @returns {{ path: string, from: unknown, to: unknown } | null}
 */
function divergence(key, x, y, path, a, b, pairs) {
  const at = { path, from: x, to: y };
  if (SCHEMA_VALUES.has(key)) {
    if (Array.isArray(x) && Array.isArray(y)) return divergenceInList(x, y, path, a, b, pairs);
    return schemaDivergence(x, y, path, a, b, pairs);
  }
  if (SCHEMA_LISTS.has(key) && Array.isArray(x) && Array.isArray(y)) return divergenceInList(x, y, path, a, b, pairs);
  if (SCHEMA_MAPS.has(key) && isObject(x) && isObject(y)) {
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const inner = path + '/' + encodeJSONPointerSegment(name);
      if (!Object.hasOwn(x, name) || !Object.hasOwn(y, name)) return { path: inner, from: x[name], to: y[name] };
      const found = Array.isArray(x[name]) || Array.isArray(y[name])
        ? (canon(x[name]) === canon(y[name]) ? null : { path: inner, from: x[name], to: y[name] })
        : schemaDivergence(x[name], y[name], inner, a, b, pairs);
      if (found !== null) return found;
    }
    return null;
  }
  if (VALUE_SETS.has(key)) {
    const texts = (/** @type {unknown} */ v) => [...new Set((Array.isArray(v) ? v : [v]).map(canon))].sort().join(',');
    return texts(x) === texts(y) ? null : at;
  }
  return canon(x) === canon(y) ? null : at;
}

/**
 * {@link divergence} over two lists of schemas, index by index.
 * @param {unknown[]} x @param {unknown[]} y @param {string} path
 * @param {Side} a @param {Side} b @param {Map<object, Set<object>>} pairs
 * @returns {{ path: string, from: unknown, to: unknown } | null}
 */
function divergenceInList(x, y, path, a, b, pairs) {
  if (x.length !== y.length) return { path, from: x, to: y };
  for (let i = 0; i < x.length; i++) {
    const found = schemaDivergence(x[i], y[i], `${path}/${i}`, a, b, pairs);
    if (found !== null) return found;
  }
  return null;
}

/**
 * {@link divergence} for two schemas: a same-document `$ref` on either
 * side is followed (an external one compares by its text).
 * @param {unknown} x @param {unknown} y @param {string} path
 * @param {Side} a @param {Side} b @param {Map<object, Set<object>>} pairs
 * @returns {{ path: string, from: unknown, to: unknown } | null}
 */
function schemaDivergence(x, y, path, a, b, pairs) {
  if (!isObject(x) || !isObject(y)) return canon(x) === canon(y) ? null : { path, from: x, to: y };
  let seen = pairs.get(x);
  if (seen !== undefined && seen.has(y)) return null; // in progress: the cycle closes on itself
  if (seen === undefined) pairs.set(x, (seen = new Set()));
  seen.add(y);
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (ANNOTATIONS.has(key) || (RESOLUTION.has(key) && key !== '$ref')) continue;
    if (!Object.hasOwn(x, key) || !Object.hasOwn(y, key)) {
      return { path: path + '/' + encodeJSONPointerSegment(key), from: x[key], to: y[key] };
    }
    if (key === '$ref') {
      const ta = sameDocumentTarget(x.$ref, a);
      const tb = sameDocumentTarget(y.$ref, b);
      // the target is read at this node's own pointer: the resolved structure
      const found = ta === undefined || tb === undefined
        ? (x.$ref === y.$ref ? null : { path: path + '/$ref', from: x.$ref, to: y.$ref })
        : schemaDivergence(ta, tb, path, a, b, pairs);
      if (found !== null) return found;
      continue;
    }
    const found = divergence(key, x[key], y[key], path + '/' + encodeJSONPointerSegment(key), a, b, pairs);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The schema a same-document `$ref` names on one side, or `undefined`
 * for an external or unresolvable one.
 * @param {unknown} ref
 * @param {Side} side
 */
function sameDocumentTarget(ref, side) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  return resolveSameDocumentRef(ref, side.doc, side.anchors);
}

/**
 * Whether two schemas validate differently: their text differs, or it is
 * equal and a `$ref` inside resolves to schemas that differ.
 * @param {unknown} x @param {unknown} y @param {Side} a @param {Side} b
 */
const schemasDiffer = (x, y, a, b) => canon(x) !== canon(y) || schemaDivergence(x, y, '', a, b, new Map()) !== null;

/**
 * The event sink of one schema comparison.
 * @typedef {Object} Sink
 * @property {(direction: 'narrowed' | 'widened', keyword: string, path: string, from: unknown, to: unknown) => void} constraint
 * @property {(event: 'removed' | 'added-required' | 'added-optional' | 'made-required' | 'made-optional',
 *   direction: 'narrowed' | 'widened' | 'unknown' | null, path: string, member: string, closedBefore: boolean,
 *   catchAll?: string | null) => void} member
 *   `direction` is the AP-aware narrowing/widening reading of the member
 *   event (`null` when it is a no-op, e.g. an unconstrained optional
 *   member added to an open object; `'unknown'` when a constraining
 *   catch-all — named by `catchAll` — judges the member on the other
 *   side); `closedBefore` says whether the object refused unknown members
 *   in `a` (`additionalProperties` or `unevaluatedProperties` false) — an
 *   output member a closed schema never allowed is one the old client's
 *   validator refuses
 * @property {(keyword: string, path: string, from: unknown, to: unknown) => void} unknown
 * @property {(path: string, from: unknown, to: unknown) => void} respelled - a nullable
 *   node respelled between a type array and a two-branch `anyOf`/`oneOf` (R16)
 */

/**
 * Which of the two nullable spellings a node uses.
 * @param {Record<string, any>} node
 * @returns {'anyOf' | 'oneOf' | 'type'}
 */
function nullableSpelling(node) {
  return Array.isArray(node.anyOf) ? 'anyOf' : Array.isArray(node.oneOf) ? 'oneOf' : 'type';
}

/**
 * The index of the non-null branch of a two-branch nullable union — the
 * branch that, paired with a null branch, still reads as nullable (the
 * null-only rule stays @jarenjs/core/schema's own).
 * @param {readonly unknown[]} branches
 * @returns {number}
 */
function nonNullBranch(branches) {
  return branches.findIndex((branch) => splitNullable({ anyOf: [branch, { type: 'null' }] }) !== null);
}

/** The in-place applicators: a constraint may sit inside one, so one on one side only may have moved. */
const APPLICATORS = ['anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentSchemas'];

/** @param {Record<string, any>} node */
const carriesApplicator = (node) => APPLICATORS.some((key) => node[key] !== undefined);

/**
 * Whether an object schema forbids the members it does not name.
 * @param {Record<string, any>} node
 */
const closedObject = (node) => node.additionalProperties === false || node.unevaluatedProperties === false;

/**
 * The keyword of a catch-all that constrains the members an object schema
 * does not name — a member added beside it may or may not satisfy it,
 * which the checker cannot decide — or `null`.
 * @param {Record<string, any>} node
 * @returns {string | null}
 */
function constrainingCatchAll(node) {
  for (const key of ['additionalProperties', 'unevaluatedProperties']) {
    const value = node[key];
    if (value !== undefined && value !== true && value !== false && !(isObject(value) && Object.keys(value).length === 0)) return key;
  }
  if (isObject(node.patternProperties) && Object.keys(node.patternProperties).length > 0) return 'patternProperties';
  if (node.propertyNames !== undefined && node.propertyNames !== true) return 'propertyNames';
  return null;
}

/**
 * What an object schema applies to a member its `properties` does not
 * name, when the walk can say: `false` under a closed object, `true`
 * under an open one — or `undefined` when a catch-all that constrains
 * (`patternProperties` included, closed or not) or an applicator may
 * judge the member instead.
 * @param {Record<string, any>} node
 * @returns {boolean | undefined}
 */
function unnamedMember(node) {
  if (carriesApplicator(node) || constrainingCatchAll(node) !== null) return undefined;
  return !closedObject(node);
}

/**
 * A member `X` declares `false` (directly or through same-document
 * `$ref`s) without requiring it, while `Y` neither names nor requires it,
 * is no member of its own: what `Y` applies to it — `false` closed, `true`
 * open — is what its `false` compares against, so a closed object that
 * drops or adds it moves nothing, and an open one that adds it narrows.
 * `undefined` for any other pair, which the member rows classify.
 * @param {string} m
 * @param {Record<string, any> | null} X - the side naming `m`
 * @param {Side} x
 * @param {Record<string, any> | null} Y - the other side
 * @returns {boolean | undefined} what `Y` applies to `m`
 */
function forbiddenOnOneSide(m, X, x, Y) {
  if (X === null || Y === null) return undefined;
  const names = (/** @type {Record<string, any>} */ node) => isObject(node.properties) && Object.hasOwn(node.properties, m);
  const requires = (/** @type {Record<string, any>} */ node) => Array.isArray(node.required) && node.required.includes(m);
  if (!names(X) || requires(X) || names(Y) || requires(Y)) return undefined;
  const declared = resolveHops(X.properties[m], x);
  return 'node' in declared && declared.node === false ? unnamedMember(Y) : undefined;
}

/**
 * Whether a node reads the annotations its in-place applicators produce:
 * dropping a member from a branch then refuses it instead of freeing it,
 * so no branch change has a direction the branch alone decides.
 * @param {Record<string, any>} node
 */
const readsAnnotations = (node) => node.unevaluatedProperties !== undefined || node.unevaluatedItems !== undefined;

/**
 * Whether a constraint, a member or a requirement is present on one side
 * only — it may have moved between the node and one of its applicators,
 * which the walk reports as R15 at the node, so the branches it may have
 * moved into are not read by direction either.
 * @param {Record<string, any>} A
 * @param {Record<string, any>} B
 */
function oneSided(A, B) {
  if (CONSTRAINTS.some((key) => (A[key] === undefined) !== (B[key] === undefined))) return true;
  const differ = (/** @type {unknown[]} */ x, /** @type {unknown[]} */ y) =>
    x.length !== y.length || x.some((m) => !y.includes(m));
  const names = (/** @type {Record<string, any>} */ node) => (isObject(node.properties) ? Object.keys(node.properties) : []);
  const required = (/** @type {Record<string, any>} */ node) => [...new Set(Array.isArray(node.required) ? node.required : [])];
  return differ(names(A), names(B)) || differ(required(A), required(B));
}

const INTEGER = canon('integer');
const NUMBER = canon('number');

/**
 * Whether a type set (canonical texts) admits every value of the type
 * `t` (a canonical text): a type set counts `integer` inside `number`,
 * since every integer is a number.
 * @param {string} t
 * @param {Set<string>} set
 */
const typeCovered = (t, set) => set.has(t) || (t === INTEGER && set.has(NUMBER));

/**
 * The JSON types (canonical texts, sorted) a union branch may accept: its
 * own `type` (read through bare `$ref` hops), or, without one, every type
 * a branch of its own `anyOf`/`oneOf` may accept; `null` when that is not
 * bounded by a `type` everywhere.
 * @param {unknown} branch
 * @param {Side} side
 * @param {Set<object>} [within] - the nodes being read (a recursive union ends unbounded)
 * @returns {string[] | null}
 */
function acceptedTypes(branch, side, within = new Set()) {
  const resolved = resolveHops(branch, side);
  if (!('node' in resolved) || !isObject(resolved.node) || within.has(resolved.node)) return null;
  const node = resolved.node;
  if (typeof node.type === 'string') return [canon(node.type)];
  if (Array.isArray(node.type)) return [...new Set(node.type.map(canon))].sort();
  const key = Array.isArray(node.anyOf) ? 'anyOf' : Array.isArray(node.oneOf) ? 'oneOf' : null;
  if (key === null) return null;
  within.add(node);
  const sets = node[key].map((/** @type {unknown} */ inner) => acceptedTypes(inner, side, within));
  within.delete(node);
  return sets.includes(null) ? null : [...new Set(sets.flat())].sort();
}

/**
 * Whether two type sets (canonical texts) share a value.
 * @param {string[]} x @param {string[]} y
 */
const typesMeet = (x, y) => x.some((t) => typeCovered(t, new Set(y))) || y.some((t) => typeCovered(t, new Set(x)));

/**
 * Whether two discriminator value sets (canonical texts) share a value.
 * @param {string[]} x @param {string[]} y
 */
const valuesMeet = (x, y) => x.some((v) => y.includes(v));

/**
 * The value set (canonical texts, sorted) a union branch admits for the
 * member `name`, when the branch is an object schema that requires the
 * member and holds it to a `const` or an `enum`; `null` otherwise.
 * @param {unknown} branch
 * @param {string} name
 * @param {Side} side
 * @returns {string[] | null}
 */
function discriminatorValues(branch, name, side) {
  const resolved = resolveHops(branch, side);
  if (!('node' in resolved) || !isObject(resolved.node)) return null;
  const node = resolved.node;
  const typed = node.type === 'object' || (Array.isArray(node.type) && node.type.length === 1 && node.type[0] === 'object');
  if (!typed || !Array.isArray(node.required) || !node.required.includes(name)) return null;
  if (!isObject(node.properties) || !Object.hasOwn(node.properties, name)) return null;
  const member = resolveHops(node.properties[name], side);
  if (!('node' in member) || !isObject(member.node)) return null;
  const values = member.node.const !== undefined ? [member.node.const] : Array.isArray(member.node.enum) ? member.node.enum : null;
  return values === null ? null : [...new Set(values.map(canon))].sort();
}

/**
 * How the variants of two unions pair, or `null` when they are not
 * provably disjoint: one key per variant — the JSON types it may accept
 * ({@link acceptedTypes}), or, failing that, the value set of a member
 * every variant requires of an object ({@link discriminatorValues}) —
 * no two keys on one side sharing a value, and every key either equal to
 * one on the other side (the two variants pair) or sharing a value with
 * none there (the variant was added or removed). Every instance then
 * meets at most the one variant its key names, on each side, so the
 * union accepts exactly what that variant does — `oneOf` and `anyOf`
 * alike — a change inside a paired variant moves the union exactly as
 * it moves the variant, an added one only widens it and a removed one
 * only narrows it. Pairs are `[index in a, index in b]`.
 * @param {unknown[]} xs
 * @param {unknown[]} ys
 * @param {Side} a
 * @param {Side} b
 * @returns {{ pairs: [number, number][], removed: number[], added: number[] } | null}
 */
function pairVariants(xs, ys, a, b) {
  if (xs.length === 0 || ys.length === 0) return null;
  const byType = keyedPairs(xs.map((x) => acceptedTypes(x, a)), ys.map((y) => acceptedTypes(y, b)), typesMeet);
  if (byType !== null) return byType;
  const first = resolveHops(xs[0], a);
  if (!('node' in first) || !isObject(first.node) || !Array.isArray(first.node.required)) return null;
  for (const name of first.node.required) {
    const byValue = keyedPairs(xs.map((x) => discriminatorValues(x, name, a)), ys.map((y) => discriminatorValues(y, name, b)), valuesMeet);
    if (byValue !== null) return byValue;
  }
  return null;
}

/**
 * Pair two lists of variant keys (sorted canonical texts) by equality,
 * as {@link pairVariants} says, or `null`.
 * @param {(string[] | null)[]} xk
 * @param {(string[] | null)[]} yk
 * @param {(x: string[], y: string[]) => boolean} meet - whether two keys share a value
 * @returns {{ pairs: [number, number][], removed: number[], added: number[] } | null}
 */
function keyedPairs(xk, yk, meet) {
  // an empty key (an `enum: []`, a `type: []`, an empty union inside)
  // names no instance a pair could share
  if ([...xk, ...yk].some((k) => k === null || k.length === 0)) return null;
  const xs = /** @type {string[][]} */ (xk);
  const ys = /** @type {string[][]} */ (yk);
  const apart = (/** @type {string[][]} */ keys) => keys.every((k, i) => keys.every((l, j) => j <= i || !meet(k, l)));
  if (!apart(xs) || !apart(ys)) return null;
  /** @type {[number, number][]} */
  const pairs = [];
  const added = [];
  for (let j = 0; j < ys.length; j++) {
    const i = xs.findIndex((k) => canon(k) === canon(ys[j]));
    if (i >= 0) pairs.push(/** @type {[number, number]} */ ([i, j]));
    else added.push(j);
  }
  const removed = [];
  for (let i = 0; i < xs.length; i++) {
    if (pairs.some(([p]) => p === i)) continue;
    // a key of `a` left unpaired must share no value with a key of `b`;
    // this also sees an unpaired key of `b` sharing one with a key of `a`,
    // since that key cannot be paired: its equal on `b` would share the
    // value too, and the keys on `b` are apart
    if (ys.some((l) => meet(xs[i], l))) return null;
    removed.push(i);
  }
  return { pairs, removed, added };
}

/**
 * The applicator keywords of a schema pair whose branches the walk reads
 * by direction, branch against branch — positions where a branch that
 * narrows (or widens) narrows (or widens) what the node accepts, and
 * nothing else changed that could have moved into or out of them:
 * `allOf` of the same length with at most one conjunct respelled; `anyOf`/`oneOf` whose variants are provably disjoint ({@link pairVariants});
 * `then`/`else` beside an `if` that validates alike; `dependentSchemas`
 * over the same keys; `prefixItems` of the same length. None where the
 * node reads its branches' annotations (`unevaluated*`) or a constraint,
 * member or requirement sits on one side only. Every other applicator
 * change stays R15, and so does a branch change at a location the node
 * may constrain beside the branch ({@link besideSink}).
 * @param {Record<string, any>} A
 * @param {Record<string, any>} B
 * @param {Side} a
 * @param {Side} b
 * @returns {Set<string>}
 */
function decidedApplicators(A, B, a, b) {
  /** @type {Set<string>} */
  const decided = new Set();
  const lists = (/** @type {string} */ key) => Array.isArray(A[key]) && Array.isArray(B[key]) && A[key].length === B[key].length;
  const candidates = ['allOf', 'anyOf', 'oneOf', 'then', 'else', 'dependentSchemas', 'prefixItems'];
  if (!candidates.some((key) => A[key] !== undefined || B[key] !== undefined)) return decided;
  if (readsAnnotations(A) || readsAnnotations(B) || oneSided(A, B)) return decided;
  if (lists('allOf')) {
    // conjuncts pair by position only where that cannot pair two that
    // traded places: one respelled conjunct at most (a conjunct spelled
    // alike whose `$ref` resolves apart stays where it is)
    const xs = A.allOf.map(canon);
    if (B.allOf.filter((/** @type {unknown} */ y, /** @type {number} */ i) => canon(y) !== xs[i]).length <= 1) decided.add('allOf');
  }
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(A[key]) && Array.isArray(B[key]) && pairVariants(A[key], B[key], a, b) !== null) decided.add(key);
  }
  if (A.if !== undefined && B.if !== undefined && !schemasDiffer(A.if, B.if, a, b)) {
    for (const key of ['then', 'else']) if (A[key] !== undefined && B[key] !== undefined) decided.add(key);
  }
  if (isObject(A.dependentSchemas) && isObject(B.dependentSchemas)
    && canon(Object.keys(A.dependentSchemas).sort()) === canon(Object.keys(B.dependentSchemas).sort())) decided.add('dependentSchemas');
  if (lists('prefixItems')) decided.add('prefixItems');
  return decided;
}

/** The in-place applicators, as a set. */
const IN_PLACE = new Set(APPLICATORS);

/**
 * Whether a schema may constrain the instance location `segments` names
 * (pointer tokens of the walk, under the schema's own location) with the
 * keyword `keyword` — or, for `member`, constrain that member of the
 * object found there. Unsure is yes: a hop the walk cannot follow, an
 * applicator met on the way (constraints may sit inside it), a keyword
 * that covers the location without naming it (`patternProperties`,
 * `additionalProperties`, `contains`, …).
 * @param {unknown} schema
 * @param {string[]} segments
 * @param {Side} side
 * @param {{ keyword?: string, member?: string }} what
 * @returns {boolean}
 */
function mayConstrain(schema, segments, side, what) {
  let node = schema;
  for (let i = 0; ; i++) {
    const resolved = resolveHops(node, side);
    if (!('node' in resolved)) return true;
    node = resolved.node;
    if (node === true) return false;
    if (!isObject(node)) return true;
    if (Object.keys(node).length === 0) return false;
    if (Object.keys(node).some((key) => IN_PLACE.has(key) || key === '$dynamicRef')) return true;
    if (i === segments.length) break;
    const segment = segments[i];
    if (IN_PLACE.has(segment)) {
      // a branch of the walked side: the instance location stays
      if (segment !== 'then' && segment !== 'else') i++;
      continue;
    }
    if (segment === 'properties') {
      const name = segments[++i];
      if (isObject(node.properties) && Object.hasOwn(node.properties, name)) node = node.properties[name];
      else return node.patternProperties !== undefined || (node.additionalProperties !== undefined && node.additionalProperties !== true);
    }
    else if (segment === 'additionalProperties') {
      if (node.additionalProperties !== undefined) node = node.additionalProperties;
      else return node.properties !== undefined || node.patternProperties !== undefined;
    }
    else if (segment === 'items' || segment === 'prefixItems') {
      const at = segment === 'prefixItems' ? Number(segments[++i]) : -1;
      if (Array.isArray(node.prefixItems) && at >= 0 && at < node.prefixItems.length) node = node.prefixItems[at];
      else if (node.items !== undefined && !Array.isArray(node.items)) node = node.items;
      else return node.items !== undefined || node.prefixItems !== undefined || node.contains !== undefined;
    }
    else return true;
  }
  if (what.member !== undefined) {
    const m = what.member;
    return (isObject(node.properties) && Object.hasOwn(node.properties, m)) || (Array.isArray(node.required) && node.required.includes(m))
      || closedObject(node) || constrainingCatchAll(node) !== null;
  }
  if (what.keyword === undefined || what.keyword === 'schema') return true;
  return node[what.keyword] !== undefined;
}

/**
 * The pointer tokens of `path` below `prefix`.
 * @param {string} path @param {string} prefix
 * @returns {string[]}
 */
const tokensBelow = (path, prefix) => (path.length === prefix.length ? []
  : path.slice(prefix.length + 1).split('/').map(decodeJSONPointerSegment));

/**
 * The sink a branch walk reports into: a constraint or member event whose
 * location another schema applied beside the branch may also constrain
 * (the node's own keywords, another `allOf` conjunct, another
 * `dependentSchemas` entry) is R15 under the applicator — the branch
 * dropped or added it, but what the node accepts need not have moved.
 * Variants of a union read by direction never apply together and mask nothing.
 * @param {Sink} sink
 * @param {string} key - the applicator
 * @param {string} branchPath - pointer to the branch walked
 * @param {{ schema: unknown, side: Side, prefix: string[] }[]} beside
 * @returns {Sink}
 */
function besideSink(sink, key, branchPath, beside) {
  const masked = (/** @type {string} */ path, /** @type {{ keyword?: string, member?: string }} */ what) => {
    const tokens = tokensBelow(path, branchPath);
    return beside.some(({ schema, side, prefix }) => mayConstrain(schema, [...prefix, ...tokens], side, what));
  };
  // a type or enum change can narrow and widen at once: one R15 for both
  const reported = new Set();
  return {
    constraint(direction, keyword, path, from, to) {
      const location = keyword === 'schema' ? path : path.slice(0, path.lastIndexOf('/'));
      if (!masked(location, { keyword })) sink.constraint(direction, keyword, path, from, to);
      else if (!reported.has(path)) {
        reported.add(path);
        sink.unknown(key, path, from, to);
      }
    },
    member(event, direction, path, member, closedBefore, catchAll) {
      const container = path.slice(0, path.lastIndexOf(path.endsWith('/required') ? '/required' : '/properties/'));
      if (direction !== 'unknown' && masked(container, { member })) sink.unknown(key, path, member, member);
      else sink.member(event, direction, path, member, closedBefore, catchAll);
    },
    unknown: sink.unknown,
    respelled: sink.respelled,
  };
}

/**
 * The sink of a variant walked against the one it pairs with at another
 * position in `a`: a change that names what only `a` holds — a removed
 * member, a dropped constraint — points into `a`, so its pointer takes
 * the variant's position there.
 * @param {Sink} sink
 * @param {string} inB - pointer to the variant in `b`
 * @param {string} inA - pointer to the variant in `a`
 * @returns {Sink}
 */
function movedSink(sink, inB, inA) {
  // every event of the variant's walk lies under its pointer in `b`
  const intoA = (/** @type {string} */ path) => inA + path.slice(inB.length);
  return {
    constraint: (direction, keyword, path, from, to) => sink.constraint(direction, keyword, to === undefined ? intoA(path) : path, from, to),
    member: (event, direction, path, member, closedBefore, catchAll) =>
      sink.member(event, direction, event === 'removed' ? intoA(path) : path, member, closedBefore, catchAll),
    unknown: (keyword, path, from, to) => sink.unknown(keyword, to === undefined ? intoA(path) : path, from, to),
    respelled: sink.respelled,
  };
}

/**
 * Walk the branches of a decided applicator ({@link decidedApplicators})
 * pairwise, so a branch change classifies by the rules a bare schema in
 * that position takes, through {@link besideSink}: where what else the
 * node applies may constrain the same location, the change is R15. Union
 * variants pair by key ({@link pairVariants}); one added or removed is the
 * union widened or narrowed by its own values (`note: 'schema'`).
 * @param {string} key
 * @param {Record<string, any>} A - the node on side `a`
 * @param {Record<string, any>} B - the node on side `b`
 * @param {string} path - pointer to the keyword's value
 * @param {Side} a
 * @param {Side} b
 * @param {Sink} sink
 * @param {Map<object, Set<object>>} visited
 */
function compareBranches(key, A, B, path, a, b, sink, visited) {
  const own = (/** @type {Record<string, any>} */ node) => Object.fromEntries(Object.entries(node).filter(([k]) =>
    k !== key && !ANNOTATIONS.has(k) && !RESOLUTION.has(k) && !((key === 'then' || key === 'else') && (k === 'if' || k === 'then' || k === 'else'))));
  const node = [{ schema: own(A), side: a, prefix: /** @type {string[]} */ ([]) }, { schema: own(B), side: b, prefix: /** @type {string[]} */ ([]) }];
  /**
   * @param {unknown} x @param {unknown} y @param {string} at
   * @param {{ schema: unknown, side: Side, prefix: string[] }[]} beside @param {Sink} [into]
   */
  const walk = (x, y, at, beside, into = sink) => compareSchema(x, y, at, a, b, besideSink(into, key, at, beside), visited);
  if (key === 'then' || key === 'else') walk(A[key], B[key], path, node);
  else if (key === 'anyOf' || key === 'oneOf') {
    const { pairs, removed, added } = /** @type {NonNullable<ReturnType<typeof pairVariants>>} */ (pairVariants(A[key], B[key], a, b));
    for (const [i, j] of pairs) {
      const at = `${path}/${j}`;
      walk(A[key][i], B[key][j], at, node, i === j ? sink : movedSink(sink, at, `${path}/${i}`));
    }
    // a variant added or removed widens or narrows the union by exactly
    // its own values — unless the node beside it may refuse them anyway
    for (const j of added) besideSink(sink, key, `${path}/${j}`, node).constraint('widened', 'schema', `${path}/${j}`, undefined, B[key][j]);
    for (const i of removed) besideSink(sink, key, `${path}/${i}`, node).constraint('narrowed', 'schema', `${path}/${i}`, A[key][i], undefined);
  }
  else if (key === 'dependentSchemas') {
    for (const name of Object.keys(B[key])) {
      const others = Object.keys(B[key]).filter((other) => other !== name).flatMap((other) => [
        { schema: A[key][other], side: a, prefix: [] }, { schema: B[key][other], side: b, prefix: [] }]);
      walk(A[key][name], B[key][name], path + '/' + encodeJSONPointerSegment(name), [...node, ...others]);
    }
  }
  else {
    for (let i = 0; i < B[key].length; i++) {
      const at = `${path}/${i}`;
      if (key === 'prefixItems') walk(A[key][i], B[key][i], at, node.map((n) => ({ ...n, prefix: ['prefixItems', String(i)] })));
      else {
        // allOf: every other conjunct applies beside this one
        const others = B[key].flatMap((/** @type {unknown} */ _, /** @type {number} */ j) => (j === i ? []
          : [{ schema: A[key][j], side: a, prefix: [] }, { schema: B[key][j], side: b, prefix: [] }]));
        walk(A[key][i], B[key][i], at, [...node, ...others]);
      }
    }
  }
}

/**
 * Compare two schema nodes in parallel over the modeled structure.
 * @param {any} aNode
 * @param {any} bNode
 * @param {string} path - pointer relative to the schema roots
 * @param {Side} a
 * @param {Side} b
 * @param {Sink} sink
 * @param {Map<object, Set<object>>} visited - pair memo (recursive schemas terminate)
 */
function compareSchema(aNode, bNode, path, a, b, sink, visited) {
  const ra = resolveHops(aNode, a);
  const rb = resolveHops(bNode, b);
  if ('external' in ra || 'external' in rb) {
    const from = 'external' in ra ? ra.external : undefined;
    const to = 'external' in rb ? rb.external : undefined;
    if (from !== to) sink.unknown('$ref', path, aNode, bNode);
    return;
  }
  if ('opaque' in ra || 'opaque' in rb) {
    if (canon(aNode) !== canon(bNode)) sink.unknown('$ref', path, aNode, bNode);
    else reportDivergence(schemaDivergence(aNode, bNode, path, a, b, new Map()), '$ref', sink);
    return;
  }
  let A = ra.node;
  let B = rb.node;
  // booleans: `true` is the empty schema, `false` accepts nothing
  if (A === false || B === false) {
    if (A === false && B === false) return;
    if (B === false) sink.constraint('narrowed', 'schema', path, A, false);
    else sink.constraint('widened', 'schema', path, false, B);
    return;
  }
  if (A === true) A = {};
  if (B === true) B = {};
  if (!isObject(A) || !isObject(B)) {
    if (canon(A) !== canon(B)) sink.unknown('schema', path, A, B);
    else if (Array.isArray(A) && Array.isArray(B)) reportDivergence(divergenceInList(A, B, path, a, b, new Map()), 'schema', sink);
    return;
  }
  if (A === B) return;
  let pairs = visited.get(A);
  if (pairs !== undefined && pairs.has(B)) return;
  if (pairs === undefined) visited.set(A, (pairs = new Set()));
  pairs.add(B);

  // A nullable node has two spellings — `type: [T, 'null']` and a
  // two-branch anyOf/oneOf with a null-only branch — and they are one
  // meaning exactly when canonicalNullable can say so (the value sets are
  // equal). A respelling alone is neutral R16; a respelling beside a real
  // change reports both, and the change is read on the one spelling.
  const canonA = canonicalNullable(A);
  const canonB = canonA === null ? null : canonicalNullable(B);
  if (canonA !== null && canonB !== null) {
    const spellingA = nullableSpelling(A);
    const spellingB = nullableSpelling(B);
    // a reorder inside one spelling (a type array's items, a union's
    // branches) is no respelling: silent, as any other reorder is
    if (spellingA !== spellingB) sink.respelled(path, A, B);
    // equal text with a `$ref` below that resolves apart is a change the
    // walk reads through the type-array spelling, as any other
    if (!schemasDiffer(canonA, canonB, a, b)) return;
    if (spellingA !== 'type' && spellingB !== 'type') {
      // two unions: compare the non-null branches where they sit, so a
      // change's pointer resolves in the documents (a removal's in `a`)
      const ia = nonNullBranch(A[spellingA]);
      const ib = nonNullBranch(B[spellingB]);
      const at = `${path}/${spellingB}/${ib}`;
      const into = spellingA === spellingB && ia === ib ? sink : movedSink(sink, at, `${path}/${spellingA}/${ia}`);
      compareSchema(A[spellingA][ia], B[spellingB][ib], at, a, b, into, visited);
      return;
    }
    A = canonA;
    B = canonB;
  }

  const structure = compareUnmodeled(A, B, path, a, b, sink, visited);
  compareConstraints(A, B, path, sink);
  if (structure) {
    compareObject(A, B, path, a, b, sink, visited);
    if (A.items !== undefined || B.items !== undefined) {
      if (A.items === undefined) sink.constraint('narrowed', 'items', path + '/items', undefined, B.items);
      else if (B.items === undefined) sink.constraint('widened', 'items', path + '/items', A.items, undefined);
      else compareSchema(A.items, B.items, path + '/items', a, b, sink, visited);
    }
  }
}

/**
 * Every keyword of a schema pair that is neither an annotation, a
 * resolution artifact, an R6 constraint nor object structure: one that
 * differs is R15. Equal text is not equal validation when a `$ref` inside
 * resolves apart on the two sides, so such a keyword reports where the
 * resolved schemas first differ. Answers whether either side carries
 * object structure (`properties`, `required`, `additionalProperties`,
 * `items`), which the caller's structure pass then reads. An applicator
 * whose branches have a decidable direction is walked branch against
 * branch instead ({@link decidedApplicators}), unless `besideRef` says the
 * node is the target of a `$ref` whose siblings read its annotations.
 * @param {Record<string, any>} A
 * @param {Record<string, any>} B
 * @param {string} path
 * @param {Side} a
 * @param {Side} b
 * @param {Sink} sink
 * @param {Map<object, Set<object>>} visited
 * @param {boolean} [besideRef]
 * @returns {boolean}
 */
function compareUnmodeled(A, B, path, a, b, sink, visited, besideRef = false) {
  let structure = false;
  const decided = besideRef ? new Set() : decidedApplicators(A, B, a, b);
  for (const key of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (ANNOTATIONS.has(key) || RESOLUTION.has(key)) continue;
    if (CONSTRAINT_SET.has(key)) continue; // the constraint pass
    if (STRUCTURE.has(key)) {
      structure = true;
      continue;
    }
    if (decided.has(key)) {
      compareBranches(key, A, B, path + '/' + key, a, b, sink, visited);
      continue;
    }
    if (canon(A[key]) !== canon(B[key])) sink.unknown(key, path + '/' + key, A[key], B[key]);
    else reportDivergence(divergence(key, A[key], B[key], path + '/' + key, a, b, new Map()), key, sink);
  }
  return structure;
}

/**
 * Report a resolved divergence (if any) as R15 under the keyword whose
 * construct the walk does not model.
 * @param {{ path: string, from: unknown, to: unknown } | null} found
 * @param {string} keyword
 * @param {Sink} sink
 */
function reportDivergence(found, keyword, sink) {
  if (found !== null) sink.unknown(keyword, found.path, found.from, found.to);
}

/**
 * The R6 keyword set, leaf by leaf.
 * @param {Record<string, any>} A
 * @param {Record<string, any>} B
 * @param {string} path
 * @param {Sink} sink
 */
function compareConstraints(A, B, path, sink) {
  // a constraint present on one side only may have moved into an
  // applicator the other side carries (anyOf, allOf, …): which way the
  // accepted values moved cannot be decided, so it is R15, never a guess
  const aApplies = carriesApplicator(A);
  const bApplies = carriesApplicator(B);
  const emit = (/** @type {'narrowed' | 'widened'} */ d, /** @type {string} */ k) => {
    const oneSided = A[k] === undefined ? aApplies : B[k] === undefined ? bApplies : false;
    if (oneSided) sink.unknown(k, path + '/' + k, A[k], B[k]);
    else sink.constraint(d, k, path + '/' + k, A[k], B[k]);
  };

  // type and enum/const compare as value sets: what was removed narrows,
  // what was added widens — an incomparable change (string → integer)
  // honestly reports BOTH
  const sets = [
    ['type', (/** @type {any} */ v) => (v === undefined ? null : Array.isArray(v) ? v : [v])],
    ['enum', (/** @type {any} */ v) => (v === undefined ? null : v)],
    ['const', (/** @type {any} */ v) => (v === undefined ? null : [v])],
  ];
  for (const [key, toSet] of /** @type {[string, (v: any) => any[] | null][]} */ (sets)) {
    if (canon(A[key]) === canon(B[key])) continue;
    const before = toSet(A[key]);
    const after = toSet(B[key]);
    if (before === null) emit('narrowed', key); // unconstrained → constrained
    else if (after === null) emit('widened', key);
    else {
      const beforeTexts = new Set(before.map(canon));
      const afterTexts = new Set(after.map(canon));
      const covered = (/** @type {string} */ t, /** @type {Set<string>} */ set) => (key === 'type' ? typeCovered(t, set) : set.has(t));
      if ([...beforeTexts].some((t) => !covered(t, afterTexts))) emit('narrowed', key);
      if ([...afterTexts].some((t) => !covered(t, beforeTexts))) emit('widened', key);
    }
  }

  // numeric/length bounds: which way did the accepted range move?
  for (const [key, tighterWhen] of /** @type {[string, 'lower' | 'higher'][]} */ ([
    ['maximum', 'lower'], ['maxLength', 'lower'], ['minimum', 'higher'], ['minLength', 'higher'],
  ])) {
    const from = A[key];
    const to = B[key];
    if (from === to) continue;
    if (typeof from !== 'number' && from !== undefined) { sink.unknown(key, path + '/' + key, from, to); continue; }
    if (typeof to !== 'number' && to !== undefined) { sink.unknown(key, path + '/' + key, from, to); continue; }
    if (from === undefined) emit('narrowed', key);
    else if (to === undefined) emit('widened', key);
    else if (tighterWhen === 'lower' ? to < from : to > from) emit('narrowed', key);
    else emit('widened', key);
  }

  if (A.pattern !== B.pattern) {
    if (A.pattern === undefined) emit('narrowed', 'pattern');
    else if (B.pattern === undefined) emit('widened', 'pattern');
    else sink.unknown('pattern', path + '/pattern', A.pattern, B.pattern); // two regex languages are not comparable
  }
}

/**
 * Object structure: members, `required`, `additionalProperties`.
 * @param {Record<string, any>} A
 * @param {Record<string, any>} B
 * @param {string} path
 * @param {Side} a
 * @param {Side} b
 * @param {Sink} sink
 * @param {Map<object, Set<object>>} visited
 */
function compareObject(A, B, path, a, b, sink, visited) {
  const aProps = isObject(A.properties) ? A.properties : {};
  const bProps = isObject(B.properties) ? B.properties : {};
  const aReq = new Set(Array.isArray(A.required) ? A.required : []);
  const bReq = new Set(Array.isArray(B.required) ? B.required : []);
  const aClosed = closedObject(A);
  const bClosed = closedObject(B);
  const aCatchAll = aClosed ? null : constrainingCatchAll(A);
  const bCatchAll = bClosed ? null : constrainingCatchAll(B);
  // a member or requirement present on one side only may have moved into
  // an applicator the other side carries: undecidable, R15
  const aApplies = carriesApplicator(A);
  const bApplies = carriesApplicator(B);

  for (const m of new Set([...Object.keys(aProps), ...Object.keys(bProps)])) {
    const at = path + '/properties/' + encodeJSONPointerSegment(m);
    const inA = Object.hasOwn(aProps, m);
    const inB = Object.hasOwn(bProps, m);
    if ((inA && !inB && bApplies) || (!inA && inB && aApplies)) {
      sink.unknown('properties', at, inA ? m : undefined, inB ? m : undefined);
      continue;
    }
    const aApplied = forbiddenOnOneSide(m, B, b, A);
    const bApplied = forbiddenOnOneSide(m, A, a, B);
    if (aApplied !== undefined || bApplied !== undefined) {
      compareSchema(inA ? aProps[m] : aApplied, inB ? bProps[m] : bApplied, at, a, b, sink, visited);
      continue;
    }
    if (inA && !inB) {
      // removed: forbidden under a closed b, unconstrained under an open
      // one, judged by b's catch-all under one that constrains
      sink.member('removed', bClosed ? 'narrowed' : bCatchAll !== null ? 'unknown' : 'widened', at, m, aClosed, bCatchAll);
      continue;
    }
    if (!inA && inB) {
      const unconstrained = bProps[m] === true || (isObject(bProps[m]) && Object.keys(bProps[m]).length === 0);
      if (aCatchAll !== null) sink.member(bReq.has(m) ? 'added-required' : 'added-optional', 'unknown', at, m, aClosed, aCatchAll);
      else if (bReq.has(m)) sink.member('added-required', 'narrowed', at, m, aClosed);
      else if (aClosed) sink.member('added-optional', 'widened', at, m, aClosed); // was forbidden, now allowed
      else sink.member('added-optional', unconstrained ? null : 'narrowed', at, m, aClosed); // was unconstrained
      continue;
    }
    if (!aReq.has(m) && bReq.has(m)) {
      if (aApplies) sink.unknown('required', at, undefined, m);
      else sink.member('made-required', 'narrowed', at, m, aClosed);
    }
    else if (aReq.has(m) && !bReq.has(m)) {
      if (bApplies) sink.unknown('required', at, m, undefined);
      else sink.member('made-optional', 'widened', at, m, aClosed);
    }
    compareSchema(aProps[m], bProps[m], at, a, b, sink, visited);
  }

  // a required name without a properties entry is still a requirement
  for (const m of bReq) {
    if (!aReq.has(m) && !Object.hasOwn(bProps, m) && !Object.hasOwn(aProps, m)) {
      if (aApplies) sink.unknown('required', path + '/required', undefined, m);
      else sink.member('added-required', 'narrowed', path + '/required', m, aClosed);
    }
  }
  for (const m of aReq) {
    if (!bReq.has(m) && !Object.hasOwn(aProps, m) && !Object.hasOwn(bProps, m)) {
      if (bApplies) sink.unknown('required', path + '/required', m, undefined);
      else sink.member('made-optional', 'widened', path + '/required', m, aClosed);
    }
  }

  const aAp = A.additionalProperties === undefined ? true : A.additionalProperties;
  const bAp = B.additionalProperties === undefined ? true : B.additionalProperties;
  if (schemasDiffer(aAp, bAp, a, b)) {
    compareSchema(aAp, bAp, path + '/additionalProperties', a, b, sink, visited);
  }
}

//#region the operation walk

/** @param {string} id */
const opPath = (/** @type {string} */ id) => '/operations/' + encodeJSONPointerSegment(id);

/**
 * @param {Change[]} into
 * @param {Change} change
 */
const push = (into, change) => { into.push(change); };

/**
 * The rule table's classification of one rule id.
 * @param {ContractDiff} diff
 * @param {string} rule
 * @returns {Change[]}
 */
function classOf(diff, rule) {
  switch (rule) {
    case 'R2': case 'R7': case 'R9': case 'R11': return diff.additive;
    case 'R13': case 'R16': return diff.neutral;
    case 'R15': return diff.unknown;
    default: return diff.breaking;
  }
}

/**
 * A sink whose events land as classified changes of one operation.
 * @param {ContractDiff} diff
 * @param {string} op
 * @param {string} root - `/operations/<id>/input` or `…/output`
 * @param {'input' | 'output'} what - input maps narrow/widen to R6/R7,
 *   output maps member events to R8/R9 and narrow/widen likewise
 * @returns {Sink}
 */
function schemaSink(diff, op, root, what) {
  // Variance: an input is consumed by the SERVER, so narrowing it refuses
  // what old clients send (breaking) and widening accepts more (additive);
  // an output is consumed by the CLIENT, which validates what it receives
  // against its own contract, so widening hands it values it refuses
  // (breaking — the suite's own client answers JC2053) and narrowing is
  // additive: a client on the wider contract accepts every narrower answer.
  /** @type {(direction: 'narrowed' | 'widened') => [string, string]} */
  const directionRule = (direction) => (what === 'input'
    ? (direction === 'narrowed' ? ['R6', 'input-narrowed'] : ['R7', 'input-widened'])
    : (direction === 'widened' ? ['R8', 'output-widened'] : ['R9', 'output-narrowed']));
  return {
    constraint(direction, keyword, path, from, to) {
      const [rule, kind] = directionRule(direction);
      push(classOf(diff, rule), { kind, op, docPath: root + path, from, to, rule, note: keyword });
    },
    member(event, direction, path, member, closedBefore, catchAll) {
      if (direction === 'unknown' && (what === 'input' || event !== 'removed')) {
        // a catch-all (additionalProperties as a schema, patternProperties,
        // propertyNames) judges the member on the other side: undecidable
        push(diff.unknown, { kind: 'schema-unknown', op, docPath: root + path, from: member, to: member, rule: 'R15', note: catchAll ?? 'additionalProperties' });
        return;
      }
      if (what === 'output') {
        // the consumer's view: a removed or no-longer-guaranteed member
        // breaks a client that reads it, and a new member breaks a client
        // whose schema was closed (its validator refuses the member); on
        // an open schema a new member is additive
        const added = event === 'added-optional' || event === 'added-required';
        const breaking = event === 'removed' || event === 'made-optional' || (added && closedBefore);
        const rule = breaking ? 'R8' : 'R9';
        push(classOf(diff, rule), {
          kind: event === 'removed' ? 'output-member-removed'
            : event === 'made-optional' ? 'output-member-optional'
              : event === 'made-required' ? 'output-member-guaranteed'
                : 'output-member-added',
          op, docPath: root + path, from: member, to: member, rule,
        });
        return;
      }
      if (direction === null) return; // a no-op member event (unconstrained optional member on an open object)
      const [rule, kind] = directionRule(direction);
      push(classOf(diff, rule), { kind, op, docPath: root + path, from: member, to: member, rule, note: event });
    },
    unknown(keyword, path, from, to) {
      push(diff.unknown, { kind: 'schema-unknown', op, docPath: root + path, from, to, rule: 'R15', note: keyword });
    },
    respelled(path, from, to) {
      push(diff.neutral, { kind: 'schema-respelled', op, docPath: root + path, from, to, rule: 'R16' });
    },
  };
}

/**
 * The top-level input members of both sides, by the R4/R5/R7 rows (a
 * member moved beside a constraining catch-all is R15), then the member
 * schemas recursively, the input's own other keywords and the siblings
 * of the `$ref` it is spelled as.
 * @param {ContractDiff} diff
 * @param {CompiledOperation} aOp
 * @param {CompiledOperation} bOp
 * @param {Side} a
 * @param {Side} b
 */
function compareInput(diff, aOp, bOp, a, b) {
  const op = aOp.id;
  const root = opPath(op) + '/input';
  const aEff = aOp.input === null ? null : aOp.input.effective;
  const bEff = bOp.input === null ? null : bOp.input.effective;
  if (aEff === null && bEff === null) return;

  const aProps = aEff !== null && isObject(aEff.properties) ? aEff.properties : {};
  const bProps = bEff !== null && isObject(bEff.properties) ? bEff.properties : {};
  const aReq = new Set(aEff !== null && Array.isArray(aEff.required) ? aEff.required : []);
  const bReq = new Set(bEff !== null && Array.isArray(bEff.required) ? bEff.required : []);
  const bClosed = bEff === null || closedObject(bEff);
  // a catch-all that constrains the members the input does not name judges
  // a member moved out of (or into) `properties`: undecidable, R15
  const aCatchAll = aEff === null || closedObject(aEff) ? null : constrainingCatchAll(aEff);
  const bCatchAll = bClosed ? null : constrainingCatchAll(bEff);
  const judged = (/** @type {string} */ at, /** @type {string} */ m, /** @type {string} */ catchAll) =>
    push(diff.unknown, { kind: 'schema-unknown', op, docPath: at, from: m, to: m, rule: 'R15', note: catchAll });

  if (aEff !== null && bEff === null) {
    push(diff.breaking, {
      kind: 'input-removed', op, docPath: root, from: aOp.input?.schema, rule: 'R5',
      note: 'the operation no longer takes input — anything an older client sends is refused',
    });
    return;
  }

  const sink = schemaSink(diff, op, root, 'input');
  const visited = new Map();
  // the siblings of a `$ref` the input is spelled as judge the members the
  // target does not name (a catch-all beside it), so a `false` member is
  // read against what the target applies only when there are none
  const aBeside = refSiblings(aOp.input?.schema);
  const bBeside = refSiblings(bOp.input?.schema);
  const plain = Object.keys(aBeside).length === 0 && Object.keys(bBeside).length === 0;
  for (const m of new Set([...Object.keys(aProps), ...Object.keys(bProps), ...aReq, ...bReq])) {
    const rel = '/properties/' + encodeJSONPointerSegment(m);
    const at = root + rel;
    const inA = Object.hasOwn(aProps, m) || aReq.has(m);
    const inB = Object.hasOwn(bProps, m) || bReq.has(m);
    const aApplied = plain ? forbiddenOnOneSide(m, bEff, b, aEff) : undefined;
    const bApplied = plain ? forbiddenOnOneSide(m, aEff, a, bEff) : undefined;
    if (aApplied !== undefined || bApplied !== undefined) {
      compareSchema(inA ? aProps[m] : aApplied, inB ? bProps[m] : bApplied, rel, a, b, sink, visited);
      continue;
    }
    if (inA && !inB) {
      if (bClosed) {
        push(diff.breaking, { kind: 'input-member-removed', op, docPath: at, from: m, rule: 'R5' });
      }
      else if (bCatchAll !== null) judged(at, m, bCatchAll);
      else {
        push(diff.neutral, {
          kind: 'input-member-removed', op, docPath: at, from: m, rule: 'R5',
          note: 'the input schema stays open, so the member is now ignored, not validated',
        });
      }
      continue;
    }
    if (!inA && inB) {
      if (bReq.has(m)) push(diff.breaking, { kind: 'input-required-added', op, docPath: at, to: m, rule: 'R4' });
      else if (aCatchAll !== null) judged(at, m, aCatchAll);
      else push(diff.additive, { kind: 'input-member-added', op, docPath: at, to: m, rule: 'R7' });
      continue;
    }
    if (!aReq.has(m) && bReq.has(m)) {
      push(diff.breaking, { kind: 'input-required-added', op, docPath: at, from: m, to: m, rule: 'R4' });
    }
    else if (aReq.has(m) && !bReq.has(m)) {
      push(diff.additive, { kind: 'input-member-optional', op, docPath: at, from: m, to: m, rule: 'R7' });
    }
    if (Object.hasOwn(aProps, m) && Object.hasOwn(bProps, m)) {
      compareSchema(aProps[m], bProps[m], rel, a, b, sink, visited);
    }
  }
  const aAp = aEff === null || aEff.additionalProperties === undefined ? true : aEff.additionalProperties;
  const bAp = bEff.additionalProperties === undefined ? true : bEff.additionalProperties;
  if (schemasDiffer(aAp, bAp, a, b)) compareSchema(aAp, bAp, '/additionalProperties', a, b, sink, visited);
  if (aEff === null) return;
  // the rest of the input's own keywords (an applicator, a bound on its
  // members, a catch-all) validate the request as much as its members do,
  // and so do the siblings of a `$ref` the input is spelled as (the
  // members are read from what the `$ref` resolves to)
  compareUnmodeled(aEff, bEff, '', a, b, sink, visited, readsAnnotations(aBeside) || readsAnnotations(bBeside));
  compareConstraints(aEff, bEff, '', sink);
  if (canon(aBeside) !== canon(bBeside)) sink.unknown('$ref', '', aOp.input?.schema, bOp.input?.schema);
  else reportDivergence(schemaDivergence(aBeside, bBeside, '', a, b, new Map()), '$ref', sink);
}

/**
 * The keywords beside a schema's `$ref` (annotations aside), or `{}`.
 * @param {unknown} schema
 * @returns {Record<string, unknown>}
 */
function refSiblings(schema) {
  if (!isObject(schema) || typeof schema.$ref !== 'string') return {};
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref' && !ANNOTATIONS.has(key)));
}

/**
 * The binding members of R3, plus member locations and the whole-body
 * member — a member that moves (query → header, say) rewrites the wire
 * exactly like a moved path, so it classifies with the binding row.
 * @param {ContractDiff} diff
 * @param {CompiledOperation} aOp
 * @param {CompiledOperation} bOp
 */
function compareBinding(diff, aOp, bOp) {
  const op = aOp.id;
  const emit = (/** @type {string} */ member, /** @type {unknown} */ from, /** @type {unknown} */ to) =>
    push(diff.breaking, { kind: 'binding-changed', op, docPath: opPath(op) + '/http/' + member, from, to, rule: 'R3', note: member });
  if (aOp.kind !== bOp.kind) {
    push(diff.breaking, { kind: 'binding-changed', op, docPath: opPath(op) + '/kind', from: aOp.kind, to: bOp.kind, rule: 'R3', note: 'kind' });
  }
  if (aOp.http.method !== bOp.http.method) emit('method', aOp.http.method, bOp.http.method);
  const aShape = pathShape(aOp.http.template);
  const bShape = pathShape(bOp.http.template);
  if (aShape !== bShape) emit('path', aOp.http.path, bOp.http.path);
  if (aOp.http.status !== bOp.http.status) emit('status', aOp.http.status, bOp.http.status);
  if (aOp.http.media !== bOp.http.media) {
    // the binding matches media by type/subtype alone — case-insensitive,
    // parameters ignored — so a respelling moves the document, never what
    // a request must send
    if (bareMedia(aOp.http.media) === bareMedia(bOp.http.media)) {
      push(diff.neutral, { kind: 'media-respelled', op, docPath: opPath(op) + '/http/media', from: aOp.http.media, to: bOp.http.media, rule: 'R3' });
    }
    else emit('media', aOp.http.media, bOp.http.media);
  }
  if (aOp.http.opaque !== bOp.http.opaque) emit('media', aOp.http.opaque, bOp.http.opaque);
  if (aOp.http.body !== bOp.http.body) emit('body', aOp.http.body, bOp.http.body);
  for (const m of new Set([...Object.keys(aOp.http.in), ...Object.keys(bOp.http.in)])) {
    const from = Object.hasOwn(aOp.http.in, m) ? aOp.http.in[m] : undefined;
    const to = Object.hasOwn(bOp.http.in, m) ? bOp.http.in[m] : undefined;
    if (from !== undefined && to !== undefined && from !== to) {
      push(diff.breaking, {
        kind: 'binding-changed', op, docPath: opPath(op) + '/http/in/' + encodeJSONPointerSegment(m),
        from, to, rule: 'R3', note: `member '${m}' moved`,
      });
    }
  }
}

/**
 * Declared errors: codes and statuses by R10/R11; a changed `details`
 * schema is a construct the table does not model, so it reports (R15).
 * @param {ContractDiff} diff
 * @param {CompiledOperation} aOp
 * @param {CompiledOperation} bOp
 * @param {Side} a
 * @param {Side} b
 */
function compareErrors(diff, aOp, bOp, a, b) {
  const op = aOp.id;
  for (const code of new Set([...Object.keys(aOp.errors), ...Object.keys(bOp.errors)])) {
    const at = opPath(op) + '/errors/' + encodeJSONPointerSegment(code);
    const from = Object.hasOwn(aOp.errors, code) ? aOp.errors[code] : undefined;
    const to = Object.hasOwn(bOp.errors, code) ? bOp.errors[code] : undefined;
    if (from !== undefined && to === undefined) {
      push(diff.breaking, { kind: 'error-removed', op, docPath: at, from: code, rule: 'R10' });
      continue;
    }
    if (from === undefined && to !== undefined) {
      push(diff.additive, { kind: 'error-added', op, docPath: at, to: code, rule: 'R11' });
      continue;
    }
    if (from === undefined || to === undefined) continue;
    if (from.status !== to.status) {
      push(diff.breaking, { kind: 'error-status-changed', op, docPath: at + '/status', from: from.status, to: to.status, rule: 'R10' });
    }
    // equal text can still validate apart, through a `$ref` that resolves
    // to a changed schema: that reports where the two first differ
    const moved = canon(from.schema) !== canon(to.schema)
      ? { path: '', from: from.schema, to: to.schema }
      : schemaDivergence(from.schema, to.schema, '', a, b, new Map());
    if (moved !== null) {
      push(diff.unknown, {
        kind: 'error-schema-changed', op, docPath: at + '/schema' + moved.path, from: moved.from, to: moved.to,
        rule: 'R15', note: 'the rule table does not model error-schema evolution',
      });
    }
  }
}

/**
 * Policy: `idempotency` by R12, the client-observable rest by R13.
 * @param {ContractDiff} diff
 * @param {CompiledOperation} aOp
 * @param {CompiledOperation} bOp
 */
function comparePolicy(diff, aOp, bOp) {
  const op = aOp.id;
  const at = (/** @type {string} */ m) => opPath(op) + '/policy/' + m;
  const from = aOp.policy;
  const to = bOp.policy;
  if (from.idempotency !== to.idempotency) {
    // a client must now send a key it never sent (→ required); or a key an
    // old client still sends — and retries under, by policy or by hand — is
    // no longer read, so a retried lost answer runs the command twice (→ none)
    const kind = to.idempotency === 'required' ? 'idempotency-required'
      : to.idempotency === 'none' ? 'idempotency-dropped' : 'idempotency-relaxed';
    push(kind === 'idempotency-relaxed' ? diff.additive : diff.breaking, {
      kind, op, docPath: at('idempotency'), from: from.idempotency, to: to.idempotency, rule: 'R12',
    });
  }
  const neutral = /** @type {[string, unknown, unknown][]} */ ([
    ['task', from.task, to.task],
    ['retry', from.retry, to.retry],
    ['cache', from.cache, to.cache],
    ['revision', from.revision, to.revision],
  ]);
  for (const [member, before, after] of neutral) {
    if (canon(before) !== canon(after)) {
      push(diff.neutral, { kind: 'policy-changed', op, docPath: at(member), from: before, to: after, rule: 'R13' });
    }
  }
  // a stream's resume policy, heartbeat or patch bound is the stream's
  // behaviour, not its wire shape — neutral, but for one move: a slower
  // heartbeat breaks an older client, whose watchdog, armed from its own
  // contract, declares the stream lost at twice the interval it expects
  const beatBefore = from.stream === null ? null : from.stream.heartbeatMs;
  const beatAfter = to.stream === null ? null : to.stream.heartbeatMs;
  const slower = typeof beatBefore === 'number' && typeof beatAfter === 'number' && beatAfter > beatBefore;
  if (slower) {
    push(diff.breaking, {
      kind: 'heartbeat-slowed', op, docPath: at('stream') + '/heartbeatMs', from: beatBefore, to: beatAfter, rule: 'R13',
      note: 'an older client arms its watchdog from its own contract and reports the stream lost (JC2094) after twice the interval it expects',
    });
  }
  const rest = (/** @type {any} */ stream) => (stream === null || !slower ? stream : { ...stream, heartbeatMs: null });
  if (canon(rest(from.stream)) !== canon(rest(to.stream))) {
    push(diff.neutral, { kind: 'policy-changed', op, docPath: at('stream'), from: from.stream, to: to.stream, rule: 'R13' });
  }
  if ((aOp.doc ?? null) !== (bOp.doc ?? null)) {
    push(diff.neutral, { kind: 'doc-changed', op, docPath: opPath(op) + '/doc', from: aOp.doc, to: bOp.doc, rule: 'R13' });
  }
}

//#endregion

/**
 * @param {unknown} value
 * @returns {Contract}
 */
function asCompiled(value) {
  if (isCompiledContract(value)) return /** @type {Contract} */ (value);
  return compileContract(value); // a document; a bad one refuses with its own JC00xx
}

/**
 * Classify every change from contract `a` to contract `b` by the §13
 * rule table. Takes compiled contracts or raw documents (documents are
 * compiled, so a malformed one refuses with its compile error before any
 * comparison). Operations whose `policy.audience` is `server` on BOTH
 * sides are outside the compatibility surface and are skipped — unless
 * `options.audience` is `'all'`, an internal gate's choice, which runs
 * the same rules on them and marks each of their changes `audience:
 * 'server'`. An audience flip is R14; for public consumers it subsumes
 * the operation's other changes, and under `'all'` they are compared too,
 * each marked `audience: 'server'`.
 * @param {Contract | Record<string, unknown>} a - the contract consumers hold today
 * @param {Contract | Record<string, unknown>} b - the contract they would meet
 * @param {{ audience?: 'public' | 'all' }} [options] - a closed set (`JC1008`)
 * @returns {ContractDiff}
 * @example
 * const { breaking } = diffContracts(v1Doc, v2Doc);
 * if (breaking.length > 0) throw new Error(breaking.map((c) => `${c.rule} ${c.op}: ${c.kind}`).join('\n'));
 */
export function diffContracts(a, b, options = undefined) {
  const audience = diffAudience(options);
  const A = asCompiled(a);
  const B = asCompiled(b);
  /** @type {ContractDiff} */
  const diff = { breaking: [], additive: [], neutral: [], unknown: [] };
  /** @type {Side} */
  const sideA = { doc: A.doc, anchors: collectSameDocumentAnchors(A.doc) };
  /** @type {Side} */
  const sideB = { doc: B.doc, anchors: collectSameDocumentAnchors(B.doc) };

  for (const id of new Set([...A.ids, ...B.ids])) {
    const aOp = Object.hasOwn(A.operations, id) ? A.operations[id] : null;
    const bOp = Object.hasOwn(B.operations, id) ? B.operations[id] : null;
    const marks = CLASSES.map((name) => diff[name].length);
    const server = compareOperation(diff, id, aOp, bOp, sideA, sideB, audience);
    // under `audience: 'all'`, every change of a server operation says so
    if (server) markServerChanges(diff, marks);
  }
  return diff;
}

/** The four classes, in the order a diff lists them. */
const CLASSES = /** @type {const} */ (['breaking', 'additive', 'neutral', 'unknown']);

/**
 * Label every change recorded since `marks` (each class's length when
 * the operation's comparison began) as a server operation's.
 * @param {any} diff @param {number[]} marks
 */
function markServerChanges(diff, marks) {
  CLASSES.forEach((name, i) => {
    for (let j = marks[i]; j < diff[name].length; j++) diff[name][j].audience = 'server';
  });
}

/**
 * The audience a diff reads: `'public'` by default (server-audience
 * operations are outside the compatibility surface and skipped), or
 * `'all'` for an internal gate, where the same rules run on them too.
 * @param {unknown} options
 * @returns {'public' | 'all'}
 */
function diffAudience(options) {
  if (options === undefined) return 'public';
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ContractHostError('JC1008', 'diffContracts: options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (key !== 'audience') throw new ContractHostError('JC1008', `diffContracts: options has no member '${key}' (it reads audience)`);
  }
  const audience = /** @type {any} */ (options).audience;
  if (audience === undefined) return 'public';
  if (audience !== 'public' && audience !== 'all') {
    throw new ContractHostError('JC1008', "diffContracts: options.audience is 'public' or 'all'");
  }
  return audience;
}

/**
 * Classify one operation's changes into `diff`. Answers whether the
 * changes it recorded belong to a server-audience operation (only ever
 * true under `audience: 'all'`).
 * @param {ContractDiff} diff
 * @param {string} id
 * @param {CompiledOperation | null} aOp
 * @param {CompiledOperation | null} bOp
 * @param {Side} sideA
 * @param {Side} sideB
 * @param {'public' | 'all'} audience
 * @returns {boolean}
 */
function compareOperation(diff, id, aOp, bOp, sideA, sideB, audience) {
  const all = audience === 'all';
  if (aOp !== null && bOp === null) {
    if (all || aOp.policy.audience !== 'server') {
      push(diff.breaking, { kind: 'operation-removed', op: id, docPath: opPath(id), rule: 'R1' });
    }
    return aOp.policy.audience === 'server';
  }
  if (aOp === null && bOp !== null) {
    if (all || bOp.policy.audience !== 'server') {
      push(diff.additive, { kind: 'operation-added', op: id, docPath: opPath(id), rule: 'R2' });
    }
    return bOp.policy.audience === 'server';
  }
  if (aOp === null || bOp === null) return false;
  if (aOp.policy.audience !== bOp.policy.audience) {
    const narrowed = bOp.policy.audience === 'server';
    push(narrowed ? diff.breaking : diff.additive, {
      kind: narrowed ? 'audience-narrowed' : 'audience-widened',
      op: id, docPath: opPath(id) + '/policy/audience',
      from: aOp.policy.audience, to: bOp.policy.audience, rule: 'R14',
    });
    // for a public client the flip is the whole story; an internal gate
    // also sees what changed inside the operation its server callers used
    if (!all) return false;
    const marks = CLASSES.map((name) => diff[name].length);
    compareInside(diff, id, aOp, bOp, sideA, sideB);
    markServerChanges(diff, marks);
    return false;
  }
  if (aOp.policy.audience === 'server' && !all) return false; // invisible on both sides
  compareInside(diff, id, aOp, bOp, sideA, sideB);
  return aOp.policy.audience === 'server';
}

/**
 * One operation's binding, input, output, errors and policy, both sides present.
 * @param {ContractDiff} diff
 * @param {string} id
 * @param {CompiledOperation} aOp
 * @param {CompiledOperation} bOp
 * @param {Side} sideA
 * @param {Side} sideB
 */
function compareInside(diff, id, aOp, bOp, sideA, sideB) {
  compareBinding(diff, aOp, bOp);
  compareInput(diff, aOp, bOp, sideA, sideB);
  const outSink = schemaSink(diff, id, opPath(id) + '/output', 'output');
  compareSchema(aOp.output.schema, bOp.output.schema, '', sideA, sideB, outSink, new Map());
  compareErrors(diff, aOp, bOp, sideA, sideB);
  comparePolicy(diff, aOp, bOp);
}
