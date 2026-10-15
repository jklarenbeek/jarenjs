//@ts-check
/**
 * @file Optional tooltips for the nodes and edges of a rendered diagram:
 * flowchart, state and jaren-dag nodes and links, sequence actors and
 * messages, class and ER boxes and their relation rows, gantt rows and their
 * dependency connectors.
 *
 * Like pan/zoom, this is an enhancement of a finished SVG: the render never
 * imports it, it runs only in a browser, and only when a consumer opts in
 * with `mermaidPlugin({ tooltips: true })`. Server output is byte-identical
 * with and without it, and a page that never enables it tree-shakes the file
 * away.
 *
 * The render already names its targets, with one marker contract for every
 * type (`render/marks.js`): every node group carries `mm-node` and
 * `data-id="<node id>"`, every edge `mm-edge`, `data-from` and `data-to`. The
 * tooltip is built from those and the label text in the DOM, so nothing is
 * re-parsed and nothing is re-rendered, and this file reads no diagram type's
 * code. What it tells a reader is what the picture cannot while the diagram
 * is zoomed in or large: a node's id and what flows into and out of it, named
 * by the neighbours' labels, and an edge's two ends. A node a `click`
 * statement gave tooltip text shows that text instead, as text. The words
 * `from`, `to` and the arrow are English and not localizable.
 *
 * The rules that keep it usable:
 *
 *   - **Focus shows it, like hover.** Each node and edge is focusable (a
 *     gantt row through the link it wraps, when it has one); a keyboard user
 *     gets exactly the text a mouse user does, in drawing order.
 *   - **It is wired, not just drawn.** The tooltip is a `role="tooltip"`
 *     element and the focused or hovered node points at it with
 *     `aria-describedby` for as long as it is shown.
 *   - **Escape dismisses it**, whether focus or the pointer put it there, and
 *     without moving focus.
 *   - **The scrolling figure never clips it.** A diagram frame scrolls, so a
 *     tooltip inside it would be cut off or would grow the frame's scroll
 *     area. It is `position: fixed` against the viewport (and in the top layer
 *     where the browser has the popover API, which also escapes a transformed
 *     ancestor), placed from the node's client rectangle, flipped above the
 *     node when there is no room below.
 *   - **Touch never hovers.** A tap is the page's; a touch user reaches the
 *     same text by focusing the node.
 *   - **It follows the diagram.** A pan or zoom rewrites the `viewBox`, and a
 *     shown tooltip is placed against its node again when that happens.
 */

const GAP = 6;

/** @type {WeakMap<any, () => void>} the teardown of every figure already attached */
const attached = new WeakMap();

/** Monotonic suffix so two diagrams on one page never share a tooltip id. */
let serial = 0;

/** A node group, whatever the diagram type draws it as (`render/marks.js`). */
const NODE = '.mm-node[data-id]';
/** An edge element: a flowchart link, a sequence message, a relation row, a gantt dependency. */
const EDGE = '.mm-edge[data-from]';

/**
 * @typedef {object} Target
 * @property {string} text what its tooltip shows
 * @property {string} name its accessible name: the tooltip's first line
 * @property {any} describes the element the tooltip describes: the target
 *   itself, or the link a gantt row wraps its label and bar in
 */

/**
 * What each node's and each edge's tooltip says, from the diagram's own DOM.
 * @param {any} svg the rendered `<svg>`
 * @returns {Map<any, Target>} target element to what it shows
 */
