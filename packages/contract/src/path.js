//@ts-check
/**
 * @file The path matcher: RFC 6570 level-1 templates (`/api/products/{id}`)
 * compiled into one static-segment tree per HTTP method, walked by
 * char-code scan with zero allocation until the leaf is known.
 *
 * Package-private (docs/CONTRACT-FORMAT.md §5). Two stages:
 *
 *  1. `parsePathTemplate` — the one template parser in the suite: it
 *     canonicalizes `:name` to `{name}`, splits static from variable
 *     segments and refuses every reserved form with a message that names
 *     it. `compileContract` calls it once per operation and maps a
 *     refusal to `JC0008`.
 *  2. `compileRoutes` — the operation table becomes a tree of nodes
 *     `{ statics, variable, leaf }`; `match(method, path)` walks statics
 *     first, falls back to the variable child, and backtracks on a dead
 *     end. Static beats variable REGARDLESS of registration order — the
 *     ordering case a regex-per-route router refuses or gets wrong.
 *
 * Matching rules a binding relies on: exact on trailing slash (`/a/` is
 * a different shape from `/a` and, since no template has an empty
 * segment, never matches); a variable never binds an empty segment; each
 * segment is percent-decoded once, statics compared in decoded space, and
 * a decoded `/` never re-splits; a malformed escape makes `match` return
 * `null` (never throw — a request is hostile input). `?`/`#` never reach
 * `match`: the binding splits the query off first.
 *
 * Variable names live on the LEAF, not on the variable node: two
 * templates that differ only in a variable's name (`/a/{x}/b`,
 * `/a/{y}/c`) share the variable child and each leaf binds its own name.
 * The one shape that cannot be represented is two leaves for one method
 * and one shape — a duplicate the compiler has already refused as
 * `JC0010`, so here it is a `TypeError` (a host programming guard).
 */

import {
  CC_SLASH, CC_LBRACE, CC_RBRACE, CC_COLON, CC_STAR, CC_PERCENT,
  CC_QUESTION, CC_HASH, CC_UNDERSCORE, CC_PLUS, CC_DOT, CC_SEMICOLON,
  CC_AMP, CC_EQ, CC_DEL, CC_SPACE,
  isAsciiLetterCode, isDigitCode, isHexDigitCode,
} from '@jarenjs/core/scan';
import { setObjectMember } from '@jarenjs/core/object';

/**
 * One parsed template segment: a static literal or a variable name.
 * @typedef {{ variable: boolean, text: string }} PathSegment
 */

/**
 * The parsed form of a template.
 * @typedef {Object} ParsedPathTemplate
 * @property {string} path - The canonical template (`{name}` form).
 * @property {readonly PathSegment[]} segments - In order; empty for `/`.
 * @property {readonly string[]} variables - Variable names in order.
 */

/**
 * @param {number} c
 * @returns {boolean}
 */
function isIdentStartCode(c) {
  return isAsciiLetterCode(c) || c === CC_UNDERSCORE;
}

/**
 * @param {number} c
 * @returns {boolean}
 */
function isIdentCode(c) {
  return isAsciiLetterCode(c) || isDigitCode(c) || c === CC_UNDERSCORE;
}

/**
 * `[A-Za-z_][A-Za-z0-9_]*`, scanned without a regex.
 * @param {string} s
 * @returns {boolean}
 */
function isIdentifier(s) {
  if (s.length === 0 || !isIdentStartCode(s.charCodeAt(0))) return false;
  for (let i = 1; i < s.length; i++) {
    if (!isIdentCode(s.charCodeAt(i))) return false;
  }
  return true;
}

/**
 * The RFC 6570 operator characters a `{…}` expression may open with;
 * every one of them is a reserved form in this template dialect.
 * @param {number} c
 * @returns {boolean}
 */
function isUriTemplateOperator(c) {
  return c === CC_PLUS || c === CC_HASH || c === CC_DOT || c === CC_SLASH
    || c === CC_SEMICOLON || c === CC_QUESTION || c === CC_AMP || c === CC_EQ;
}

/**
 * Validate one static segment: any character except the structural ones
 * (`/ { } : * ? #`), whitespace and control characters; a `%` must open
 * a well-formed escape so the segment can be compared in decoded space.
 * Throws a `TypeError` naming the offending form.
 * @param {string} source
 * @param {number} pos
 * @param {number} end
 */
