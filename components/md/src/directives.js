//@ts-check
/**
 * @file Directives: comment-carried data that a machine derives and a
 * human reads.
 *
 * ```markdown
 * Jaren is <!--fact:jsonpath.ctsRatio-->23.1<!--/fact-->x faster on the CTS mean.
 * ```
 *
 * Every markdown renderer on earth drops HTML comments, so GitHub, an
 * editor preview and npm all show `Jaren is 23.1x faster` — plain,
 * correct, static text with no runtime and no template syntax leaking
 * into the prose. A directive-aware consumer reads the marker instead
 * and can re-derive the value; `bake` writes the fresh value back into
 * the source, so a re-derivation is a reviewable diff rather than a
 * silent drift.
 *
 * That is the gap this closes for mdx, whose `{$.path}` spelling renders
 * as literal gibberish anywhere the transform has not run — usable only
 * in documents nobody reads raw.
 *
 * **The layer never interprets the payload.** `fact` puts a derivation
 * key there, `mdx` puts a query expression; the vocabulary belongs to the
 * consumer, and this module owns exactly one thing — the marker grammar
 * and the pairing — so two consumers cannot disagree about what a
 * directive is. The namespace is the consumer's too, and one consumer
 * SHOULD claim one: pairing and the orphan report are per-namespace, so a
 * repository that spells the same idea two ways has two blind spots.
 *
 * There are two ways in, because there are two questions:
 *
 *  - `scanDirectives(doc)` / `replaceDirectives(doc, …)` work on the
 *    AST, which is what a *rendering* consumer has;
 *  - `scanSourceDirectives(text)` works on the source, which is what a
 *    *rewriting* consumer needs. The AST carries no source offsets (it
 *    is plain JSON built for structural sharing, MD-FORMAT §1.1/§6), and
 *    giving it any would change every node's shape and therefore every
 *    content-hash key — so `bake` splices bytes instead, and both
 *    scanners read the same grammar from the same function.
 */

/**
 * @typedef {import('./ast.js').MdNode} MdNode
 */
/**
 * One paired directive found in an AST.
 * @typedef {{ ns: string, key: string, scope: 'block'|'inline',
 *   path: number[], open: number, close: number, nodes: MdNode[] }} AstDirective
 */
/**
 * One paired directive found in source text. `start`/`end` span the
 * whole thing, markers included; `bodyStart`/`bodyEnd` span what a
 * resolver replaces.
 * @typedef {{ ns: string, key: string, scope: 'block'|'inline',
 *   start: number, end: number, bodyStart: number, bodyEnd: number,
 *   body: string }} SourceDirective
 */

/** `<!--ns:payload-->` or `<!--/ns-->`, and nothing else. */
const RE_OPEN = /^<!--([a-z][a-z0-9-]*):((?:(?!-->)[\s\S])*)-->$/;
const RE_CLOSE = /^<!--\/([a-z][a-z0-9-]*)-->$/;
/** Every comment in a source text, for the byte-level scanner. */
const RE_COMMENT = /<!--[\s\S]*?-->/g;
/** A fenced-code opener/closer, so the source scanner can skip fences. */
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Classify one comment. The single source of truth for what a directive
 * marker IS — both scanners and every consumer go through here.
 * @param {string} text the comment, `<!--` and `-->` included
 * @returns {{ ns: string, key: string, closing: boolean } | null}
 */
export function parseMarker(text) {
  const close = RE_CLOSE.exec(text);
  if (close !== null) return { ns: close[1], key: '', closing: true };
  const open = RE_OPEN.exec(text);
  // a closer is `<!--/ns-->`, so an opener whose payload starts with `/`
  // would be ambiguous; the closer pattern already claimed those
  if (open === null) return null;
  return { ns: open[1], key: open[2].trim(), closing: false };
}

/**
 * Pair a flat run of markers, in document order, into directives.
 *
 * Unpaired markers are REPORTED, never dropped: a stale figure hiding
 * behind a marker nobody matched is the exact failure this whole layer
 * exists to prevent. Same-`ns` nesting is rejected for the same reason —
 * a directive whose body contains another of its own kind has no single
 * answer to "what does the resolver replace?".
 *
 * @param {{ ns: string, key: string, closing: boolean, at: number }[]} markers
 * @param {string|null} ns only this namespace, or null for all
 * @returns {{ pairs: { ns: string, key: string, open: number, close: number }[],
 *   diagnostics: string[] }}
 */
