//@ts-check
/**
 * @file Same-document schema reachability and bundling — the one place in
 * the suite that answers "which `$defs` does this schema need?" and
 * "make this schema stand alone". The public projection keeps exactly
 * the reachable `$defs` of the retained operations (05 hashes that); a
 * tool definition carries its input schema with the reachable `$defs`
 * inlined under the schema's own `$defs`, because a tool schema must be
 * self-contained.
 *
 * Reachability follows same-document `$ref`s (`#`, `#/…` pointers,
 * `#anchor`) with the resolver `compileContract` itself uses
 * (`@jarenjs/validate/normalize`), so a reference the compiler accepted
 * resolves here by the same rules. A target is attributed to the `$defs`
 * entry that CONTAINS it — `#/$defs/Product/properties/id` needs
 * `Product` — and the entry is walked in turn. References that do not
 * land inside `$defs` (`#`, a pointer into another operation's schema,
 * an absolute `$id`) are left as written: the document states where
 * shared schemas live, and that is `$defs`.
 */

import { isJsonObject, setObjectMember } from '@jarenjs/core/object';
import { collectSameDocumentAnchors, resolveSameDocumentRef } from '@jarenjs/validate/normalize';
import { parseJSONPointer } from '@jarenjs/json/pointer';

/** JSON-value keywords whose content is data, not schema — not walked for `$ref`. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);

/**
 * The containment map of a document's `$defs`: every object or array node
 * inside a `$defs` entry → the entry's name (the entry's own node
 * included). First entry wins for a node shared by two entries (a
 * snapshot never shares, but a hand-built document may).
 * @param {any} defs
 * @returns {Map<object, string>}
 */
function containment(defs) {
  /** @type {Map<object, string>} */
  const owner = new Map();
  if (!isJsonObject(defs)) return owner;
  const names = Object.keys(defs);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    /** @param {any} node */
    const mark = (node) => {
      if (node === null || typeof node !== 'object' || owner.has(node)) return;
      owner.set(node, name);
      if (Array.isArray(node)) {
        for (let j = 0; j < node.length; j++) mark(node[j]);
        return;
      }
      const keys = Object.keys(node);
      for (let j = 0; j < keys.length; j++) mark(node[keys[j]]);
    };
    mark(defs[name]);
  }
  return owner;
}

/**
 * The `$defs` entry a same-document reference lands in, or `undefined`
 * when it lands elsewhere (the root, an operation, nowhere). A pointer
 * under `#/$defs/` names its entry directly (so a boolean entry, which
 * has no identity to look up, is found too); anything else — an anchor,
 * a pointer that reaches a `$defs` node by another route — is attributed
 * by containment.
 * @param {string} ref
 * @param {Record<string, any>} defs
 * @param {Map<object, string>} owner
 * @param {any} doc
 * @param {Map<string, object>} anchors
 * @returns {string | undefined}
 */
function defOf(ref, defs, owner, doc, anchors) {
  if (ref.startsWith('#/$defs/')) {
    let tokens;
    try {
      tokens = parseJSONPointer(ref.slice(1));
    }
    catch {
      return undefined;
    }
    const name = String(tokens[1]);
    if (Object.hasOwn(defs, name) && resolveSameDocumentRef(ref, doc, anchors) !== undefined) return name;
    return undefined;
  }
  const target = resolveSameDocumentRef(ref, doc, anchors);
  return target !== null && typeof target === 'object' ? owner.get(target) : undefined;
}

/**
 * The names of the document's `$defs` reachable from `roots` by
 * same-document `$ref`, transitively, in first-reference order: the
 * roots are walked in the order given, depth-first in member order, and
 * a `$defs` entry is walked at the moment it is first reached. Data
 * keywords (`const`, `enum`, `default`, `examples`) are not walked.
 * @param {readonly unknown[]} roots - schemas (objects or booleans) rooted in `doc`
 * @param {any} doc - the document holding `$defs` (a contract document, or any schema root)
 * @returns {string[]}
 */
export function reachableDefs(roots, doc) {
  const defs = isJsonObject(doc) && isJsonObject(doc.$defs) ? doc.$defs : null;
  if (defs === null) return [];
  const owner = containment(defs);
  const anchors = collectSameDocumentAnchors(doc);
  /** @type {string[]} */
  const names = [];
  const seenNames = new Set();
  /** @type {Set<object>} */
  const visited = new Set();
  /** @param {any} node */
  const walk = (node) => {
    if (node === null || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i]);
      return;
    }
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#')) {
      const name = defOf(node.$ref, defs, owner, doc, anchors);
      if (name !== undefined) {
        if (!seenNames.has(name)) {
          seenNames.add(name);
          names.push(name);
        }
        walk(defs[name]);
      }
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      if (DATA_KEYWORDS.has(keys[i])) continue;
      walk(node[keys[i]]);
    }
  };
  for (let i = 0; i < roots.length; i++) walk(roots[i]);
  return names;
}

/**
 * Make a schema stand alone: the schema with the `$defs` it reaches
 * (transitively, first-reference order) copied under its own `$defs`, so
 * every `#/$defs/X` it carries resolves inside the returned document. A
 * boolean schema is returned as is; a schema that reaches nothing gains no
 * `$defs`. A schema that declared its own `$defs` member loses it — at the
 * new root that member would shadow the document's, and its entries were
 * only addressable by a pointer through the operation anyway.
 * @param {any} schema - a schema rooted in `doc`
 * @param {any} doc - the document holding `$defs`
 * @returns {any} a fresh top-level object sharing the schema's subtrees
 */
export function bundleSameDocument(schema, doc) {
  if (!isJsonObject(schema)) return schema;
  const names = reachableDefs([schema], doc);
  /** @type {Record<string, any>} */
  const out = {};
  const keys = Object.keys(schema);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === '$defs') continue;
    setObjectMember(out, keys[i], schema[keys[i]]);
  }
  if (names.length > 0) {
    /** @type {Record<string, any>} */
    const defs = {};
    for (let i = 0; i < names.length; i++) setObjectMember(defs, names[i], doc.$defs[names[i]]);
    out.$defs = defs;
  }
  return out;
}