function checkStaticSegment(source, pos, end) {
  for (let i = pos; i < end; i++) {
    const c = source.charCodeAt(i);
    if (c === CC_LBRACE || c === CC_RBRACE) {
      throw new TypeError(`a variable must be a whole segment ("{name}"), found "${source.slice(pos, end)}"`);
    }
    if (c === CC_COLON) {
      throw new TypeError(`":" is reserved for a variable segment (":name"), found "${source.slice(pos, end)}"`);
    }
    if (c === CC_STAR) {
      throw new TypeError(`"*" is a reserved wildcard form; format 0.1 has no wildcards, found "${source.slice(pos, end)}"`);
    }
    if (c === CC_QUESTION || c === CC_HASH) {
      throw new TypeError(`"${String.fromCharCode(c)}" cannot appear in a path template (the query and fragment are not part of the path)`);
    }
    if (c <= CC_SPACE || c === CC_DEL) {
      throw new TypeError(`whitespace or a control character in segment "${source.slice(pos, end)}"`);
    }
    if (c === CC_PERCENT) {
      if (i + 2 >= end || !isHexDigitCode(source.charCodeAt(i + 1)) || !isHexDigitCode(source.charCodeAt(i + 2))) {
        throw new TypeError(`a malformed percent-escape in segment "${source.slice(pos, end)}"`);
      }
      i += 2;
    }
  }
}

/**
 * Parse a path template into segments, canonicalizing `:name` to
 * `{name}`. Throws a `TypeError` whose message names the rule that was
 * broken (the compiler wraps it as `JC0008`).
 *
 * The dialect: a leading `/`; the root template `/` has no segments;
 * every other segment is non-empty; a variable is a whole segment,
 * `{name}` or `:name`, with `name` an identifier, declared once per
 * template; the RFC 6570 operator and modifier forms (`{+name}`,
 * `{?name}`, `{name*}`, `{name:3}`, `{a,b}`), the `{name+}` tail and the
 * `*` wildcard are reserved and refused by name.
 * @param {unknown} source
 * @returns {ParsedPathTemplate}
 */
export function parsePathTemplate(source) {
  if (typeof source !== 'string') {
    throw new TypeError(`a path template must be a string, got ${typeof source}`);
  }
  const len = source.length;
  if (len === 0 || source.charCodeAt(0) !== CC_SLASH) {
    throw new TypeError('a path template must start with "/"');
  }
  /** @type {PathSegment[]} */
  const segments = [];
  /** @type {string[]} */
  const variables = [];
  if (len === 1) return { path: '/', segments, variables };
  let canonical = '';
  let pos = 1;
  for (;;) {
    let end = source.indexOf('/', pos);
    if (end === -1) end = len;
    if (end === pos) {
      throw new TypeError(pos === len
        ? 'a trailing "/" declares an empty segment; the root template "/" is the only empty path'
        : `an empty segment at offset ${pos} ("//")`);
    }
    const c0 = source.charCodeAt(pos);
    /** @type {string | null} */
    let name = null;
    if (c0 === CC_LBRACE) {
      if (source.charCodeAt(end - 1) !== CC_RBRACE) {
        throw new TypeError(`a variable must be a whole segment ("{name}"), found "${source.slice(pos, end)}"`);
      }
      name = source.slice(pos + 1, end - 1);
      const n0 = name.length === 0 ? -1 : name.charCodeAt(0);
      const nl = name.length === 0 ? -1 : name.charCodeAt(name.length - 1);
      if (isUriTemplateOperator(n0)) {
        throw new TypeError(`"{${name}}" uses the reserved RFC 6570 operator "${name[0]}"; format 0.1 supports only "{name}"`);
      }
      if (nl === CC_PLUS || nl === CC_STAR) {
        throw new TypeError(`"{${name}}" uses the reserved "${name[name.length - 1]}" expansion modifier; format 0.1 has no wildcards`);
      }
      if (name.indexOf(',') !== -1 || name.indexOf(':') !== -1) {
        throw new TypeError(`"{${name}}" uses a reserved RFC 6570 list or prefix form; format 0.1 supports only "{name}"`);
      }
    }
    else if (c0 === CC_COLON) {
      name = source.slice(pos + 1, end);
      if (name.length === 0 || name.indexOf('{') !== -1 || name.indexOf('}') !== -1) {
        throw new TypeError(`":name" must be a whole segment with an identifier name, found "${source.slice(pos, end)}"`);
      }
      const nl = name.charCodeAt(name.length - 1);
      if (nl === CC_STAR || nl === CC_PLUS || nl === CC_QUESTION) {
        throw new TypeError(`":${name}" uses a reserved "${name[name.length - 1]}" modifier; format 0.1 has no wildcards or optional segments`);
      }
    }
    if (name !== null) {
      if (!isIdentifier(name)) {
        throw new TypeError(`a variable name must match [A-Za-z_][A-Za-z0-9_]*, found "${name}"`);
      }
      if (variables.includes(name)) {
        throw new TypeError(`the variable "${name}" is declared twice`);
      }
      variables.push(name);
      segments.push({ variable: true, text: name });
      canonical += `/{${name}}`;
    }
    else {
      checkStaticSegment(source, pos, end);
      const text = source.slice(pos, end);
      segments.push({ variable: false, text });
      canonical += `/${text}`;
    }
    if (end === len) break;
    pos = end + 1;
  }
  return { path: canonical, segments, variables };
}

