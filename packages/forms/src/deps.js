//@ts-check

/**
 * What a rule reads: the data dependencies of an `x-form` rule query,
 * as JSON Pointer prefixes.
 *
 * The point is invalidation. `evaluateFormRules` re-runs every rule on
 * every keystroke; with a dependency set per rule it can re-run only
 * the rules a change can possibly have affected (rules.js, the memo).
 * A dependency set is therefore allowed to be too LARGE — a rule that
 * re-runs needlessly is slow, not wrong — and must never be too small.
 *
 * The analysis is deliberately shallow, and sound because of one
 * property of the query language: the only way into the input document
 * is a ROOT-ANCHORED path string (`$`, `$.x`, `$['x']`). Everything
 * else a query can read is derived from one of those — a `$let`/`$for`
 * variable holds the result of an expression in the same document, and
 * the only externals a form rule may bind are `value` (the field's own
 * value, which the rule depends on anyway) and `pointer` (a string).
 * So collecting the root-anchored paths, and reducing each to the
 * literal prefix it starts with, over-approximates every read.
 *
 * Reduction stops at the first segment that is not a plain name or
 * index: `$.a.b[*].c` reduces to `/a/b`, and a filter's own comparisons
 * are collected separately because a filter can name another part of
 * the document (`$.lines[?@.id == $.selected]`).
 *
 * RETAINED beside `analyzeQuery` (QUERY-FORMAT.md Appendix C),
 * deliberately: the published analysis reports which OPERATORS,
 * functions and externals a query uses — not the data-pointer prefixes
 * this invalidation needs — and this scanner is total over any JSON
 * value (a rule that does not even normalize still yields a sound
 * "depends on everything" answer) where analysis would throw. Deriving
 * prefixes from the analysis tree's `path` nodes would be exact, at the
 * price of a full normalization per rule per form build; take that
 * route only if the over-approximation ever measurably hurts.
 */

import { parseJSONPath } from '@jarenjs/json/path';
import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';

/**
 * The dependency set of a rule: pointer prefixes, or `ALL_POINTERS` for
 * "any change matters" (a query that reads the whole document).
 * @typedef {string[]} RuleDependencies
 */

/** A rule that reads the root depends on everything. */
export const ALL_POINTERS = [''];

/**
 * Collect the data dependencies of one rule query document.
 * @param {any} doc - The authored rule document
 * @returns {RuleDependencies} Pointer prefixes, deduplicated
 */
export function queryDependencies(doc) {
  /** @type {Set<string>} */
  const out = new Set();
  collectStrings(doc, out);
  if (out.has('')) return ALL_POINTERS;
  return [...out];
}

/**
 * Merge dependency sets, collapsing to {@link ALL_POINTERS} when any of
 * them reads the root and dropping prefixes another already covers.
 * @param {RuleDependencies[]} sets
 * @returns {RuleDependencies}
 */
export function mergeDependencies(sets) {
  /** @type {Set<string>} */
  const all = new Set();
  for (const set of sets) {
    for (const dep of set) {
      if (dep === '') return ALL_POINTERS;
      all.add(dep);
    }
  }
  const deps = [...all];
  return deps.filter((dep) => !deps.some((other) => other !== dep && isPointerPrefix(other, dep)));
}

/**
 * Whether a change at `changed` can affect a rule depending on `dep`.
 * True in BOTH nesting directions: a change inside a dependency
 * (`/a` vs `/a/b`) alters what the rule reads, and a change ABOVE one
 * (`/a/b` vs `/a`) can replace the container it reads through.
 * @param {string} dep @param {string} changed
 * @returns {boolean}
 */
export function dependencyTouched(dep, changed) {
  return isPointerPrefix(dep, changed) || isPointerPrefix(changed, dep);
}

/** Whether `prefix` is `pointer` itself or an ancestor location of it. */
function isPointerPrefix(prefix, pointer) {
  if (prefix === '') return true;
  if (!pointer.startsWith(prefix)) return false;
  return pointer.length === prefix.length || pointer.charCodeAt(prefix.length) === 0x2f;
}

/**
 * Walk a rule document for path strings. A bare string is a path
 * expression in this language, so every string is a candidate — except
 * under `$const`, which is exactly the marker that its value is a
 * literal.
 */
function collectStrings(node, out) {
  if (typeof node === 'string') {
    addPath(node, out);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    if (key === '$const') continue;
    collectStrings(node[key], out);
  }
}

/**
 * Reduce one path string to its dependency prefix, if it is a
 * root-anchored path at all. A variable-rooted path (`$item.price`) is
 * not RFC 9535 and never parses here — deliberately: whatever the
 * variable holds came from a root-anchored path in the same document,
 * which this walk has already seen.
 */
function addPath(source, out) {
  if (source.length === 0 || source.charCodeAt(0) !== 0x24) return; // not '$'
  let ast;
  try {
    ast = parseJSONPath(source);
  }
  catch {
    return; // a variable-rooted path, or not a path at all
  }
  out.add(prefixOf(ast.segments));
  for (const segment of ast.segments) {
    for (const selector of segment.selectors) {
      if (selector.kind === 'filter') collectFilterQueries(selector.expr, out);
    }
  }
}

/** The literal pointer prefix a segment list starts with. */
function prefixOf(segments) {
  let pointer = '';
  for (const segment of segments) {
    if (segment.descendant || segment.selectors.length !== 1) break;
    const selector = segment.selectors[0];
    if (selector.kind === 'name')
      pointer += `/${encodeJSONPointerSegment(selector.name)}`;
    else if (selector.kind === 'index' && selector.index >= 0)
      pointer += `/${selector.index}`;
    else break;
  }
  return pointer;
}

/**
 * Collect the root-anchored queries embedded in a filter expression —
 * `$.selected` in `$.lines[?@.id == $.selected]` is a dependency of the
 * enclosing rule as much as any top-level path is.
 */
function collectFilterQueries(node, out) {
  if (node === null || typeof node !== 'object') return;
  if (node.query !== undefined && Array.isArray(node.query.segments)) {
    if (node.query.relative !== true) out.add(prefixOf(node.query.segments));
    else collectFilterQueries(node.query, out);
  }
  for (const key of ['operands', 'operand', 'left', 'right', 'args', 'expr']) {
    const child = node[key];
    if (Array.isArray(child)) for (const item of child) collectFilterQueries(item, out);
    else if (child !== undefined) collectFilterQueries(child, out);
  }
}