function describeTargets(svg) {
  /** @type {Map<string, string>} how the neighbours' lines name each node */
  const names = new Map();
  /** @type {Map<string, string>} the label a node shows, '' when it shows none */
  const labels = new Map();
  /** @type {[any, string][]} every node element and its id; a sequence draws each actor twice */
  const nodes = [];
  for (const node of svg.querySelectorAll(NODE)) {
    const id = node.getAttribute('data-id');
    nodes.push([node, id]);
    const label = labelOf(node, '.mm-label');
    labels.set(id, label);
    names.set(id, label || displayId(id));
  }
  /** @type {Map<string, string[]>} */
  const into = new Map();
  /** @type {Map<string, string[]>} */
  const out = new Map();
  const push = (map, id, text) => {
    const list = map.get(id);
    if (list === undefined) map.set(id, [text]);
    else list.push(text);
  };
  /** @type {[any, string][]} */
  const edges = [];
  for (const edge of svg.querySelectorAll(EDGE)) {
    const from = edge.getAttribute('data-from');
    const to = edge.getAttribute('data-to');
    if (!names.has(from) || !names.has(to)) continue;
    const say = labelOf(edge, '.mm-edge-label');
    push(out, from, say === '' ? names.get(to) : `${names.get(to)} (${say})`);
    push(into, to, say === '' ? names.get(from) : `${names.get(from)} (${say})`);
    edges.push([edge, `${names.get(from)} → ${names.get(to)}${say === '' ? '' : ` (${say})`}`]);
  }
  /** @type {Map<any, Target>} */
  const targets = new Map();
  for (const [node, id] of nodes) {
    const label = labels.get(id);
    const lines = [label === '' || label === id ? displayId(id) : `${label} (${id})`];
    if (into.has(id)) lines.push(`from: ${into.get(id)?.join(', ')}`);
    if (out.has(id)) lines.push(`to: ${out.get(id)?.join(', ')}`);
    // the text a `click` statement gave the node, which the render keeps in
    // the node's `<desc>`, is what the author chose to say instead
    const authored = String(node.querySelector('desc')?.textContent ?? '');
    targets.set(node, {
      text: authored === '' ? lines.join('\n') : authored,
      name: lines[0],
      describes: node.querySelector('a') ?? node,
    });
  }
  for (const [edge, line] of edges) targets.set(edge, { text: line, name: line, describes: edge });
  return targets;
}

/** A synthetic id such as `__start` reads as a word, not as plumbing. */
function displayId(id) {
  return id.startsWith('__') ? id.slice(2) : id;
}

/**
 * The visible text of the first element matching `selector` under `parent`,
 * one space between its lines.
 */
function labelOf(parent, selector) {
  const label = parent.querySelector(selector);
  if (label === null || label === undefined) return '';
  const lines = [...label.querySelectorAll('tspan')]
    .map((line) => String(line.textContent ?? '').trim())
    .filter((line) => line !== '');
  return lines.length > 0 ? lines.join(' ') : String(label.textContent ?? '').trim();
}

/**
 * Attach per-node tooltips to one rendered diagram element.
 * @param {any} el the block element wrapping the `<svg>`
 * @param {{ document?: any, MutationObserver?: any }} [env] injection seam for tests
 * @returns {(() => void)|undefined} a teardown function (the same one when the
 *   element is already attached), or undefined when there is nothing to attach
 *   to: no `<svg>`, no document to build the tooltip with, or a diagram
 *   that draws no marked node or edge (a pie, a placeholder, an error)
 */
