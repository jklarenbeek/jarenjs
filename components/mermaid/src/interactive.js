//@ts-check
/**
 * @file Optional pan/zoom/touch for a rendered diagram.
 *
 * The render stays pure: this module is never imported by it, runs only in a
 * browser, and only when a consumer opts in with `mermaidPlugin({ interactive:
 * true })`. Server-rendered output is byte-identical with and without it, and
 * a page that never enables it tree-shakes the whole file away.
 *
 * Everything happens on the SVG's `viewBox`. Nothing re-renders, nothing is
 * re-parsed, no `eval`, no `innerHTML` — panning is four numbers changing.
 *
 * The interaction rules are chosen so the diagram never fights the page,
 * which is the usual failure of embedded zoomable content:
 *
 *   - **A plain wheel scrolls the page.** Zoom needs ctrl/⌘ (the browser's own
 *     zoom gesture) or the on-diagram buttons. Hijacking the wheel is the
 *     fastest way to make a document unreadable.
 *   - **A one-finger drag pans only once zoomed in.** At rest the whole
 *     diagram is visible, so there is nothing to pan to, and a swipe should
 *     scroll the page like every other element. `touch-action` is switched to
 *     match, so the browser never has to guess.
 *   - **Two fingers always pinch-zoom**, because that gesture means nothing
 *     else inside a figure.
 *   - **Keyboard works**: the figure is focusable, `+`/`-`/`0` zoom and reset,
 *     arrows pan. A pointer-only zoom control is not usable by everyone.
 */

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.35;
const PAN_STEP = 40;

