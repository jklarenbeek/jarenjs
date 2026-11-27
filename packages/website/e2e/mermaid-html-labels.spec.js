//@ts-check
/**
 * @file Mermaid's HTML labels in a real engine. A host that passes
 * `htmlLabels: true` gets flowchart and state labels as HTML inside a
 * `foreignObject`, sized by the advance table rather than by the browser, so
 * what only an engine can show is how it lays that HTML out: each label
 * centred on its node, edge label background and subgraph title band, no
 * wider than its box, painted in the host's text token in light and dark —
 * and all of it still true once the reader has zoomed and panned. The
 * diagrams are rendered both as the SSR string and by the live DOM renderer,
 * and the theme flips the way the site flips it, on the root's `dark` class.
 */
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { compileMermaid } from '@jarenjs/mermaid';

const root = fileURLToPath(new URL('../../../', import.meta.url));

const FLOWCHART = 'flowchart LR\n  subgraph S [Pipeline stage]\n    A[Start] -->|go| B("one<br/>two")\n  end\n'
  + '  B --> C{Decide}\n  C -->|yes| D([Done])';
const STATE = 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Review : submit\n  Review --> [*]';
const HOST = { theme: 'host', htmlLabels: true };

/** The output files of a bundle of `contents`, by extension. */
async function bundle(contents, format = undefined) {
  const result = await build({
    stdin: { contents, resolveDir: root }, bundle: true, write: false, outdir: 'out',
    platform: 'browser', logLevel: 'silent', ...(format === undefined ? {} : { format }),
  });
  const of = (ext) => result.outputFiles.find((f) => f.path.endsWith(ext))?.text ?? '';
  return { css: of('.css'), js: of('.js') };
}

let tokensCss = '';
let bareCss = '';
let runtime = '';
test.beforeAll(async () => {
  tokensCss = (await bundle("import '@jarenjs/view/styles/tokens.css'; import '@jarenjs/mermaid/styles/mermaid.css';")).css;
  bareCss = (await bundle("import '@jarenjs/mermaid/styles/mermaid.css';")).css;
  runtime = (await bundle("import { createMermaidRenderer } from '@jarenjs/mermaid';\n"
    + "import { attachInteractiveDiagram } from '@jarenjs/mermaid/interactive';\n"
    + 'window.mermaidHost = { createMermaidRenderer, attachInteractiveDiagram };', 'iife')).js;
});

test.beforeEach(async ({ page }) => page.emulateMedia({ reducedMotion: 'reduce' }));

/**
 * A host page: the stylesheet, one figure holding each diagram's SSR string
 * (`#ssr-<i>`) and one the live DOM renderer fills (`#dom-<i>`), every
 * figure made zoomable by the interactive layer.
 */
async function hostPage(page, css, sources, extraCss = '') {
  const ssr = sources.map((source, i) =>
    `<div class="figure" id="ssr-${i}">${compileMermaid(source, HOST).toSvgString()}</div>`).join('');
  const dom = sources.map((_, i) => `<div class="figure" id="dom-${i}"></div>`).join('');
  await page.setContent(`<!doctype html><html><head><style>${css}${extraCss}</style></head><body>${ssr}${dom}</body></html>`);
  await page.addScriptTag({ content: runtime });
  await page.evaluate(({ sources, options }) => {
    const host = /** @type {any} */ (window).mermaidHost;
    sources.forEach((source, i) => {
      host.createMermaidRenderer({ container: document.getElementById(`dom-${i}`), document, ...options })(source);
    });
    for (const fig of document.querySelectorAll('.figure')) host.attachInteractiveDiagram(fig);
  }, { sources, options: HOST });
}

/**
 * Every HTML label of one figure, measured on screen: the union of its line
 * blocks (the text, not the flex box that fills the `foreignObject`), the
 * box it is centred in, and its computed colour beside what the host's
 * `--fg` resolves to.
 */
