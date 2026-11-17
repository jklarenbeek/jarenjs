//@ts-check
/**
 * @file The host token vocabulary in a real browser. The site's computed
 * tokens are the exported file's, light and dark, so the site keeps no copy
 * that overrides it; and a host page holding only the exported file, a
 * component stylesheet and a host-themed diagram paints the diagram in the
 * host's colours, in every dark selection the file documents, never in the
 * fallback palette each link carries.
 */
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileMermaid } from '@jarenjs/mermaid';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const exported = readFileSync(`${root}packages/view/styles/tokens.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the exported rule with exactly this selector. */
function block(selector) {
  const start = exported.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = exported.slice(exported.indexOf('{', start) + 1, exported.indexOf('}', start));
  return body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]);
}
const INVARIANT = block(':root');
const LIGHT = [...block(':root, .light, [data-theme="light"]'), ...INVARIANT];
const DARK = [...block('.dark, [data-theme="dark"]'), ...INVARIANT];

/** The property a token is read back through, by what it holds. */
const probeOf = (name) => (/^--radius/.test(name) ? 'border-top-left-radius' : /^--(font|mono)$/.test(name) ? 'font-family' : /^--space-/.test(name) ? 'width' : 'color');

/**
 * Every token whose computed value on the page differs from the value the
 * exported file gives it: each is resolved through a real property on a
 * probe, once as `var(--name)` and once as the file's literal value.
 */
async function differing(page, tokens) {
  return page.evaluate((rows) => {
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    const resolve = (prop, value) => { probe.style.cssText = `${prop}: ${value}`; return getComputedStyle(probe).getPropertyValue(prop); };
    const out = rows.filter(([name, value, prop]) => resolve(prop, `var(${name})`) !== resolve(prop, value)).map(([name]) => name);
    probe.remove();
    return out;
  }, tokens.map(([name, value]) => [name, value, probeOf(name)]));
}

test.beforeEach(async ({ page }) => page.emulateMedia({ reducedMotion: 'reduce' }));

test('the site computes every exported token as the file defines it, light and dark', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('main');
  expect(LIGHT.length).toBeGreaterThanOrEqual(30);
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  expect(await differing(page, LIGHT)).toEqual([]);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  expect(await differing(page, DARK)).toEqual([]);
});

/** The CSS a bundler emits for a host entry that imports these stylesheets. */
async function bundledCss(...sheets) {
  const result = await build({
    stdin: { contents: sheets.map((s) => `import '${s}';`).join('\n'), resolveDir: root },
    bundle: true, write: false, outdir: 'out', platform: 'browser', logLevel: 'silent',
  });
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'));
  expect(css, 'the bundle keeps the stylesheet imports').toBeTruthy();
  return /** @type {import('esbuild').OutputFile} */ (css).text;
}

const diagram = compileMermaid('flowchart LR\n  A[a] --> B[b]', { theme: 'host' }).toSvgString();

/** The painted fill and stroke of the first node, and what the host's tokens resolve to. */
async function nodePaint(page, css, rootAttributes = '') {
  await page.setContent(`<!doctype html><html${rootAttributes}><head><style>${css}</style></head><body>${diagram}</body></html>`);
  return page.evaluate(() => {
    const shape = /** @type {Element} */ (document.querySelector('.mm-node-shape'));
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    const token = (name) => { probe.style.color = `var(${name}, transparent)`; return getComputedStyle(probe).color; };
    return { fill: getComputedStyle(shape).fill, stroke: getComputedStyle(shape).stroke, host: { fill: token('--accent-soft'), stroke: token('--accent') } };
  });
}

test('a host page with only the exported tokens paints a host-themed diagram in its colours', async ({ page }) => {
  const fallback = 'rgb(219, 234, 254)'; // the link's own #dbeafe
  const tokens = await bundledCss('@jarenjs/view/styles/tokens.css', '@jarenjs/mermaid/styles/mermaid.css');
  const paints = {
    light: await nodePaint(page, tokens),
    dark: await nodePaint(page, tokens, ' class="dark"'),
    attribute: await nodePaint(page, tokens, ' data-theme="dark"'),
  };
  for (const [selection, paint] of Object.entries(paints)) {
    expect(paint.fill, selection).toBe(paint.host.fill);
    expect(paint.stroke, selection).toBe(paint.host.stroke);
  }
  expect(paints.dark.fill).not.toBe(fallback);
  expect(paints.attribute.fill).toBe(paints.dark.fill);
  expect(paints.light.fill).not.toBe(paints.dark.fill);

  // without the tokens the same diagram keeps the fallback: the check above can fail
  const bare = await nodePaint(page, await bundledCss('@jarenjs/mermaid/styles/mermaid.css'), ' class="dark"');
  expect(bare.fill).toBe(fallback);

  // the system-scheme file follows the reader's scheme, and yields to an explicit light root
  const system = await bundledCss('@jarenjs/view/styles/tokens-system.css', '@jarenjs/mermaid/styles/mermaid.css');
  await page.emulateMedia({ colorScheme: 'dark' });
  expect((await nodePaint(page, system)).fill).toBe(paints.dark.fill);
  expect((await nodePaint(page, system, ' class="light"')).fill).toBe(paints.light.fill);
  expect((await nodePaint(page, system, ' data-theme="light"')).fill).toBe(paints.light.fill);
  expect((await nodePaint(page, tokens)).fill, 'the plain file never turns dark on its own').toBe(paints.light.fill);
  await page.emulateMedia({ colorScheme: 'light' });
  expect((await nodePaint(page, system)).fill).toBe(paints.light.fill);
});

/** One reading of each component's own chrome, by component. */
const CHROME = `<div class="calc"></div><article class="md"></article><div class="mermaid"></div>
<div class="chart"></div><div class="chart-tooltip"></div><div class="jc-viewport"></div><span class="js-badge" data-badge="view"></span>`;

/** What each component's stylesheet resolves on its chrome, under the given root and subtree. */
async function chrome(page, css, rootAttributes = '', subtree = '') {
  await page.setContent(`<!doctype html><html${rootAttributes}><head><style>${css}</style></head><body><section${subtree}>${CHROME}</section></body></html>`);
  return page.evaluate(() => {
    const at = (selector) => getComputedStyle(/** @type {Element} */ (document.querySelector(selector)));
    return {
      calc: at('.calc').getPropertyValue('--calc-bg').trim(),
      md: at('.md').getPropertyValue('--md-code-bg').trim(),
      mermaid: at('.mermaid').getPropertyValue('--mm-node-fill').trim(),
      charts: at('.chart').getPropertyValue('--chart-text').trim(),
      chartsTooltip: at('.chart-tooltip').backgroundColor,
      collection: at('.jc-viewport').backgroundColor,
      studio: at('.js-badge').backgroundColor,
    };
  });
}

test('component chrome follows every dark selection the token files honour', async ({ page }) => {
  const sheets = ['@jarenjs/calc/styles/calc.css', '@jarenjs/md/styles/md.css', '@jarenjs/mermaid/styles/mermaid.css',
    '@jarenjs/charts/styles/charts.css', '@jarenjs/collection/styles/collection.css', '@jarenjs/studio/styles/studio.css'];
  const tokens = await bundledCss('@jarenjs/view/styles/tokens.css', ...sheets);
  const system = await bundledCss('@jarenjs/view/styles/tokens-system.css', ...sheets);
  await page.emulateMedia({ colorScheme: 'light' });
  const light = await chrome(page, tokens);
  const dark = await chrome(page, tokens, ' class="dark"');
  for (const key of Object.keys(light)) expect(dark[key], `${key} has a dark chrome`).not.toBe(light[key]);
  expect(await chrome(page, tokens, ' data-theme="dark"'), 'the attribute').toEqual(dark);
  expect(await chrome(page, system), 'the system file under a light scheme').toEqual(light);
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await chrome(page, system), 'the system file under a dark scheme').toEqual(dark);
  expect(await chrome(page, system, ' class="light"'), 'an explicit light root').toEqual(light);
  expect(await chrome(page, system, ' data-theme="light"'), 'an explicit light root attribute').toEqual(light);
  expect(await chrome(page, system, '', ' data-theme="light"'), 'a light subtree').toEqual(light);
  expect(await chrome(page, tokens), 'the plain file never turns dark on its own').toEqual(light);
});