/**
 * The shape of a template with every variable normalized to `{}` — the
 * identity `JC0010` is decided on.
 * @param {ParsedPathTemplate} parsed
 * @returns {string}
 */
export function pathShape(parsed) {
  if (parsed.segments.length === 0) return '/';
  let out = '';
  for (let i = 0; i < parsed.segments.length; i++) {
    const s = parsed.segments[i];
    out += s.variable ? '/{}' : `/${s.text}`;
  }
  return out;
}

/**
 * A leaf: the registered key plus the variable names of the template
 * that reached it and the segment depth each one binds.
 * @typedef {{ key: any, names: readonly string[], depths: readonly number[] }} Leaf
 */

/**
 * One tree node.
 * @typedef {{ statics: Map<string, Node> | null, variable: Node | null, leaf: Leaf | null }} Node
 */

/** @returns {Node} */
function newNode() {
  return { statics: null, variable: null, leaf: null };
}

/**
 * Percent-decode one segment. Returns `null` for a malformed escape so
 * `match` can fail totally.
 * @param {string} raw
 * @returns {string | null}
 */
function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw);
  }
  catch {
    return null;
  }
}

/** The shared params object of a variable-free hit. */
const NO_PARAMS = Object.freeze({});

/**
 * A compiled router.
 * @typedef {Object} Router
 * @property {(method: string, path: string) => { key: any, params: Record<string, string> } | null} match
 */

/**
 * Compile a route table into a `Router`. `entries` are
 * `{ method, path, key }` with `path` in canonical `{name}` form (a
 * `:name` template is a `TypeError` here — canonicalize with
 * `parsePathTemplate` first). Two entries with one method and one shape
 * are a `TypeError` (the compiler's `JC0010` has already refused them);
 * templates that differ only in a variable name under a shared parent are
 * fine as long as they end in different leaves.
 * @param {readonly { method: string, path: string, key: any }[]} entries
 * @returns {Router}
 */