export function attachDiagramTooltips(el, env = {}) {
  const again = attached.get(el);
  if (again !== undefined) return again;
  const svg = el.querySelector === undefined ? null : el.querySelector('svg');
  if (svg === null) return undefined;
  const doc = env.document ?? el.ownerDocument ?? globalThis.document;
  if (doc === undefined || doc === null || typeof doc.createElement !== 'function'
    || typeof doc.addEventListener !== 'function')
    return undefined;
  const targets = describeTargets(svg);
  if (targets.size === 0) return undefined;

  const tip = doc.createElement('div');
  tip.className = 'mm-tooltip';
  tip.id = `mm-tooltip-${++serial}`;
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('hidden', '');
  tip.style.position = 'fixed';
  // A manual popover is promoted to the top layer by `showPopover`, so no
  // overflow or transform on an ancestor can clip or move it.
  if (typeof tip.showPopover === 'function') tip.setAttribute('popover', 'manual');
  el.appendChild(tip);

  /** @type {any} the node or edge whose tooltip is showing */
  let active = null;

  /** Place the tooltip under its node (above it when below does not fit), in viewport coordinates. */
  const place = () => {
    if (active === null) return;
    const target = active.getBoundingClientRect();
    const view = doc.documentElement;
    const width = tip.offsetWidth ?? 0;
    const height = tip.offsetHeight ?? 0;
    let left = target.left;
    if (width > 0 && view?.clientWidth > 0) left = Math.min(left, view.clientWidth - width);
    let top = target.bottom + GAP;
    if (height > 0 && view?.clientHeight > 0 && top + height > view.clientHeight
      && target.top - GAP - height >= 0) top = target.top - GAP - height;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${top}px`;
  };

  /** @param {any} node */
  const show = (node) => {
    if (active === node) return;
    hide();
    active = node;
    // text, never markup: the author's `click` text included
    tip.textContent = targets.get(node)?.text ?? '';
    tip.removeAttribute('hidden');
    if (typeof tip.showPopover === 'function') {
      try { tip.showPopover(); }
      catch { /* a figure outside the document has no top layer; fixed still places it */ }
    }
    targets.get(node)?.describes.setAttribute('aria-describedby', tip.id);
    place();
  };

  const hide = () => {
    if (active === null) return;
    targets.get(active)?.describes.removeAttribute('aria-describedby');
    active = null;
    if (typeof tip.hidePopover === 'function') tip.hidePopover();
    tip.setAttribute('hidden', '');
  };

  /** The node or edge an event target sits in, or null. */
  const nodeOf = (target) => {
    const found = target?.closest?.(NODE) ?? target?.closest?.(EDGE);
    return found !== null && found !== undefined && targets.has(found) ? found : null;
  };

  // Hover and focus share one pair of handlers; a focus event carries no
  // `pointerType`, so the touch rule only ever applies to a pointer.
  const onEnter = (event) => {
    if (event.pointerType === 'touch') return;
    const node = nodeOf(event.target);
    if (node !== null) show(node);
  };
  const onLeave = (event) => {
    if (event.pointerType === 'touch') return;
    const node = nodeOf(event.target);
    if (node !== null && node === active && nodeOf(event.relatedTarget) !== node) hide();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') hide();
  };

  // A gantt row that wraps a link is reached through the link: it already
  // takes focus and is named by its text, and an image role on the row would
  // hide it from a screen reader.
  const marked = [...targets].filter(([node, target]) => target.describes === node).map(([node]) => node);
  for (const node of marked) {
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', targets.get(node)?.name ?? '');
  }
  el.classList.add('mm-has-tooltips');
  svg.addEventListener('pointerover', onEnter);
  svg.addEventListener('pointerout', onLeave);
  svg.addEventListener('focusin', onEnter);
  svg.addEventListener('focusout', onLeave);
  // Escape belongs to the document: a hover-shown tooltip has no focus inside
  // the figure to carry the key. A scroll anywhere (captured, so the figure's
  // own scrolling counts) moves the node under a fixed tooltip.
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('scroll', place, true);

  // Pan and zoom rewrite the viewBox; the node moves under a shown tooltip.
  const Observer = env.MutationObserver ?? globalThis.MutationObserver;
  const observer = typeof Observer === 'function' ? new Observer(place) : null;
  observer?.observe(svg, { attributes: true, attributeFilter: ['viewBox'] });

  const detach = () => {
    attached.delete(el);
    hide();
    observer?.disconnect();
    svg.removeEventListener('pointerover', onEnter);
    svg.removeEventListener('pointerout', onLeave);
    svg.removeEventListener('focusin', onEnter);
    svg.removeEventListener('focusout', onLeave);
    doc.removeEventListener('keydown', onKeyDown);
    doc.removeEventListener('scroll', place, true);
    for (const node of marked) {
      node.removeAttribute('tabindex');
      node.removeAttribute('role');
      node.removeAttribute('aria-label');
    }
    if (tip.parentNode !== null) tip.parentNode.removeChild(tip);
    el.classList.remove('mm-has-tooltips');
  };
  attached.set(el, detach);
  return detach;
}
