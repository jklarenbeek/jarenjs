//@ts-check
/**
 * @file Optional per-node tooltips for a rendered flowchart or state diagram.
 *
 * Like pan/zoom, this is an enhancement of a finished SVG: the render never
 * imports it, it runs only in a browser, and only when a consumer opts in
 * with `mermaidPlugin({ tooltips: true })`. Server output is byte-identical
 * with and without it, and a page that never enables it tree-shakes the file
 * away.
 *
 * The render already names its targets: every node group carries
 * `data-id="<node id>"` and every edge group `data-from` / `data-to`. The
 * tooltip is built from those and the label text in the DOM, so nothing is
 * re-parsed and nothing is re-rendered. What it tells a reader is what the
 * picture cannot while the diagram is zoomed in or large: the node's id and
 * what flows into and out of it, named by the neighbours' labels.
 *
 * The rules that keep it usable:
 *
 *   - **Focus shows it, like hover.** Each node is focusable; a keyboard user
 *     gets exactly the text a mouse user does.
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

/**
 * The text a node's tooltip shows, from the diagram's own DOM.
 * @param {any} svg the rendered `<svg>`
 * @returns {Map<any, string>} node group element to tooltip text
 */
function describeNodes(svg) {
  /** @type {Map<string, string>} how the neighbours' lines name each node */
  const names = new Map();
  /** @type {Map<string, any>} */
  const groups = new Map();
  /** @type {Map<string, string>} the label a node shows, '' when it shows none */
  const labels = new Map();
  for (const node of svg.querySelectorAll('.mm-node[data-id]')) {
    const id = node.getAttribute('data-id');
    const label = labelOf(node, '.mm-label');
    groups.set(id, node);
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
  for (const edge of svg.querySelectorAll('.mm-edge')) {
    const from = edge.getAttribute('data-from');
    const to = edge.getAttribute('data-to');
    if (!names.has(from) || !names.has(to)) continue;
    const say = labelOf(edge, '.mm-edge-label');
    push(out, from, say === '' ? names.get(to) : `${names.get(to)} (${say})`);
    push(into, to, say === '' ? names.get(from) : `${names.get(from)} (${say})`);
  }
  /** @type {Map<any, string>} */
  const texts = new Map();
  for (const [id, node] of groups) {
    const label = labels.get(id);
    const lines = [label === '' || label === id ? displayId(id) : `${label} (${id})`];
    if (into.has(id)) lines.push(`from: ${into.get(id)?.join(', ')}`);
    if (out.has(id)) lines.push(`to: ${out.get(id)?.join(', ')}`);
    texts.set(node, lines.join('\n'));
  }
  return texts;
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
 *   to: no `<svg>`, no document to build the tooltip with, or a diagram type
 *   whose nodes the render does not mark
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
  const texts = describeNodes(svg);
  if (texts.size === 0) return undefined;

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

  /** @type {any} the node whose tooltip is showing */
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
    tip.textContent = texts.get(node) ?? '';
    tip.removeAttribute('hidden');
    if (typeof tip.showPopover === 'function') {
      try { tip.showPopover(); }
      catch { /* a figure outside the document has no top layer; fixed still places it */ }
    }
    node.setAttribute('aria-describedby', tip.id);
    place();
  };

  const hide = () => {
    if (active === null) return;
    active.removeAttribute('aria-describedby');
    active = null;
    if (typeof tip.hidePopover === 'function') tip.hidePopover();
    tip.setAttribute('hidden', '');
  };

  /** The node group an event target sits in, or null. */
  const nodeOf = (target) => {
    const group = target?.closest?.('.mm-node[data-id]');
    return group !== null && group !== undefined && texts.has(group) ? group : null;
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

  for (const node of texts.keys()) {
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', texts.get(node)?.split('\n')[0] ?? '');
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
    for (const node of texts.keys()) {
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
