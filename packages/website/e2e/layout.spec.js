//@ts-check
/**
 * @file The two page-level invariants a screenshot shows instantly and no
 * other spec asserts: ONE content edge, and a studio frame that fits the
 * viewport.
 *
 * Both failed silently for as long as the packaged surfaces have been
 * mounted. `@jarenjs/studio`, `@jarenjs/play` and `@jarenjs/calc` render a
 * component root straight into `<main>`, so nothing gave them the site's
 * gutter: on a phone they ran flush to the screen edge, and on a desktop
 * they ignored the 72rem column the header and the footer keep (DESIGN §3).
 * And with no bounded height their `overflow: auto` rails never engaged —
 * Play's example list drove the page to 2086px on a 900px-tall viewport
 * while the project IDE left a 236px dead band above the footer.
 *
 * Neither shows up in a page-overflow assertion: a full-bleed page is
 * exactly as wide as the viewport, and a page that is too TALL is what
 * scrolling is for. The evidence has to be the edge itself.
 *
 * The whole file is TWO tests — one per viewport, each walking the routes
 * in a single page context the way mobile.spec.js does. A test per route
 * reads better and was written that way first, but it multiplied the
 * matrix by three engines into enough concurrent browsers to push the
 * neighbouring OPFS and navigation specs past their 30s budgets. A spec
 * that fails its neighbours is not evidence, and `#/data` is left out of
 * the walk for the same reason: it opens the wasm store, its edge is a
 * site `.page container` that was never at risk, and data.spec.js and
 * mobile.spec.js both already cover it.
 */
import { test, expect } from '@playwright/test';

/** Every route that renders a page under the site chrome, minus `#/data`. */
const PAGES = ['/', 'play', 'project', 'flow', 'charts', 'benchmarks', 'docs', 'calculator', 'game'];

/** Settle: the hash route renders, then the boundaries mount. */
async function open(page, route) {
  await page.evaluate((r) => { window.location.hash = r === '/' ? '#/' : `#/${r}`; }, route);
  await expect(page.locator('main.main')).toBeVisible();
  await page.waitForTimeout(500);
}

/**
 * The x of the header's content — the one edge every page must share, and
 * the only one that is measured rather than assumed.
 */
function edges(page) {
  return page.evaluate(() => {
    const inner = document.querySelector('.header-inner');
    const headerX = Math.round(inner.getBoundingClientRect().left)
      + Math.round(parseFloat(getComputedStyle(inner).paddingLeft));
    // the page's own root element inside <main>, component-provided or not
    const root = document.querySelector('.main > *');
    return {
      headerX,
      pageX: Math.round(root.getBoundingClientRect().left),
      // the component roots, when this route has one
      frames: ['.jplay', '.jstudio', '.calc'].map((sel) => {
        const el = document.querySelector(sel);
        return el === null ? null : { sel, x: Math.round(el.getBoundingClientRect().left) };
      }).filter(Boolean),
    };
  });
}

/** Assert the shared edge on whatever route is currently open. */
async function expectOneEdge(page, route) {
  const m = await edges(page);
  // the page root either IS the container (carrying its own gutter) or
  // holds one; either way nothing it renders may start left of the page
  expect(m.pageX, `#/${route}: the page root starts left of the viewport`)
    .toBeGreaterThanOrEqual(0);
  for (const frame of m.frames) {
    expect(frame.x, `#/${route}: ${frame.sel} ignores the ${m.headerX}px content edge`)
      .toBeGreaterThanOrEqual(m.headerX);
  }
}

test('desktop: one content edge, studio frames that fit, a rail that scrolls itself', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  for (const route of PAGES) {
    await open(page, route);
    await expectOneEdge(page, route);

    if (route === 'play' || route === 'project') {
      const m = await page.evaluate(() => {
        const footer = document.querySelector('.footer');
        const frame = document.querySelector('.jplay') ?? document.querySelector('.jstudio');
        return {
          docH: document.scrollingElement.scrollHeight,
          vh: window.innerHeight,
          // the gap the frame leaves between itself and the footer
          gap: Math.round(footer.getBoundingClientRect().top
            - frame.getBoundingClientRect().bottom),
        };
      });
      // an app frame is the viewport: no page scroll…
      expect(m.docH, `#/${route}: the page is ${m.docH}px on a ${m.vh}px viewport`)
        .toBeLessThanOrEqual(m.vh + 1);
      // …and no white band under the frame either (the studio page's own
      // bottom padding is the only thing allowed between them)
      expect(m.gap, `#/${route}: ${m.gap}px of dead space above the footer`)
        .toBeLessThanOrEqual(48);
    }

    if (route === 'docs') {
      const m = await page.evaluate(() => {
        const side = document.querySelector('.docs-side');
        return {
          railScrolls: side.scrollHeight > side.clientHeight + 1,
          railH: Math.round(side.getBoundingClientRect().height),
          vh: window.innerHeight,
        };
      });
      // 33 section links + 20 README buttons made the left column 1907px
      // tall next to a 297px article, and the grid row took the taller of
      // the two: one short section pushed the page past 2000px
      expect(m.railScrolls, 'the rail is taller than its box, so it must scroll internally')
        .toBe(true);
      expect(m.railH, `the rail is ${m.railH}px on a ${m.vh}px viewport`)
        .toBeLessThanOrEqual(m.vh);
    }
  }
});

test('phone: one content edge, and the docs article before the package list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  for (const route of PAGES) {
    await open(page, route);
    await expectOneEdge(page, route);

    if (route === 'docs') {
      const m = await page.evaluate(() => ({
        article: document.querySelector('.docs-article').getBoundingClientRect().top + window.scrollY,
        readmes: document.querySelector('.docs-readmes').getBoundingClientRect().top + window.scrollY,
      }));
      // the reader must reach the section, not twenty README buttons
      expect(m.article, 'the docs article must come before the README list')
        .toBeLessThan(m.readmes);
    }
  }
});
