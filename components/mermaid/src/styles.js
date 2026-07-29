//@ts-check
/**
 * @file `classDef` / `class` / `style` resolution.
 *
 * The parser has always recorded these three statements; nothing consumed
 * them, so a diagram that styled a node rendered identically to one that did
 * not. This module turns them into per-node style objects the layout attaches
 * to its positioned nodes, which is what lets a diagram carry emphasis —
 * "this box is the input", "this one is an aside" — instead of every node
 * looking the same.
 *
 * One built-in class ships: **`note`**. Mermaid has no flowchart note, and a
 * diagram that cannot annotate a node loses exactly the information an ASCII
 * drawing used to carry in a margin comment. Rather than invent syntax for
 * it, `note` is a class any diagram can apply with the standard `class`
 * statement, themed from the `note*` tokens the sequence renderer already
 * uses. A dotted link to a note-classed node reads as an annotation and stays
 * valid Mermaid that other tools can still parse.
 */

/** Style properties that mean something to a shape, mapped to SVG attributes. */
const SHAPE_PROPS = {
  'fill': 'fill',
  'stroke': 'stroke',
  'stroke-width': 'stroke-width',
  'stroke-dasharray': 'stroke-dasharray',
  'opacity': 'opacity',
};

/**
 * Parse a Mermaid style string (`fill:#eee,stroke-width:2px`) into an object.
 * Unknown properties are kept: a consumer may understand more than this one,
 * and silently dropping a declaration the author wrote is the same class of
 * dishonesty as dropping a schema constraint.
 * @param {string} source
 * @returns {Record<string,string>}
 */
export function parseStyleString(source) {
  /** @type {Record<string,string>} */
  const out = {};
  if (typeof source !== 'string') return out;
  for (const part of source.split(',')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (key !== '' && value !== '') out[key] = value;
  }
  return out;
}

/**
 * Resolve every node's styles from a flowchart AST.
 *
 * Precedence, lowest to highest: the built-in `note` class, then each
 * `classDef` in the order the node's `class` statements applied them, then a
 * per-node `style` statement. That is Mermaid's own order — later wins — and
 * it is what lets a diagram say "these are all notes, except this one is
 * red".
 * @param {any} ast flowchart AST
 * @returns {Map<string, Record<string,string>>} node id -> style properties
 */
export function resolveNodeStyles(ast) {
  /** @type {Map<string, Record<string,string>>} */
  const out = new Map();
  if (ast === null || typeof ast !== 'object') return out;

  /** @type {Map<string, Record<string,string>>} */
  const defs = new Map();
  for (const def of ast.classDefs ?? []) {
    if (def === null || typeof def.name !== 'string') continue;
    // A classDef may name several classes at once (`classDef a,b fill:#eee`).
    for (const name of def.name.split(',')) {
      const key = name.trim();
      if (key === '') continue;
      defs.set(key, { ...(defs.get(key) ?? {}), ...parseStyleString(def.styles) });
    }
  }

  const add = (id, props) => {
    if (typeof id !== 'string' || id === '') return;
    out.set(id, { ...(out.get(id) ?? {}), ...props });
  };

  for (const applied of ast.classes ?? []) {
    if (applied === null) continue;
    // `class a,b name` applies one class to several nodes.
    const nodes = String(applied.node ?? '').split(',');
    for (const rawName of String(applied.name ?? '').split(',')) {
      const name = rawName.trim();
      if (name === '') continue;
      // The built-in class carries no properties of its own: it is a marker
      // the renderer resolves against the theme, because a note's colors have
      // to follow light/dark like every other themed element.
      const props = name === 'note' ? { 'mm-builtin': 'note' } : defs.get(name);
      if (props === undefined) continue;
      for (const node of nodes) add(node.trim(), props);
    }
  }

  for (const style of ast.styles ?? []) {
    if (style === null) continue;
    for (const node of String(style.node ?? '').split(','))
      add(node.trim(), parseStyleString(style.styles));
  }

  return out;
}

/**
 * The author's styles as an inline CSS declaration, or `null` when there are
 * none.
 *
 * This has to be a `style` attribute rather than presentation attributes:
 * the bundled stylesheet sets `.mermaid .mm-node-shape { fill: var(...) }` so
 * a themed page can retheme every diagram at once, and a CSS rule outranks a
 * presentation attribute. Emitting `fill="..."` therefore looked correct in
 * the SSR string and was silently overridden the moment the stylesheet
 * loaded — a classDef that worked in a test and did nothing on the page.
 * Inline style outranks the rule, which is the precedence an author asking
 * for a specific colour expects.
 * @param {Record<string,string>|undefined} styles
 * @param {Record<string,string>} tokens theme tokens
 * @returns {string|null}
 */
export function shapeStyle(styles, tokens) {
  const parts = [];
  for (const [key, value] of Object.entries(shapeAttributes(styles, tokens)))
    parts.push(`${key}:${value}`);
  return parts.length === 0 ? null : parts.join(';');
}

/**
 * The SVG attributes a resolved style object contributes to a shape, with the
 * built-in `note` marker expanded against the live theme.
 * @param {Record<string,string>|undefined} styles
 * @param {Record<string,string>} tokens theme tokens
 * @returns {Record<string,string>}
 */
export function shapeAttributes(styles, tokens) {
  /** @type {Record<string,string>} */
  const out = {};
  if (styles === undefined) return out;
  if (styles['mm-builtin'] === 'note') {
    out.fill = tokens.noteFill;
    out.stroke = tokens.noteStroke;
    out['stroke-dasharray'] = '4 3';
  }
  for (const [key, attribute] of Object.entries(SHAPE_PROPS)) {
    const value = styles[key];
    if (value === undefined) continue;
    out[attribute] = key === 'stroke-width' ? value.replace(/px$/i, '') : value;
  }
  return out;
}

/**
 * The text color a resolved style object asks for, or null to keep the theme's.
 * @param {Record<string,string>|undefined} styles
 * @param {Record<string,string>} tokens theme tokens
 * @returns {string|null}
 */
export function textColor(styles, tokens) {
  if (styles === undefined) return null;
  if (typeof styles.color === 'string') return styles.color;
  if (styles['mm-builtin'] === 'note') return tokens.noteText;
  return null;
}
