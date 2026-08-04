//@ts-check
/**
 * @file Optional type annotation over the published normalized form
 * (QUERY-FORMAT.md Appendix C.8). The AST carries cardinality but no
 * value types; a consumer that owns a type source — a store's JSON
 * Schema, a model document — supplies `typeOf(pathNode)` and gets back
 * a NEW frozen tree mirroring the input with a `type` tag on every
 * node. The pass never mutates its input and never runs during
 * compilation.
 *
 * The lattice is small and closed: `unknown` is the top and always a
 * safe answer; a wrong tag is a defect. Operators propagate through the
 * registry's declared `resultType` families (comparison, arithmetic,
 * string, aggregate); everything undeclared yields `unknown` rather
 * than a guess.
 */

import { OPERATORS } from './operators.js';
import { CARD_ONE } from './normalize.js';

/** The closed set of type-tag names, sorted. */
export const TYPE_TAGS = Object.freeze([
  'array', 'boolean', 'integer', 'null', 'number', 'object', 'string', 'unknown',
]);

// Interned tag objects: one frozen { type, optional } per combination,
// so annotated trees share tags by identity and comparisons are cheap.
const TAGS = (() => {
  /** @type {Record<string, Readonly<{type: string, optional: boolean}>>} */
  const table = {};
  for (const type of TYPE_TAGS) {
    table[`${type}:0`] = Object.freeze({ type, optional: false });
    table[`${type}:1`] = Object.freeze({ type, optional: true });
  }
  return Object.freeze(table);
})();

/**
 * The interned tag for a type name and optionality.
 * @param {string} type - one of {@link TYPE_TAGS}
 * @param {boolean} optional
 */
function tagOf(type, optional) {
  return TAGS[`${type}:${optional ? 1 : 0}`];
}

/**
 * Join two tag names: equal names join to themselves, `integer` widens
 * into `number`, anything else joins to `unknown` (the top).
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function joinTagName(a, b) {
  if (a === b) return a;
  if ((a === 'integer' && b === 'number') || (a === 'number' && b === 'integer'))
    return 'number';
  return 'unknown';
}

/** The tag name of a literal JSON value. @param {any} value */
function literalTagName(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return 'boolean';
    case 'number': return Number.isInteger(value) ? 'integer' : 'number';
    case 'string': return 'string';
    default: return Array.isArray(value) ? 'array' : 'object';
  }
}

/**
 * Normalize whatever the caller's `typeOf` returned into an interned
 * tag: a bare tag name (optionality derived from the node's own
 * cardinality), a `{ type, optional }` object, or `null`/`undefined`
 * for "unknown". Anything outside the lattice is `unknown` — a safe
 * answer, never a throw, because a sloppy hook must not fail analysis.
 * @param {any} answer
 * @param {any} node
 */
function normalizeHookAnswer(answer, node) {
  const fallback = node.card !== CARD_ONE;
  if (answer == null) return tagOf('unknown', fallback);
  if (typeof answer === 'string')
    return TYPE_TAGS.includes(answer) ? tagOf(answer, fallback) : tagOf('unknown', fallback);
  const type = TYPE_TAGS.includes(answer.type) ? answer.type : 'unknown';
  return tagOf(type, answer.optional === true);
}

/**
 * Annotate a normalized analysis with type tags (Appendix C.8): a NEW
 * frozen analysis whose tree mirrors the input with `type` on every
 * node. The input analysis and its tree are never mutated.
 * @param {{ astVersion: number, root: any }} analysis - an
 *   `analyzeQuery` result (or any record carrying the frozen `root`)
 * @param {{ typeOf?: (pathNode: any) => any }} [hooks] - `typeOf`
 *   answers for `path` nodes: a tag name, a `{ type, optional }`
 *   object, or `null` for unknown
 * @returns {any} the annotated analysis
 */