function pairMarkers(markers, ns) {
  const pairs = [];
  /** @type {string[]} */
  const diagnostics = [];
  /** @type {{ ns: string, key: string, at: number } | null} */
  let open = null;
  for (const marker of markers) {
    if (ns !== null && marker.ns !== ns) continue;
    if (marker.closing) {
      if (open === null) {
        diagnostics.push(`stray <!--/${marker.ns}--> with no opener`);
        continue;
      }
      pairs.push({ ns: open.ns, key: open.key, open: open.at, close: marker.at });
      open = null;
      continue;
    }
    if (open !== null) {
      diagnostics.push(`<!--${marker.ns}:${marker.key}--> opens inside <!--${open.ns}:${open.key}-->`
        + ' — directives of one namespace do not nest');
      continue;
    }
    open = { ns: marker.ns, key: marker.key, at: marker.at };
  }
  if (open !== null) {
    diagnostics.push(`<!--${open.ns}:${open.key}--> is never closed`);
  }
  return { pairs, diagnostics };
}

/**
 * Find every directive in a parsed document.
 *
 * A block directive's markers are `html` block nodes with body blocks
 * between them; an inline directive's are `html` inline nodes inside one
 * paragraph. Markers are paired within ONE container — an opener in a
 * blockquote and a closer outside it are two unpaired markers, not one
 * directive spanning a boundary that does not exist in the tree.
 *
 * @param {any} docOrAst an MdDocument, a CompiledMd or an AST array
 * @param {{ ns?: string }} [options] restrict to one namespace
 * @returns {{ directives: AstDirective[], diagnostics: string[] }}
 */
export function scanDirectives(docOrAst, options = {}) {
  const ast = Array.isArray(docOrAst) ? docOrAst : (docOrAst?.ast ?? []);
  const ns = typeof options.ns === 'string' ? options.ns : null;
  /** @type {AstDirective[]} */
  const directives = [];
  /** @type {string[]} */
  const diagnostics = [];
  scanLevel(ast, [], 'block', ns, directives, diagnostics);
  // Document order. The walk pairs a container's own markers only after
  // recursing into its children, so without this an inline directive
  // inside a later paragraph would come back before the block directive
  // that precedes it — and `bake` matches this list against the source
  // scan position by position.
  directives.sort((a, b) => comparePosition(a.path.concat(a.open), b.path.concat(b.open)));
  return { directives, diagnostics };
}

/** Lexicographic comparison of two index paths. */
function comparePosition(a, b) {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Node types whose `children` are INLINE content — the boundary between
 * the two scopes. Everything else that carries children is a block
 * container.
 */
const INLINE_CHILDREN = new Set(['paragraph', 'heading', 'tableCell']);

/**
 * Pair the markers of ONE children array, then recurse.
 *
 * Markers pair within the array they share, and only there: an opener
 * inside `**bold**` and a closer outside it are two unpaired markers,
 * not one directive spanning a boundary the tree does not have. That is
 * also why this is one function and not one per scope — the markers of
 * a bolded span sit in the `strong` node's children, and a walker that
 * only looked at a paragraph's DIRECT children missed every directive
 * written inside emphasis.
 *
 * @param {MdNode[]} nodes @param {number[]} path
 * @param {'block'|'inline'} scope @param {string|null} ns
 * @param {AstDirective[]} directives @param {string[]} diagnostics
 */
function scanLevel(nodes, path, scope, ns, directives, diagnostics) {
  const markers = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === 'html') {
      const marker = parseMarker(node.value);
      if (marker !== null) markers.push({ ...marker, at: i });
      continue;
    }
    if (!Array.isArray(node.children)) continue;
    const inner = scope === 'inline' || INLINE_CHILDREN.has(node.type) ? 'inline' : 'block';
    scanLevel(node.children, path.concat(i), inner, ns, directives, diagnostics);
  }
  if (markers.length === 0) return;
  const { pairs, diagnostics: found } = pairMarkers(markers, ns);
  for (const pair of pairs) {
    directives.push({
      ns: pair.ns,
      key: pair.key,
      scope,
      path,
      open: pair.open,
      close: pair.close,
      nodes: nodes.slice(pair.open + 1, pair.close),
    });
  }
  for (const message of found) diagnostics.push(message);
}

/**
 * Replace every directive body, returning a NEW document.
 *
 * The transform is pure and preserves reference equality for everything
 * it does not touch, so the vnode emitter's per-node memo and the view
 * patcher's `===` fast path are unaffected — the same contract the mdx
 * pass keeps (MD-FORMAT §6).
 *
 * `replace` returns the nodes to put between the markers. Returning
 * `undefined` leaves the directive alone.
 *
 * @param {any} docOrAst
 * @param {{ ns?: string }} options
 * @param {(directive: AstDirective) => (MdNode[]|undefined)} replace
 * @returns {any} the same shape that came in (document or array)
 */
export function replaceDirectives(docOrAst, options, replace) {
  const isArray = Array.isArray(docOrAst);
  const ast = isArray ? docOrAst : (docOrAst?.ast ?? []);
  const { directives } = scanDirectives(ast, options);
  if (directives.length === 0) return docOrAst;
  // deepest paths first, so an inner replacement's indices are still
  // valid when its container is rebuilt around it
  const byPath = new Map();
  for (const directive of directives) {
    const key = directive.path.join('.');
    const bucket = byPath.get(key);
    if (bucket === undefined) byPath.set(key, [directive]);
    else bucket.push(directive);
  }
  const next = rewriteContainer(ast, [], byPath, replace);
  if (next === ast) return docOrAst;
  return isArray ? next : { ...docOrAst, ast: next };
}