export function compileRoutes(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('compileRoutes expects an array of { method, path, key } entries');
  }
  /** @type {Map<string, Node>} */
  const trees = new Map();
  let maxDepth = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === null || typeof entry !== 'object'
      || typeof entry.method !== 'string' || typeof entry.path !== 'string') {
      throw new TypeError(`compileRoutes entry ${i} must be { method: string, path: string, key }`);
    }
    const parsed = parsePathTemplate(entry.path);
    if (parsed.path !== entry.path) {
      throw new TypeError(`compileRoutes accepts only canonical "{name}" templates; got "${entry.path}" (canonical "${parsed.path}")`);
    }
    let node = trees.get(entry.method);
    if (node === undefined) {
      node = newNode();
      trees.set(entry.method, node);
    }
    /** @type {string[]} */
    const names = [];
    /** @type {number[]} */
    const depths = [];
    for (let d = 0; d < parsed.segments.length; d++) {
      const seg = parsed.segments[d];
      if (seg.variable) {
        if (node.variable === null) node.variable = newNode();
        node = node.variable;
        names.push(seg.text);
        depths.push(d);
      }
      else {
        // statics compare in decoded space, so a template written with an
        // escape and a request carrying the same escape meet
        const decoded = decodeSegment(seg.text);
        if (decoded === null) {
          throw new TypeError(`compileRoutes: malformed escape in "${entry.path}"`);
        }
        if (node.statics === null) node.statics = new Map();
        let child = node.statics.get(decoded);
        if (child === undefined) {
          child = newNode();
          node.statics.set(decoded, child);
        }
        node = child;
      }
    }
    if (node.leaf !== null) {
      throw new TypeError(`compileRoutes: duplicate route shape ${entry.method} ${pathShape(parsed)}`);
    }
    node.leaf = { key: entry.key, names, depths };
    if (parsed.segments.length > maxDepth) maxDepth = parsed.segments.length;
  }

  // Segment bounds of the CURRENT descent, per depth: [start, end).
  // Written on the way down and read only at the leaf, so a failed
  // branch's deeper writes are simply overwritten by the branch that
  // succeeds. One array per router; `match` is synchronous and calls no
  // host code, so it is never re-entered.
  const bounds = new Int32Array(2 * (maxDepth + 1));

  /**
   * Bind a leaf's variables from the recorded bounds.
   * @param {Leaf} leaf
   * @param {string} path
   * @param {boolean} hasEscape
   * @returns {{ key: any, params: Record<string, string> } | null}
   */
  function hit(leaf, path, hasEscape) {
    const names = leaf.names;
    if (names.length === 0) return { key: leaf.key, params: NO_PARAMS };
    /** @type {Record<string, string>} */
    const params = {};
    const depths = leaf.depths;
    for (let i = 0; i < names.length; i++) {
      const d = depths[i];
      const raw = path.slice(bounds[2 * d], bounds[2 * d + 1]);
      let value = raw;
      if (hasEscape && raw.indexOf('%') !== -1) {
        const decoded = decodeSegment(raw);
        if (decoded === null) return null;
        value = decoded;
      }
      setObjectMember(params, names[i], value);
    }
    return { key: leaf.key, params };
  }

  /**
   * Consume the segment starting at `pos` against `node`; statics first,
   * then the variable child, backtracking on a dead end. Returns the
   * leaf reached or `null`.
   * @param {Node} node
   * @param {string} path
   * @param {number} pos
   * @param {number} depth
   * @param {boolean} hasEscape
   * @returns {Leaf | null | false} `false` marks a malformed escape
   */
  function walk(node, path, pos, depth, hasEscape) {
    if (depth === maxDepth) return null; // deeper than any template
    const len = path.length;
    let end = path.indexOf('/', pos);
    if (end === -1) end = len;
    if (end === pos) return null; // empty segment: `//` or a trailing `/`
    bounds[2 * depth] = pos;
    bounds[2 * depth + 1] = end;
    const last = end === len;
    if (node.statics !== null) {
      let seg = path.slice(pos, end);
      if (hasEscape && seg.indexOf('%') !== -1) {
        const decoded = decodeSegment(seg);
        if (decoded === null) return false;
        seg = decoded;
      }
      const child = node.statics.get(seg);
      if (child !== undefined) {
        if (last) {
          if (child.leaf !== null) return child.leaf;
        }
        else {
          const found = walk(child, path, end + 1, depth + 1, hasEscape);
          if (found !== null) return found;
        }
      }
    }
    const variable = node.variable;
    if (variable !== null) {
      if (last) return variable.leaf;
      return walk(variable, path, end + 1, depth + 1, hasEscape);
    }
    return null;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @returns {{ key: any, params: Record<string, string> } | null}
   */
  function match(method, path) {
    if (typeof method !== 'string' || typeof path !== 'string') return null;
    const root = trees.get(method);
    if (root === undefined) return null;
    if (path.charCodeAt(0) !== CC_SLASH) return null;
    const hasEscape = path.indexOf('%') !== -1;
    if (path.length === 1) {
      return root.leaf === null ? null : hit(root.leaf, path, hasEscape);
    }
    const leaf = walk(root, path, 1, 0, hasEscape);
    if (leaf === null || leaf === false) return null;
    return hit(leaf, path, hasEscape);
  }

  return Object.freeze({ match });
}