export function annotateTypes(analysis, hooks = {}) {
  const typeOf = typeof hooks.typeOf === 'function' ? hooks.typeOf : null;

  /** @param {any} node @returns {any} */
  function annotate(node) {
    switch (node.kind) {
      case 'literal':
        return Object.freeze({ ...node, type: tagOf(literalTagName(node.value), false) });
      case 'var':
        return Object.freeze({ ...node, type: tagOf('unknown', node.card !== CARD_ONE) });
      case 'path': {
        const answer = typeOf === null ? null : typeOf(node);
        return Object.freeze({ ...node, type: normalizeHookAnswer(answer, node) });
      }
      case 'object':
        return Object.freeze({
          ...node,
          entries: Object.freeze(node.entries.map(
            (e) => Object.freeze({ ...e, expr: annotate(e.expr) }))),
          type: tagOf('object', false),
        });
      case 'map':
        return Object.freeze({
          ...node,
          pairs: Object.freeze(node.pairs.map(
            (p) => Object.freeze({ ...p, key: annotate(p.key), value: annotate(p.value) }))),
          type: tagOf('object', false),
        });
      case 'array':
        return Object.freeze({
          ...node,
          elements: Object.freeze(node.elements.map(annotate)),
          type: tagOf('array', false),
        });
      case 'raw':
        return Object.freeze({ ...node, type: tagOf('unknown', false) });
      case 'op': {
        const args = Object.freeze(node.args.map(annotate));
        const entry = OPERATORS[node.name];
        const resultType = entry !== undefined && typeof entry.resultType === 'function'
          ? entry.resultType(args.map((a) => a.type))
          : null;
        const name = typeof resultType === 'string' && TYPE_TAGS.includes(resultType)
          ? resultType
          : 'unknown';
        return Object.freeze({ ...node, args, type: tagOf(name, node.card !== CARD_ONE) });
      }
      case 'call':
        return Object.freeze({
          ...node,
          args: Object.freeze(node.args.map(annotate)),
          type: tagOf('unknown', true),
        });
      case 'let': {
        const bindings = Object.freeze(node.bindings.map(
          (b) => Object.freeze({ ...b, expr: annotate(b.expr) })));
        const ret = annotate(node.ret);
        return Object.freeze({
          ...node, bindings, ret,
          type: tagOf(ret.type.type, node.card !== CARD_ONE),
        });
      }
      case 'quant':
        return Object.freeze({
          ...node,
          bindings: Object.freeze(node.bindings.map(
            (b) => Object.freeze({ ...b, expr: annotate(b.expr) }))),
          satisfies: annotate(node.satisfies),
          type: tagOf('boolean', false),
        });
      default: { // 'flwor'
        const fold = node.fold === null
          ? null
          : Object.freeze({ ...node.fold, expr: annotate(node.fold.expr) });
        const forBindings = Object.freeze(node.forBindings.map(
          (b) => Object.freeze({ ...b, expr: annotate(b.expr) })));
        const letBindings = Object.freeze(node.letBindings.map(
          (b) => Object.freeze({ ...b, expr: annotate(b.expr) })));
        const where = node.where === null ? null : annotate(node.where);
        const groupby = node.groupby === null
          ? null
          : Object.freeze({
            ...node.groupby,
            keys: Object.freeze(node.groupby.keys.map(
              (k) => Object.freeze({ ...k, expr: annotate(k.expr) }))),
          });
        const orderby = node.orderby === null
          ? null
          : Object.freeze({
            ...node.orderby,
            specs: Object.freeze(node.orderby.specs.map(
              (s) => Object.freeze({ ...s, key: annotate(s.key) }))),
          });
        const ret = annotate(node.ret);
        // the phrase's ITEM type: the $return item's tag (joined with the
        // accumulator's for $fold — either can be the final value)
        const itemTag = fold === null
          ? ret.type.type
          : joinTagName(fold.expr.type.type, ret.type.type);
        return Object.freeze({
          ...node, fold, forBindings, letBindings, where, groupby, orderby, ret,
          type: tagOf(itemTag, node.card !== CARD_ONE),
        });
      }
    }
  }

  return Object.freeze({ ...analysis, root: annotate(analysis.root) });
}