async function labelsOf(page, id) {
  return page.evaluate((figId) => {
    const fig = /** @type {Element} */ (document.getElementById(figId));
    const svg = /** @type {SVGSVGElement} */ (fig.querySelector('svg'));
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    const probe = document.createElement('div');
    fig.appendChild(probe);
    probe.style.color = 'var(--fg, transparent)';
    const fg = getComputedStyle(probe).color;
    probe.remove();
    // a shape's geometry on screen without its stroke, which Firefox's
    // getBoundingClientRect counts and Chromium's and WebKit's do not
    const fillBox = (/** @type {SVGGraphicsElement} */ el) => {
      const b = el.getBBox();
      const m = /** @type {DOMMatrix} */ (el.getScreenCTM());
      const a = new DOMPoint(b.x, b.y).matrixTransform(m);
      const z = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(m);
      return { left: a.x, top: a.y, width: z.x - a.x, height: z.y - a.y };
    };
    return [...fig.querySelectorAll('foreignObject')].map((fo) => {
      const div = /** @type {HTMLElement} */ (fo.firstElementChild);
      const kind = div.classList[0];
      const lines = [...div.children].map((c) => c.getBoundingClientRect());
      const text = {
        left: Math.min(...lines.map((r) => r.left)), right: Math.max(...lines.map((r) => r.right)),
        top: Math.min(...lines.map((r) => r.top)), bottom: Math.max(...lines.map((r) => r.bottom)),
      };
      const shape = kind === 'mm-label' ? fo.parentElement?.querySelector(':scope > .mm-node-shape')
        : kind === 'mm-edge-label' ? fo.parentElement?.querySelector(':scope > .mm-edge-label-bg')
          : fo.parentElement?.querySelector(':scope > .mm-cluster-rect');
      const r = fillBox(/** @type {SVGGraphicsElement} */ (shape));
      // a subgraph title is centred in the 20-unit band at the top of its frame
      const box = kind === 'mm-cluster-label'
        ? { cx: r.left + r.width / 2, cy: r.top + 10 * scale, w: r.width }
        : { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width };
      const foBox = fo.getBoundingClientRect();
      return {
        kind, label: div.textContent, xhtml: div.namespaceURI, lines: lines.length,
        dx: (text.left + text.right) / 2 - box.cx, dy: (text.top + text.bottom) / 2 - box.cy,
        width: text.right - text.left, height: text.bottom - text.top, boxWidth: Math.min(box.w, foBox.width),
        color: getComputedStyle(div).color, lineColor: getComputedStyle(/** @type {Element} */ (div.firstElementChild)).color,
        fg, overflow: getComputedStyle(fo).overflow, scale,
      };
    });
  }, id);
}

const FIGURES = ['ssr-0', 'dom-0', 'ssr-1', 'dom-1'];
/** The labels each figure draws: flowchart 4 nodes + 2 edge labels + 1 title; state 2 states + 1 transition. */
const COUNTS = { 'ssr-0': 7, 'dom-0': 7, 'ssr-1': 3, 'dom-1': 3 };

/** Every label of every figure centred within 1 px, inside its box, in the host's text colour. */
async function expectLabelsHold(page, when) {
  for (const id of FIGURES) {
    const labels = await labelsOf(page, id);
    expect(labels.length, `${id} ${when}: labels`).toBe(COUNTS[id]);
    for (const l of labels) {
      const at = `${id} ${when}: ${l.kind} "${l.label}"`;
      expect(l.xhtml, at).toBe('http://www.w3.org/1999/xhtml');
      expect(l.width, `${at} is laid out`).toBeGreaterThan(0);
      expect(Math.abs(l.dx), `${at} horizontal centre`).toBeLessThanOrEqual(1);
      expect(Math.abs(l.dy), `${at} vertical centre`).toBeLessThanOrEqual(1);
      expect(l.width, `${at} fits its box`).toBeLessThanOrEqual(l.boxWidth);
      // the HTML scales with the diagram: 14px lines at line height 1.2, times the zoom
      expect(Math.abs(l.height - l.lines * 14 * 1.2 * l.scale), `${at} scales with the zoom`).toBeLessThanOrEqual(1);
      expect(l.color, `${at} colour`).toBe(l.fg);
      expect(l.lineColor, `${at} line colour`).toBe(l.fg);
    }
  }
}

