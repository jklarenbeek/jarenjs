import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = await build({ stdin: { contents: "export { createSplitterWidget } from '@jarenjs/app';", resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SplitterTest' });

// Two panes with unequal floors around an `auto` handle track: the grid a host
// binds `-first`/`-rest` into. The layout is read from the engine, never typed.
async function setup(page, { axis = 'y', ratio = 0.5, min, max } = {}) {
  const tracks = 'minmax(240px, var(--s-ratio-first)) auto minmax(120px, var(--s-ratio-rest))';
  const style = axis === 'y' ? `height:407px;width:300px;grid-template-rows:${tracks}` : `width:407px;height:300px;grid-template-columns:${tracks}`;
  const handle = axis === 'y' ? 'height:12px' : 'width:12px';
  await page.setContent(`<div id="g" style="display:grid;${style}"><div></div><div id="h" tabindex="0" style="${handle};background:#888"></div><div></div></div>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(({ axis, ratio, min, max }) => {
    const widget = window.SplitterTest.createSplitterWidget({ action: 'split', grid: '#g', cssVar: '--s-ratio', min, max });
    window.commits = [];
    window.splitter = widget.mount(document.getElementById('h'), { ratio, axis }, (e) => window.commits.push(e.with));
  }, { axis, ratio, min, max });
}
const tracks = (page, axis = 'y') => page.evaluate((axis) => {
  const style = getComputedStyle(document.getElementById('g'));
  return (axis === 'y' ? style.gridTemplateRows : style.gridTemplateColumns).split(' ').map(parseFloat);
}, axis);

test.beforeEach(async ({ page }) => page.emulateMedia({ reducedMotion: 'reduce' }));

for (const axis of ['y', 'x']) {
  test(`unequal pane floors leave no empty space at either clamp end or the midpoint (axis ${axis})`, async ({ page }) => {
    await setup(page, { axis });
    const handle = page.locator('#h');
    await handle.focus();
    for (const key of [null, 'Home', 'End', 'ArrowLeft']) {
      if (key) await handle.press(key);
      const [first, bar, rest] = await tracks(page, axis);
      // the auto handle track keeps its own 12px: no free space leaks into it
      expect(bar, `${key}: ${first} ${bar} ${rest}`).toBeCloseTo(12, 1);
      expect(first + bar + rest).toBeCloseTo(407, 1);
      expect(first).toBeGreaterThanOrEqual(240 - 0.5);
      expect(rest).toBeGreaterThanOrEqual(120 - 0.5);
    }
  });
}

test('a pointer drag keeps the floors and fills the grid while live and after its commit', async ({ page }) => {
  await setup(page, { ratio: 0.5 });
  const box = await page.locator('#h').boundingBox();
  const grid = await page.locator('#g').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, grid.y + grid.height * 0.85, { steps: 4 });
  let [first, bar, rest] = await tracks(page);
  expect(bar).toBeCloseTo(12, 1);
  expect(first + bar + rest).toBeCloseTo(407, 1);
  expect(rest).toBeGreaterThanOrEqual(120 - 0.5);
  await page.mouse.up();
  expect(await page.evaluate(() => window.commits.length)).toBe(1);
  [first, bar, rest] = await tracks(page);
  expect(first + bar + rest).toBeCloseTo(407, 1);
  expect(first).toBeGreaterThan(240);
});

test('without floors the tracks split the free space by the ratio', async ({ page }) => {
  await page.setContent('<div id="g" style="display:grid;height:407px;width:300px;grid-template-rows:var(--s-ratio-first) 12px var(--s-ratio-rest)"><div></div><div id="h"></div><div></div></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.SplitterTest.createSplitterWidget({ action: 'split', grid: '#g', cssVar: '--s-ratio' })
    .mount(document.getElementById('h'), { ratio: 0.7, axis: 'y' }, () => {}));
  const [first, bar, rest] = await tracks(page);
  expect(bar).toBe(12);
  expect(first / (first + rest)).toBeCloseTo(0.7, 3);
});
