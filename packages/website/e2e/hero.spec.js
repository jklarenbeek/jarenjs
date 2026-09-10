//@ts-check
/**
 * @file The homepage hero really dispatches, and really stops moving.
 *
 * Two claims need a real engine. The first is that the stage list a
 * reader sees came out of a dispatch that ran in THEIR tab: this spec
 * changes the input and asserts the rendered outcome changed with it —
 * a value typed here appearing in the envelope on screen is something no
 * recorded timeline could produce. The second is the motion contract: the
 * stages arrive in the pipeline's order with a staggered entrance and the
 * focus glides between them, and under an emulated `reduce` NONE of that
 * exists — every stage is on screen at once and stepping is instant.
 *
 * Nothing here hardcodes a code, a message or a value the dispatch
 * produced; each is read off the page and asserted against what the page
 * showed before. The preference is emulated on the page rather than
 * declared on the context because it has to hold before the first paint,
 * which is when the hero's stylesheet decides whether anything moves.
 */
import { test, expect } from '@playwright/test';

/** Home with the hero's first dispatch settled, under a stated preference.
 * @param {import('@playwright/test').Page} page
 * @param {'reduce' | 'no-preference'} reducedMotion
 */
async function openHero(page, reducedMotion) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion });
  await page.goto('/');
  await expect(page.locator('.hero-demo')).toBeVisible();
  await expect(page.locator('.hero-stage')).toHaveCount(5);
  await expect(page.locator('.hero-artifact')).not.toHaveText('');
}

const stages = (page) => page.locator('.hero-stage');
const artifact = (page) => page.locator('.hero-artifact');
const focused = (page) => page.locator('.hero-stage.is-focus');

test('the hero stacks at the shared tablet breakpoint without widening the page', async ({ page }) => {
  await openHero(page, 'reduce');
  for (const width of [1280, 1025, 1024, 901, 760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.locator('.hero-demo-grid').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(width > 1024 ? 2 : 1);
    expect(await page.evaluate(() => document.scrollingElement.scrollWidth)).toBe(width);
  }
});

/** The editor's text, replaced wholesale — a reader retyping the document. */
async function typeInput(page, text) {
  const editor = page.locator('textarea.hero-editor');
  await editor.fill(text);
  // the commit is on change, which needs the blur a real reader gives it
  await editor.blur();
}

test.describe('the dispatch is real', function () {

  test('a value typed into the input comes back inside the rendered outcome', async function ({ page }) {
    await openHero(page, 'no-preference');
    const before = await artifact(page).textContent();
    const settled = JSON.parse(before ?? '{}');
    expect(settled.ok, 'the starting input is one the document accepts').toBe(true);

    // keep every member the document requires; change only the one this
    // test can recognise coming back
    const edited = { ...settled.value, sku: 'QQR-9090' };
    await typeInput(page, JSON.stringify({
      sku: edited.sku, title: 'Typed in a real browser', price: 42,
    }, null, 2));
    await page.locator('.hero-controls button', { hasText: 'Dispatch' }).click();

    await expect(artifact(page)).toContainText('QQR-9090');
    const after = JSON.parse((await artifact(page).textContent()) ?? '{}');
    expect(after.ok).toBe(true);
    expect(after.value.sku).toBe('QQR-9090');
    expect(after.meta.trace, 'a new dispatch, not the old envelope').not.toBe(settled.meta.trace);
  });

  test('"break it" settles a real refusal: the code is the binding\'s, and downstream stages say they never ran', async function ({ page }) {
    await openHero(page, 'no-preference');
    await expect(stages(page).filter({ hasText: 'not reached' })).toHaveCount(0);

    // A late font swap can move this control between pointerdown and up.
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.seg-btn', { hasText: 'Break it' }).click();
    await expect(artifact(page)).toContainText('"ok": false');

    const settled = JSON.parse((await artifact(page).textContent()) ?? '{}');
    expect(settled.kind).toBe('contract');
    expect(settled.error.code, 'a taxonomy code the page never wrote down').toMatch(/^JC\d{4}$/);
    expect(Array.isArray(settled.error.details)).toBe(true);
    // the refusal is rendered where it happened, and the steps after it
    // are marked as never reached rather than shown as passed
    const refusedAt = stages(page).filter({ hasText: 'Validate input' });
    await expect(refusedAt).toHaveClass(/is-refused/);
    await expect(refusedAt).toContainText(settled.error.code);
    await expect(page.locator('.hero-stage.is-skipped')).toHaveCount(2);
  });
});

test.describe('with motion allowed', function () {

  test('the stages arrive in the pipeline\'s order, staggered, on the compositor', async function ({ page }) {
    await openHero(page, 'no-preference');
    const delays = await stages(page).evaluateAll((nodes) => nodes.map((el) => {
      const style = getComputedStyle(el);
      return { name: style.animationName, delay: parseFloat(style.animationDelay) };
    }));
    expect(delays.every((s) => s.name === 'stage-in'), 'every stage has the entrance').toBe(true);
    expect(delays[0].delay).toBe(0);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i].delay, 'each stage waits for the one before it').toBeGreaterThan(delays[i - 1].delay);
    }
    // the focus lift is transform-only: nothing here can cost a layout
    const props = await focused(page).locator('.hero-stage-btn')
      .evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(props.split(',').map((p) => p.trim())).toEqual(['transform']);
  });

  test('a re-dispatch mounts a new list, so the entrance plays again', async function ({ page }) {
    await openHero(page, 'no-preference');
    await page.waitForTimeout(1_200);
    expect(await stages(page).first().evaluate((el) => el.getAnimations().length),
      'the first arrival has finished playing').toBe(0);

    await page.locator('.seg-btn', { hasText: 'Break it' }).click();
    await expect(artifact(page)).toContainText('"ok": false');
    await expect.poll(async () => stages(page).last().evaluate((el) => el.getAnimations().length),
      { timeout: 3_000 }).toBeGreaterThan(0);
  });

  test('the focus travels: stepping moves the lift from one stage to the next', async function ({ page }) {
    await openHero(page, 'no-preference');
    const lifted = () => focused(page).locator('.hero-stage-btn')
      .evaluate((el) => getComputedStyle(el).transform);
    // the settled outcome is focused first, and it is the stage that moved
    await expect(focused(page)).toHaveCount(1);
    expect(await lifted(), 'the focused stage sits off its resting place').not.toBe('none');
    const title = await focused(page).locator('.hero-stage-title').textContent();

    await page.locator('.hero-step').click();
    await expect(focused(page)).toHaveCount(1);
    expect(await focused(page).locator('.hero-stage-title').textContent()).not.toBe(title);
    await expect.poll(lifted, { timeout: 3_000 }).not.toBe('none');
    // and the artifact panel follows the focus, so stepping is reading
    await expect(artifact(page)).not.toHaveText('');
  });
});