/** Each figure's `viewBox`. */
const viewBoxes = (page) => page.evaluate((ids) =>
  ids.map((id) => document.querySelector(`#${id} svg`)?.getAttribute('viewBox')), FIGURES);

test('HTML labels are centred, fit their boxes and take the host colour, light and dark, zoomed and panned', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await hostPage(page, tokensCss, [FLOWCHART, STATE]);
  // the two-line node draws two line blocks
  expect((await labelsOf(page, 'ssr-0')).find((l) => l.label === 'onetwo')?.lines).toBe(2);

  const lightFg = (await labelsOf(page, 'ssr-0'))[0].fg;
  await expectLabelsHold(page, 'light');
  await page.evaluate(() => document.documentElement.classList.toggle('dark', true));
  const darkFg = (await labelsOf(page, 'ssr-0'))[0].fg;
  expect(darkFg, 'the dark token is another colour').not.toBe(lightFg);
  await expectLabelsHold(page, 'dark');

  const home = await viewBoxes(page);
  for (const id of FIGURES) {
    await page.locator(`#${id}`).focus();
    await page.keyboard.press('+');
    await page.keyboard.press('+');
  }
  const zoomed = await viewBoxes(page);
  zoomed.forEach((box, i) => expect(box, `${FIGURES[i]} zoomed`).not.toBe(home[i]));
  expect((await labelsOf(page, 'ssr-0'))[0].scale, 'the zoom scales the labels').toBeGreaterThan(1.5);
  await expectLabelsHold(page, 'dark, zoomed');

  for (const id of FIGURES) {
    await page.locator(`#${id}`).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
  }
  const panned = await viewBoxes(page);
  panned.forEach((box, i) => expect(box, `${FIGURES[i]} panned`).not.toBe(zoomed[i]));
  await expectLabelsHold(page, 'dark, zoomed and panned');
  await page.evaluate(() => document.documentElement.classList.toggle('dark', false));
  await expectLabelsHold(page, 'light, zoomed and panned');
  expect(errors).toEqual([]);
});

test('without the host tokens a host-themed label keeps the colour its link carries', async ({ page }) => {
  // the colour check above compares against --fg, so it must be able to fail
  await hostPage(page, bareCss, [FLOWCHART]);
  const labels = await labelsOf(page, 'ssr-0');
  expect(labels.length).toBe(7);
  for (const l of labels) {
    expect(l.fg).toBe('rgba(0, 0, 0, 0)');
    expect(l.color, l.label ?? '').toBe(l.kind === 'mm-edge-label' ? 'rgb(51, 51, 51)' : 'rgb(31, 32, 32)');
  }
});

test('a host font wider than the advance table overflows its box evenly, on one line, unclipped', async ({ page }) => {
  // MERMAID-FORMAT §7: the label is never wrapped again by the browser and
  // overflows rather than clips when the host's font runs wider than the table.
  await hostPage(page, tokensCss, ['flowchart LR\n  A[Start here] --> B[End]'],
    '.mermaid .mm-label { letter-spacing: 0.6em; }');
  for (const id of ['ssr-0', 'dom-0']) {
    const [start] = await labelsOf(page, id);
    expect(start.label).toBe('Start here');
    expect(start.width, `${id}: the host font runs wider than the box`).toBeGreaterThan(start.boxWidth);
    expect(start.lines, `${id}: one line`).toBe(1);
    expect(start.height, `${id}: one line high`).toBeLessThan(14 * 1.2 + 1);
    expect(start.overflow, `${id}: the foreignObject does not clip`).toBe('visible');
    expect(Math.abs(start.dx), `${id}: still centred`).toBeLessThanOrEqual(1);
    expect(Math.abs(start.dy), `${id}: still centred`).toBeLessThanOrEqual(1);
  }
});
