//@ts-check
/**
 * @file The optional pan/zoom viewer.
 *
 * The behaviour worth pinning is not "zoom works" — it is the set of rules
 * that keep a zoomable figure from fighting the page it sits in: a plain
 * wheel must scroll, a one-finger drag must not steal a page swipe until
 * there is something to pan to, and the view can never leave the diagram.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { attachInteractiveDiagram } from '@jarenjs/mermaid/interactive';

/** The smallest DOM this module actually touches. */
function stubDom(viewBox = '0 0 100 80') {
  const listeners = new Map();
  const make = (tag) => ({
    tagName: tag,
    style: {},
    className: '',
    textContent: '',
    type: '',
    children: [],
    parentNode: null,
    attrs: new Map(),
    classes: new Set(),
    setAttribute(k, v) { this.attrs.set(k, String(v)); },
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    addEventListener(type, fn) {
      const key = `${this.tagName}:${type}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(fn);
    },
    removeEventListener(type, fn) {
      const key = `${this.tagName}:${type}`;
      listeners.set(key, (listeners.get(key) ?? []).filter((f) => f !== fn));
    },
    classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 160 }),
    setPointerCapture() {},
  });

  const svg = make('svg');
  svg.setAttribute('viewBox', viewBox);
  const el = make('div');
  el.appendChild(svg);
  el.querySelector = (sel) => (sel === 'svg' ? svg : null);
  const document = { createElement: (tag) => make(tag) };
  el.ownerDocument = document;
  const fire = (tag, type, event = {}) => {
    for (const fn of listeners.get(`${tag}:${type}`) ?? [])
      fn({ preventDefault() {}, ...event });
  };
  const box = () => svg.getAttribute('viewBox').split(' ').map(Number);
  const handlers = (tag, type) => listeners.get(`${tag}:${type}`) ?? [];
  return { el, svg, document, fire, box, handlers };
}

describe('interactive diagrams — the page always wins where it should', () => {
  it('ignores a plain wheel so the page keeps scrolling', () => {
    const dom = stubDom();
    attachInteractiveDiagram(dom.el, { document: dom.document });
    const before = dom.svg.getAttribute('viewBox');
    dom.fire('svg', 'wheel', { deltaY: -100, clientX: 100, clientY: 80 });
    assert.strictEqual(dom.svg.getAttribute('viewBox'), before,
      'a wheel without ctrl/meta must not zoom');
  });

  it('zooms on ctrl+wheel, toward the pointer', () => {
    const dom = stubDom();
    attachInteractiveDiagram(dom.el, { document: dom.document });
    dom.fire('svg', 'wheel', { deltaY: -100, clientX: 100, clientY: 80, ctrlKey: true });
    const [, , w, h] = dom.box();
    assert.ok(w < 100 && h < 80, `expected a narrower view, got ${w}x${h}`);
  });

  it('does not pan on a one-finger drag until there is something to pan to', () => {
    // At rest the whole diagram is visible; a swipe belongs to the page.
    const dom = stubDom();
    attachInteractiveDiagram(dom.el, { document: dom.document });
    const before = dom.svg.getAttribute('viewBox');
    dom.fire('svg', 'pointerdown', { pointerId: 1, clientX: 50, clientY: 50 });
    dom.fire('svg', 'pointermove', { pointerId: 1, clientX: 90, clientY: 70 });
    assert.strictEqual(dom.svg.getAttribute('viewBox'), before);
    assert.strictEqual(dom.el.style.touchAction, 'pan-y',
      'the browser should be told the page may scroll');
  });

  it('pans once zoomed, and switches touch-action to match', () => {
    const dom = stubDom();
    attachInteractiveDiagram(dom.el, { document: dom.document });
    dom.fire('svg', 'wheel', { deltaY: -100, clientX: 100, clientY: 80, ctrlKey: true });
    assert.strictEqual(dom.el.style.touchAction, 'none');
    const [x0] = dom.box();
    dom.fire('svg', 'pointerdown', { pointerId: 1, clientX: 100, clientY: 80 });
    dom.fire('svg', 'pointermove', { pointerId: 1, clientX: 60, clientY: 80 });
    assert.notStrictEqual(dom.box()[0], x0, 'a drag while zoomed must pan');
  });

  it('never lets the view leave the diagram', () => {
    const dom = stubDom();
    attachInteractiveDiagram(dom.el, { document: dom.document });
    dom.fire('svg', 'wheel', { deltaY: -100, clientX: 100, clientY: 80, ctrlKey: true });
    for (let i = 0; i < 40; i++)
      dom.fire('svg', 'pointerdown', { pointerId: 1, clientX: 200, clientY: 160 })
        || dom.fire('svg', 'pointermove', { pointerId: 1, clientX: -400, clientY: -400 });
    const [x, y, w, h] = dom.box();
    assert.ok(x >= 0 && y >= 0, `view escaped: ${x},${y}`);
    assert.ok(x + w <= 100.001 && y + h <= 80.001, `view escaped: ${x + w},${y + h}`);
  });

  it('zooms with two fingers', () => {
    const dom = stubDom();
    attachInteractiveDiagram(dom.el, { document: dom.document });
    dom.fire('svg', 'pointerdown', { pointerId: 1, clientX: 80, clientY: 80 });
    dom.fire('svg', 'pointerdown', { pointerId: 2, clientX: 120, clientY: 80 });
    dom.fire('svg', 'pointermove', { pointerId: 2, clientX: 180, clientY: 80 });
    assert.ok(dom.box()[2] < 100, 'a pinch outward must zoom in');
  });

  it('works from the keyboard and resets with 0', () => {
    const dom = stubDom();
    attachInteractiveDiagram(dom.el, { document: dom.document });
    dom.fire('div', 'keydown', { key: '+' });
    assert.ok(dom.box()[2] < 100, '+ must zoom in');
    dom.fire('div', 'keydown', { key: '0' });
    assert.deepStrictEqual(dom.box(), [0, 0, 100, 80], '0 must reset');
    assert.strictEqual(dom.el.getAttribute('tabindex'), '0', 'the figure must be focusable');
    assert.match(dom.el.getAttribute('aria-label') ?? '', /zoom/i);
  });

  it('adds controls on hydrate and removes them on teardown', () => {
    const dom = stubDom();
    const detach = attachInteractiveDiagram(dom.el, { document: dom.document });
    const controls = dom.el.children.find((c) => c.className === 'mm-controls');
    assert.ok(controls !== undefined, 'controls are created by hydration, not by the render');
    assert.strictEqual(controls.children.length, 3);
    assert.deepStrictEqual(controls.children.map((b) => b.getAttribute('aria-label')),
      ['Zoom in', 'Zoom out', 'Reset view']);
    detach?.();
    assert.ok(!dom.el.children.includes(controls), 'teardown removes what it added');
  });

  it('declines an element it cannot drive, rather than throwing', () => {
    const empty = { querySelector: () => null };
    assert.strictEqual(attachInteractiveDiagram(empty), undefined);
    const noViewBox = stubDom();
    noViewBox.svg.attrs.delete('viewBox');
    assert.strictEqual(
      attachInteractiveDiagram(noViewBox.el, { document: noViewBox.document }), undefined);
  });
});

describe('interactive diagrams — the remaining interaction paths', () => {
  it('resets on a double-click when zoomed, and zooms in when not', () => {
    const dom = stubDom();
    attachInteractiveDiagram(dom.el, { document: dom.document });
    dom.fire('svg', 'dblclick', { clientX: 100, clientY: 80 });
    assert.ok(dom.box()[2] < 100, 'a double-click at rest zooms in');
    dom.fire('svg', 'dblclick', { clientX: 100, clientY: 80 });
    assert.deepStrictEqual(dom.box(), [0, 0, 100, 80], 'a second one resets');
  });

  it('releases a pointer so a lifted finger stops panning', () => {
    const dom = stubDom();
    attachInteractiveDiagram(dom.el, { document: dom.document });
    dom.fire('svg', 'wheel', { deltaY: -100, clientX: 100, clientY: 80, ctrlKey: true });
    dom.fire('svg', 'pointerdown', { pointerId: 1, clientX: 100, clientY: 80 });
    dom.fire('svg', 'pointerup', { pointerId: 1 });
    const [x] = dom.box();
    // A move after the release belongs to no gesture and must change nothing.
    dom.fire('svg', 'pointermove', { pointerId: 1, clientX: 20, clientY: 80 });
    assert.strictEqual(dom.box()[0], x);
  });

  it('drives zoom from the controls', () => {
    // The stub records listeners per tag name, and the three buttons register
    // in the order they are built: zoom in, zoom out, reset.
    const dom = stubDom();
    attachInteractiveDiagram(dom.el, { document: dom.document });
    const clicks = dom.handlers('button', 'click');
    assert.strictEqual(clicks.length, 3);
    const [zoomIn, zoomOut, reset] = clicks;

    zoomIn();
    assert.ok(dom.box()[2] < 100, 'the + control must zoom in');
    zoomOut();
    assert.deepStrictEqual(dom.box(), [0, 0, 100, 80], 'the − control must undo it');
    zoomIn();
    reset();
    assert.deepStrictEqual(dom.box(), [0, 0, 100, 80], 'the reset control must go home');
  });
});

describe('classDef, class and style resolution', () => {
  it('parses a style string into properties', async () => {
    const { parseStyleString } = await import('@jarenjs/mermaid/styles');
    assert.deepStrictEqual(parseStyleString('fill:#eee, stroke-width:2px'),
      { fill: '#eee', 'stroke-width': '2px' });
    assert.deepStrictEqual(parseStyleString('nonsense'), {});
    assert.deepStrictEqual(parseStyleString(undefined), {});
  });

  it('applies one class to several nodes and one classDef to several classes', async () => {
    const { resolveNodeStyles } = await import('@jarenjs/mermaid/styles');
    const styles = resolveNodeStyles({
      classDefs: [{ name: 'a,b', styles: 'fill:#eee' }],
      classes: [{ node: 'X,Y', name: 'a' }],
      styles: [{ node: 'Y', styles: 'stroke:#f00' }],
    });
    assert.deepStrictEqual(styles.get('X'), { fill: '#eee' });
    // A per-node `style` wins over the class it also carries.
    assert.deepStrictEqual(styles.get('Y'), { fill: '#eee', stroke: '#f00' });
  });

  it('marks the built-in note class for the renderer to theme', async () => {
    const { resolveNodeStyles, shapeAttributes, textColor } =
      await import('@jarenjs/mermaid/styles');
    const styles = resolveNodeStyles({ classes: [{ node: 'N', name: 'note' }] });
    const tokens = { noteFill: '#ff0', noteStroke: '#f0f', noteText: '#00f' };
    assert.strictEqual(shapeAttributes(styles.get('N'), tokens).fill, '#ff0');
    assert.strictEqual(shapeAttributes(styles.get('N'), tokens)['stroke-dasharray'], '4 3');
    assert.strictEqual(textColor(styles.get('N'), tokens), '#00f');
    assert.deepStrictEqual(shapeAttributes(undefined, tokens), {});
    assert.strictEqual(textColor(undefined, tokens), null);
  });
});

describe('the plugin only grows a hydrate when asked', () => {
  it('adds the hydrate marker and wires the viewer, and neither without interactive', async () => {
    const { mermaidPlugin } = await import('@jarenjs/mermaid/plugin');
    const node = { value: 'flowchart LR\n  A["a"] --> B["b"]' };

    const plain = mermaidPlugin();
    assert.strictEqual(plain.hydrate, undefined, 'a plain plugin has nothing to hydrate');
    assert.strictEqual(plain.render(node)[1]['data-md-hydrate'], undefined,
      'server output must be unchanged when interaction is not asked for');

    const live = mermaidPlugin({ interactive: true });
    assert.strictEqual(live.render(node)[1]['data-md-hydrate'], 'mermaid');
    assert.strictEqual(typeof live.hydrate, 'function');

    // The hydrate is what attaches the viewer; drive it over the stub DOM.
    const dom = stubDom();
    await live.hydrate(dom.el);
    assert.strictEqual(dom.el.getAttribute('tabindex'), '0');
    assert.ok(dom.el.children.some((c) => c.className === 'mm-controls'));
  });

  it('still pans and zooms when there is no document to build controls with', () => {
    // The controls are an enhancement on an enhancement; losing them must not
    // take the pointer, pinch and keyboard paths down too.
    const dom = stubDom();
    delete dom.el.ownerDocument;
    const detach = attachInteractiveDiagram(dom.el, { document: null });
    assert.ok(!dom.el.children.some((c) => c.className === 'mm-controls'));
    dom.fire('div', 'keydown', { key: '+' });
    assert.ok(dom.box()[2] < 100, 'the keyboard path must still work');
    detach?.();
  });
});

describe('<br/> is a line break, not text', () => {
  it('breaks a label, sizes the box for it, and round-trips', async () => {
    const { parseMermaid, toMermaid, renderMermaid } = await import('@jarenjs/mermaid');
    const { renderToString } = await import('@jarenjs/view');

    const doc = parseMermaid('flowchart TD\n  A["one<br/>two"] -->|"x<br>y"| B["z"]');
    assert.strictEqual(doc.ast.nodes[0].label, 'one\ntwo', '<br/> is a newline');
    assert.strictEqual(doc.ast.edges[0].label, 'x\ny', 'and in edge labels too');

    // A two-line label must be laid out as two lines, not one long one.
    const svg = renderToString(renderMermaid(doc));
    assert.ok(!svg.includes('&lt;br'), 'the tag must not survive into the output');
    assert.match(svg, />one</);
    assert.match(svg, />two</);

    // Printing it back must produce source that still parses to the same AST.
    const printed = toMermaid(doc);
    assert.match(printed, /<br\/>/);
    assert.deepStrictEqual(parseMermaid(printed).ast.nodes, doc.ast.nodes);
  });
});

describe('a label stays legible on whatever fill the author chose', () => {
  it('derives the ink from a concrete fill instead of the theme', async () => {
    // The failure this prevents: a pale `classDef` fill under a dark theme,
    // where the theme's light text disappears into the author's light box.
    const { resolveNodeStyles, textColor } = await import('@jarenjs/mermaid/styles');
    const darkThemeInk = { nodeText: '#e6e6e6', noteText: '#e6e6e6', noteFill: '#3b3b26' };
    const styles = (source) => resolveNodeStyles({
      classDefs: [{ name: 'c', styles: source }],
      classes: [{ node: 'N', name: 'c' }],
    }).get('N');

    assert.strictEqual(textColor(styles('fill:#dcfce7'), darkThemeInk), '#1f2020',
      'a pale fill takes dark ink even under a dark theme');
    assert.strictEqual(textColor(styles('fill:#14532d'), darkThemeInk), '#ffffff',
      'a deep fill takes light ink even under a light theme');
    assert.strictEqual(textColor(styles('fill:#dcfce7,color:#f0f'), darkThemeInk), '#f0f',
      'an explicit color always wins');
    assert.strictEqual(textColor(styles('stroke:#f00'), darkThemeInk), null,
      'a style that sets no fill keeps the theme ink');
  });

  it('leaves a themed fill following the theme', async () => {
    // `note` fill and ink are both theme tokens, so they move together and
    // must NOT be second-guessed by luminance.
    const { resolveNodeStyles, textColor } = await import('@jarenjs/mermaid/styles');
    const tokens = { noteText: '#e6e6e6', noteFill: 'var(--warn-soft, #fef3c7)' };
    const styles = resolveNodeStyles({ classes: [{ node: 'N', name: 'note' }] }).get('N');
    assert.strictEqual(textColor(styles, tokens), '#e6e6e6');
  });

  it('ignores a fill it cannot reason about', async () => {
    const { isHexColor } = await import('@jarenjs/core/color');
    assert.strictEqual(isHexColor('#abc'), true);
    assert.strictEqual(isHexColor('#a1b2c3'), true);
    assert.strictEqual(isHexColor('var(--x, #fff)'), false);
    assert.strictEqual(isHexColor('rebeccapurple'), false);
    assert.strictEqual(isHexColor(undefined), false);
  });
});