/**
 * @param {MdNode[]} nodes @param {number[]} path
 * @param {Map<string, AstDirective[]>} byPath
 * @param {(directive: AstDirective) => (MdNode[]|undefined)} replace
 * @returns {MdNode[]}
 */
function rewriteContainer(nodes, path, byPath, replace) {
  /** @type {MdNode[] | null} */
  let out = null;
  // children first: a rewritten child must land in the array this level
  // then splices, not in the one it replaced
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!Array.isArray(node.children)) continue;
    const childPath = path.concat(i);
    const rewritten = node.type === 'paragraph'
      ? spliceLevel(node.children, childPath, byPath, replace)
      : rewriteContainer(node.children, childPath, byPath, replace);
    if (rewritten === node.children) continue;
    if (out === null) out = nodes.slice();
    out[i] = { ...node, children: rewritten };
  }
  return spliceLevel(out ?? nodes, path, byPath, replace, out !== null);
}

/**
 * Apply this level's own directives, right to left so earlier indices
 * stay valid.
 * @param {MdNode[]} nodes @param {number[]} path
 * @param {Map<string, AstDirective[]>} byPath
 * @param {(directive: AstDirective) => (MdNode[]|undefined)} replace
 * @param {boolean} [owned] `nodes` is already a fresh array
 * @returns {MdNode[]}
 */
function spliceLevel(nodes, path, byPath, replace, owned = false) {
  const here = byPath.get(path.join('.'));
  if (here === undefined) return nodes;
  let out = owned ? nodes : null;
  for (let d = here.length - 1; d >= 0; d--) {
    const directive = here[d];
    const body = replace(directive);
    if (body === undefined) continue;
    if (out === null) out = nodes.slice();
    out.splice(directive.open + 1, directive.close - directive.open - 1, ...body);
  }
  return out ?? nodes;
}

/**
 * Find every directive in SOURCE TEXT, with the offsets a rewriter
 * needs.
 *
 * Comments inside fenced code are skipped: a fence showing a directive
 * as an EXAMPLE is documentation about the layer, not an instance of it,
 * and rewriting one would corrupt the very docs that explain it.
 * (Indented code is not skipped — see the package README's note; the
 * cross-check in `bake` is what catches the difference.)
 *
 * @param {string} source
 * @param {{ ns?: string }} [options]
 * @returns {{ directives: SourceDirective[], diagnostics: string[] }}
 */
export function scanSourceDirectives(source, options = {}) {
  const ns = typeof options.ns === 'string' ? options.ns : null;
  const fenced = fencedRanges(source);
  const markers = [];
  RE_COMMENT.lastIndex = 0;
  let match;
  while ((match = RE_COMMENT.exec(source)) !== null) {
    if (inRanges(fenced, match.index)) continue;
    const marker = parseMarker(match[0]);
    if (marker === null) continue;
    markers.push({ ...marker, at: match.index, end: match.index + match[0].length });
  }
  const { pairs, diagnostics } = pairMarkers(markers, ns);
  /** @type {SourceDirective[]} */
  const directives = pairs.map((pair) => {
    const open = markers.find((m) => m.at === pair.open);
    const close = markers.find((m) => m.at === pair.close);
    const bodyStart = /** @type {any} */ (open).end;
    const bodyEnd = /** @type {any} */ (close).at;
    const body = source.slice(bodyStart, bodyEnd);
    return {
      ns: pair.ns,
      key: pair.key,
      scope: body.indexOf('\n') === -1 ? 'inline' : 'block',
      start: pair.open,
      end: /** @type {any} */ (close).end,
      bodyStart,
      bodyEnd,
      body,
    };
  });
  return { directives, diagnostics };
}

/** The `[start, end)` ranges of fenced code blocks in a source text. */
function fencedRanges(source) {
  const ranges = [];
  let offset = 0;
  let open = null;
  for (const line of source.split('\n')) {
    const fence = RE_FENCE.exec(line);
    if (fence !== null) {
      if (open === null) open = { marker: fence[1][0], length: fence[1].length, at: offset };
      else if (fence[1][0] === open.marker && fence[1].length >= open.length) {
        ranges.push([open.at, offset + line.length]);
        open = null;
      }
    }
    offset += line.length + 1;
  }
  if (open !== null) ranges.push([open.at, source.length]);
  return ranges;
}

/** @param {number[][]} ranges @param {number} at */
function inRanges(ranges, at) {
  for (const [start, end] of ranges) {
    if (at >= start && at < end) return true;
  }
  return false;
}
