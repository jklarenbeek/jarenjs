//@ts-check
/**
 * @file What an `app` view renders that its author did not mean, read
 * with the view format's own vnode rules (VIEW-FORMAT §2): text, skipped
 * values, `[tag, props?, ...children]` elements and lists. Four findings:
 *
 *  - `JS0004`, a refusal: an object carrying `tag` or `type` together
 *    with `props`, `attrs` or `children`, in a position the view renders
 *    as a vnode. §2 has no object vnode, so both renderers draw any object
 *    child as nothing, and the DOM renderer refuses one at the root; such
 *    an object is an element written in another library's shape. Data
 *    objects elsewhere (state, element props, a widget's props, an
 *    operator's operands) are never read here.
 *  - `JS0005`, a warning: an authored text literal that carries another
 *    template language's expression — `${…}`, `{{…}}`, `{%…%}`, a
 *    leading `for .`/`if .` (Schibsted JSLT), or a call `name([…])`. It
 *    renders as literal text, which may be what the author meant, so it
 *    never refuses.
 *  - `JS0006`, a warning: any other object in a vnode position. It renders
 *    as nothing too, but an object of no element shape is as often a
 *    computed value the author means to drop as a mistake, so it never
 *    refuses.
 *  - `JS0007`, a warning: an element written as an object with a `tag`
 *    (`["ul", {"tag": "li", "children": […]}]`) in an element's props
 *    position. The renderer reads it as that element's attributes, which
 *    renders, so it never refuses; `type` alone is not read as the shape
 *    there, because it is an HTML attribute (`["input", {"type": …}]`).
 *
 * Two walks: one over the stylesheet's literal element arrays (it finds
 * the shape in a branch the first frame does not take, such as the body
 * of a `$for` over an empty list), and one over the first frame itself
 * (it finds an object a query or a rule computed). Text is checked in
 * the stylesheet only, so a state string shown through a path is the
 * reader's data and never warned about.
 */

import { isJsonObject } from '@jarenjs/core/object';

// VIEW-FORMAT §2's classes, spelled here because the studio root does not
// reach the view runtime (`@jarenjs/view`'s `isTextNode`, `isSkippedNode`,
// `isElementNode` and `WIDGET_TAG` read the same)
/** @param {unknown} vnode */
const isTextNode = (vnode) => typeof vnode === 'string' || typeof vnode === 'number';
/** @param {unknown} vnode */
const isSkippedNode = (vnode) => vnode == null || vnode === true || vnode === false;
/** @param {unknown} vnode @returns {vnode is any[]} */
const isElementNode = (vnode) => Array.isArray(vnode) && typeof vnode[0] === 'string';
const WIDGET_TAG = 'jaren-widget';

/** Findings kept per audit and per list (a warning never crowds out a refusal). */
const MAX_FINDINGS = 20;

/**
 * The foreign template signatures, in the order a warning names them.
 * @type {ReadonlyArray<{ name: string, test: RegExp }>}
 */