/** Parse `viewBox` into a mutable box, or null when the SVG lacks one. */
function readViewBox(svg) {
  const raw = svg.getAttribute('viewBox');
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/**
 * Attach pan/zoom to one rendered diagram element.
 * @param {any} el the block element wrapping the `<svg>`
 * @param {{ document?: any }} [env] injection seam for tests
 * @returns {(() => void)|undefined} a teardown function, or undefined when
 *   there is nothing to attach to
 */
export function attachInteractiveDiagram(el, env = {}) {
  const svg = el.querySelector === undefined ? null : el.querySelector('svg');
  if (svg === null) return undefined;
  const home = readViewBox(svg);
  if (home === null) return undefined;

  const doc = env.document ?? el.ownerDocument ?? globalThis.document;
  const view = { ...home };
  let scale = 1;

  const apply = () => {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    // Once zoomed the drag belongs to the diagram; until then it belongs to
    // the page. Telling the browser directly avoids a preventDefault race.
    el.style.touchAction = scale > 1 ? 'none' : 'pan-y';
    el.setAttribute('data-mm-zoom', scale.toFixed(2));
  };

  /** Clamp the view so the diagram can never be panned off its own canvas. */
  const clamp = () => {
    view.w = home.w / scale;
    view.h = home.h / scale;
    view.x = Math.min(Math.max(view.x, home.x), home.x + home.w - view.w);
    view.y = Math.min(Math.max(view.y, home.y), home.y + home.h - view.h);
  };

  /** Zoom about a point given in viewBox units. */
  const zoomAt = (factor, px, py) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    if (next === scale) return;
    const ratio = scale / next;
    view.x = px - (px - view.x) * ratio;
    view.y = py - (py - view.y) * ratio;
    scale = next;
    clamp();
    apply();
  };

  const centre = () => [view.x + view.w / 2, view.y + view.h / 2];

  const reset = () => {
    scale = 1;
    view.x = home.x; view.y = home.y; view.w = home.w; view.h = home.h;
    apply();
  };

  /** Client coordinates to viewBox units. */
  const toView = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return centre();
    return [
      view.x + ((clientX - rect.left) / rect.width) * view.w,
      view.y + ((clientY - rect.top) / rect.height) * view.h,
    ];
  };

  /** @type {Map<number, {x: number, y: number}>} live pointers */
  const pointers = new Map();
  let pinchDistance = 0;

  const onWheel = (event) => {
    // A plain wheel is the page's. Only the browser's own zoom modifier
    // means "zoom this thing".
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const [px, py] = toView(event.clientX, event.clientY);
    zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, px, py);
  };

  const onPointerDown = (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    }
    if (typeof svg.setPointerCapture === 'function' && pointers.size === 1) {
      try { svg.setPointerCapture(event.pointerId); }
      catch { /* a capture the browser declines is not fatal */ }
    }
  };

  const onPointerMove = (event) => {
    const previous = pointers.get(event.pointerId);
    if (previous === undefined) return;
    const current = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, current);

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 0 && distance > 0) {
        const [px, py] = toView((a.x + b.x) / 2, (a.y + b.y) / 2);
        zoomAt(distance / pinchDistance, px, py);
      }
      pinchDistance = distance;
      event.preventDefault();
      return;
    }

    // At rest there is nothing to pan to, so the gesture is the page's.
    if (scale <= 1) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    view.x -= ((current.x - previous.x) / rect.width) * view.w;
    view.y -= ((current.y - previous.y) / rect.height) * view.h;
    clamp();
    apply();
    event.preventDefault();
  };

  const onPointerUp = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
  };

  const onDoubleClick = (event) => {
    event.preventDefault();
    if (scale > 1) { reset(); return; }
    const [px, py] = toView(event.clientX, event.clientY);
    zoomAt(ZOOM_STEP * ZOOM_STEP, px, py);
  };

  const onKeyDown = (event) => {
    const [cx, cy] = centre();
    switch (event.key) {
      case '+': case '=': zoomAt(ZOOM_STEP, cx, cy); break;
      case '-': case '_': zoomAt(1 / ZOOM_STEP, cx, cy); break;
      case '0': reset(); break;
      case 'ArrowLeft': view.x -= PAN_STEP / scale; clamp(); apply(); break;
      case 'ArrowRight': view.x += PAN_STEP / scale; clamp(); apply(); break;
      case 'ArrowUp': view.y -= PAN_STEP / scale; clamp(); apply(); break;
      case 'ArrowDown': view.y += PAN_STEP / scale; clamp(); apply(); break;
      default: return;
    }
    event.preventDefault();
  };

  // The controls are built here, not in the render, so server output stays
  // free of buttons that would do nothing without this module. They are an
  // enhancement on top of an enhancement: without a document to build them,
  // pointer, pinch and keyboard still work, so their absence must not take
  // the viewer down with it.
  let controls = null;
  if (doc !== undefined && doc !== null && typeof doc.createElement === 'function') {
    controls = doc.createElement('div');
    controls.className = 'mm-controls';
    const buttons = [
      ['+', 'Zoom in', () => { const [x, y] = centre(); zoomAt(ZOOM_STEP, x, y); }],
      ['−', 'Zoom out', () => { const [x, y] = centre(); zoomAt(1 / ZOOM_STEP, x, y); }],
      ['↺', 'Reset view', reset],
    ];
    for (const [glyph, label, action] of buttons) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'mm-control';
      button.textContent = glyph;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', action);
      controls.appendChild(button);
    }
    el.appendChild(controls);
  }

  el.setAttribute('tabindex', '0');
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label',
    'Diagram. Use plus and minus to zoom, arrow keys to pan, zero to reset.');
  el.classList.add('mm-interactive');

  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerUp);
  svg.addEventListener('dblclick', onDoubleClick);
  el.addEventListener('keydown', onKeyDown);
  apply();

  return () => {
    svg.removeEventListener('wheel', onWheel);
    svg.removeEventListener('pointerdown', onPointerDown);
    svg.removeEventListener('pointermove', onPointerMove);
    svg.removeEventListener('pointerup', onPointerUp);
    svg.removeEventListener('pointercancel', onPointerUp);
    svg.removeEventListener('dblclick', onDoubleClick);
    el.removeEventListener('keydown', onKeyDown);
    if (controls !== null && controls.parentNode !== null)
      controls.parentNode.removeChild(controls);
    el.classList.remove('mm-interactive');
  };
}