test.describe('with reduced motion asked for', function () {

  test('nothing auto-plays: every stage is on screen at once, in its final state', async function ({ page }) {
    await openHero(page, 'reduce');
    const state = await stages(page).evaluateAll((nodes) => nodes.map((el) => {
      const style = getComputedStyle(el);
      return {
        animation: style.animationName,
        opacity: style.opacity,
        transform: style.transform,
        running: el.getAnimations().length,
      };
    }));
    expect(state).toHaveLength(5);
    for (const stage of state) {
      expect(stage.animation).toBe('none');
      expect(stage.opacity).toBe('1');
      expect(stage.transform).toBe('none');
      expect(stage.running).toBe(0);
    }
    // the stage buttons hold their resting place too: no lift, nothing to
    // transition back from
    expect(await page.locator('.hero-stage-btn').evaluateAll(
      (nodes) => nodes.every((el) => getComputedStyle(el).transitionDuration === '0s'))).toBe(true);
  });

  test('stepping jumps: the focus is on the next stage with no animation in flight', async function ({ page }) {
    await openHero(page, 'reduce');
    const title = await focused(page).locator('.hero-stage-title').textContent();
    await page.locator('.hero-step').click();
    // no poll and no wait: instant means the very next read is the answer
    const after = await focused(page).evaluate((el) => ({
      title: el.querySelector('.hero-stage-title')?.textContent,
      running: el.getAnimations().length,
      transform: getComputedStyle(el.querySelector('.hero-stage-btn')).transform,
    }));
    expect(after.title).not.toBe(title);
    expect(after.running).toBe(0);
    expect(after.transform, 'the focus is marked, not moved').toBe('none');
    expect(await page.locator('.hero-stage').evaluateAll(
      (nodes) => nodes.reduce((n, el) => n + el.getAnimations().length, 0))).toBe(0);
  });

  test('a re-dispatch still settles, and still moves nothing', async function ({ page }) {
    await openHero(page, 'reduce');
    await page.locator('.seg-btn', { hasText: 'Break it' }).click();
    await expect(artifact(page)).toContainText('"ok": false');
    await expect(stages(page)).toHaveCount(5);
    expect(await page.locator('.hero-stage, .hero-stage-btn').evaluateAll(
      (nodes) => nodes.reduce((n, el) => n + el.getAnimations().length, 0))).toBe(0);
  });
});