const FOREIGN_TEMPLATE_SIGNATURES = Object.freeze([
  { name: '${…}', test: /\$\{[^}]*\}/ },
  { name: '{{…}}', test: /\{\{[\s\S]*?\}\}/ },
  { name: '{%…%}', test: /\{%[\s\S]*?%\}/ },
  { name: "a leading 'for .' or 'if .'", test: /^\s*\[?\s*(?:for|if)\s*\(?\s*\./ },
  { name: "a call 'name([…])'", test: /\b[A-Za-z_][\w-]*\(\s*\[/ },
]);

/** @param {Record<string, unknown>} object */
const hasOperatorKey = (object) => Object.keys(object).some((key) => key.startsWith('$'));

/**
 * Is this value an element written as an object — `tag` or `type` beside
 * `props`, `attrs` or `children`?
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectShapedElement(value) {
  if (!isJsonObject(value)) return false;
  return (Object.hasOwn(value, 'tag') || Object.hasOwn(value, 'type'))
    && (Object.hasOwn(value, 'props') || Object.hasOwn(value, 'attrs') || Object.hasOwn(value, 'children'));
}

/**
 * Is this props object an element written as an object — `tag` beside
 * `props`, `attrs` or `children`?
 * @param {Record<string, unknown>} props
 */
const isPropsShapedElement = (props) => Object.hasOwn(props, 'tag') && isObjectShapedElement(props);

/** @param {Record<string, unknown>} object */
const objectWarning = (object) => {
  const keys = Object.keys(object);
  const named = keys.length === 0 ? 'an empty object' : `an object with ${keys.slice(0, 3).map((key) => `'${key}'`).join(', ')}${keys.length > 3 ? ', …' : ''}`;
  return `${named} is not a vnode and renders as nothing (the DOM renderer refuses one at the root); a child is text or an array: ['tag', {attrs}, …children]`;
};

/** @param {Record<string, unknown>} props */
const propsWarning = (props) => `an element written as an object ({tag: '${String(props.tag)}', …}) in the props position is read as this element's attributes; a child element is an array after the props: ['${String(props.tag)}', {attrs}, …children]`;

/** @param {Record<string, unknown>} object */
function vnodeRefusal(object) {
  const name = typeof object.tag === 'string' ? object.tag : typeof object.type === 'string' ? object.type : 'tag';
  const members = ['tag', 'type', 'props', 'attrs', 'children'].filter((key) => Object.hasOwn(object, key)).map((key) => `'${key}'`);
  return `an object with ${members.join(', ')} is not a vnode and renders as nothing; a vnode is an array: ['${name}', {attrs}, …children]`;
}

/**
 * The first foreign template signature a text carries, or `null`.
 * @param {string} text
 * @returns {string | null}
 */
function foreignTemplateSignature(text) {
  for (const signature of FOREIGN_TEMPLATE_SIGNATURES) if (signature.test.test(text)) return signature.name;
  return null;
}

/**
 * Walk one expression of a rule body. `child` says whether its value
 * lands where the view renders a vnode child. Only the constructs whose
 * value IS the expression's value are followed: element and list items,
 * FLWOR `$return`, `$if` branches.
 * @param {unknown} expr
 * @param {string} path
 * @param {boolean} child
 * @param {{ refusals: any[], warnings: any[] }} out
 */
function walkExpression(expr, path, child, out) {
  if (out.refusals.length >= MAX_FINDINGS) return;
  if (typeof expr === 'string') {
    if (!child || expr.startsWith('$')) return; // a path or a variable, not text
    const signature = out.warnings.length < MAX_FINDINGS ? foreignTemplateSignature(expr) : null;
    if (signature !== null) {
      out.warnings.push({ code: 'JS0005', docPath: path,
        message: `this text holds ${signature}, another template language's expression syntax; it renders as literal text — compute the value with a query ({"$count": "$.items"}, {"$for": …, "$return": …}) if that is what it means` });
    }
    return;
  }
  if (Array.isArray(expr)) {
    const element = typeof expr[0] === 'string' && !expr[0].startsWith('$');
    for (let i = element ? 1 : 0; i < expr.length; i++) {
      // an element's second item, when an object, is its props (or computes them)
      if (element && i === 1 && isJsonObject(expr[1])) {
        if (expr[0] !== WIDGET_TAG && !hasOperatorKey(expr[1]) && isPropsShapedElement(expr[1])) warn(out, 'JS0007', `${path}/1`, propsWarning(expr[1]));
        continue;
      }
      walkExpression(expr[i], `${path}/${i}`, element || child, out);
    }
    return;
  }
  if (!isJsonObject(expr)) return;
  if (hasOperatorKey(expr)) {
    if (Object.hasOwn(expr, '$return')) walkExpression(expr.$return, `${path}/$return`, child, out);
    if (Array.isArray(expr.$if)) {
      for (const i of [1, 2]) if (i < expr.$if.length) walkExpression(expr.$if[i], `${path}/$if/${i}`, child, out);
    }
    return;
  }
  if (!child) return;
  if (isObjectShapedElement(expr)) out.refusals.push({ code: 'JS0004', docPath: path, message: vnodeRefusal(expr) });
  else warn(out, 'JS0006', path, objectWarning(expr));
}

/**
 * Record a warning, bounded.
 * @param {{ warnings: any[] }} out @param {string} code @param {string} docPath @param {string} message
 */
function warn(out, code, docPath, message) {
  if (out.warnings.length < MAX_FINDINGS) out.warnings.push({ code, docPath, message });
}

/**
 * Walk the rendered first frame with the renderer's own rules. `find`
 * names the findings still wanted: those the stylesheet walk did not
 * already place exactly.
 * @param {unknown} vnode
 * @param {string} path - a pointer into the rendered frame
 * @param {{ refusals: any[], warnings: any[] }} out
 * @param {{ JS0004: boolean, JS0006: boolean, JS0007: boolean }} find
 */
function walkFrame(vnode, path, out, find) {
  if (out.refusals.length >= MAX_FINDINGS || isSkippedNode(vnode) || isTextNode(vnode)) return;
  const where = path === '' ? 'its root' : path;
  if (isElementNode(vnode)) {
    if (vnode[0] === WIDGET_TAG) return; // its props are the widget's data
    const props = isJsonObject(vnode[1]);
    if (props && find.JS0007 && isPropsShapedElement(vnode[1])) {
      warn(out, 'JS0007', '/view', `the first frame renders, at ${path}/1, ${propsWarning(vnode[1])}`);
    }
    for (let i = props ? 2 : 1; i < vnode.length; i++) walkFrame(vnode[i], `${path}/${i}`, out, find);
    return;
  }
  if (Array.isArray(vnode)) {
    for (let i = 0; i < vnode.length; i++) walkFrame(vnode[i], `${path}/${i}`, out, find);
    return;
  }
  if (!isJsonObject(vnode)) return;
  if (isObjectShapedElement(vnode)) {
    if (find.JS0004) out.refusals.push({ code: 'JS0004', docPath: '/view', message: `the first frame renders, at ${where}, ${vnodeRefusal(vnode)}` });
  }
  else if (find.JS0006) warn(out, 'JS0006', '/view', `the first frame renders, at ${where}, ${objectWarning(vnode)}`);
}

/**
 * Audit an app document's view: the stylesheet's literal vnodes and the
 * first frame it rendered.
 * @param {any} view - the document's `view` member
 * @param {unknown} frame - the first frame the view rendered over the state
 * @returns {{ refusals: Array<{ code: string, message: string, docPath: string }>,
 *   warnings: Array<{ code: string, message: string, docPath: string }> }}
 */
export function auditRenderedView(view, frame) {
  /** @type {{ refusals: any[], warnings: any[] }} */
  const out = { refusals: [], warnings: [] };
  const envelope = isJsonObject(view);
  const rules = envelope ? view.rules : view;
  if (Array.isArray(rules)) {
    const base = envelope ? '/view/rules' : '/view';
    rules.forEach((rule, i) => {
      if (isJsonObject(rule) && Object.hasOwn(rule, 'body')) walkExpression(rule.body, `${base}/${i}/body`, false, out);
    });
  }
  // the stylesheet names the place exactly; the frame is read for each
  // finding it placed none of
  const placed = (/** @type {string} */ code) => out.warnings.some((w) => w.code === code);
  const find = { JS0004: out.refusals.length === 0, JS0006: !placed('JS0006'), JS0007: !placed('JS0007') };
  if (find.JS0004 || find.JS0006 || find.JS0007) walkFrame(frame, '', out, find);
  return out;
}
