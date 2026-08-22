//@ts-check
/**
 * @file The site moves — and stops moving when the reader asks it to.
 *
 * DESIGN §6 binds three things a unit test cannot see: an entrance that
 * plays once per arrival, a card that rises in the first time it is
 * scrolled to, and a measured headline that counts up to the value the
 * renderer wrote. Each is real only in a real engine, and each is
 * REFUSED under `prefers-reduced-motion: reduce` — not slowed, not
 * shortened: nothing plays and every surface shows its final state on
 * first paint.
 *
 * The count-up's contract is the one worth stating: it borrows the
 * string the renderer already published and gives it back. So the
 * evidence is the element's own mutation record — intermediate values
 * happened, and the last one is character-for-character the value the
 * page rendered before the count began. Nothing here hardcodes a
 * measurement, so a re-run of the benchmarks cannot make this spec lie.
 */
import { test, expect } from '@playwright/test';

/** Home under an explicitly emulated preference, with the collected
 * content landed: the cards are a fetched artifact and their measured
 * lines arrive one turn later still. The viewport is set here rather
 * than declared, and the preference emulated on the page rather than
 * asked of the context, because both must hold before the first paint —
 * the install this spec measures happens in the site's first committed
 * frame.
 * @param {import('@playwright/test').Page} page
 * @param {'reduce' | 'no-preference'} reducedMotion
 */
async function openHome(page, reducedMotion) {
  // desktop, and short enough that the engine grid starts below the fold:
  // a card that has never been scrolled to is the pre-reveal evidence
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion });
  await page.goto('/');
  await expect(page.locator('main.main')).toBeVisible();
  await expect(page.locator('.engine-card').first()).toBeVisible();
  await expect(page.locator('.engine-perf').first()).not.toHaveText('');
  await page.waitForTimeout(600);
}

/** Record every text mutation of one element, from now on. */
async function watchText(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelectorAll(sel);
    const target = el[el.length - 1];
    window.__motionSeen = [];
    new MutationObserver(() => window.__motionSeen.push(target.textContent))
      .observe(target, { characterData: true, childList: true, subtree: true });
  }, selector);
}

const seenText = (page) => page.evaluate(() => window.__motionSeen);

/** The last engine card: 21 cards deep, so nothing has revealed it yet. */
const lastCard = (page) => page.locator('.engine-card').last();

test.describe('with motion allowed', function () {

  test('a card below the fold waits at its pre-view state, then rises to its final one', async function ({ page }) {
    await openHome(page, 'no-preference');
    const card = lastCard(page);
    const before = await card.evaluate((el) => {
      const style = getComputedStyle(el);
      return { classes: el.className, opacity: style.opacity, transform: style.transform };
    });
    expect(before.classes, 'an unseen card carries the pre-view class only').toContain('reveal');
    expect(before.classes).not.toContain('reveal-in');
    expect(Number(before.opacity), 'and is not painted yet').toBeLessThan(0.01);
    expect(before.transform, 'held below its resting place').not.toBe('none');

    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveClass(/reveal-in/);
    // the transition is compositor-only: opacity and transform, nothing else
    const props = await card.evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(props.split(',').map((p) => p.trim()).sort()).toEqual(['opacity', 'transform']);
    await expect.poll(async () => card.evaluate((el) => getComputedStyle(el).opacity),
      { timeout: 5_000 }).toBe('1');
    await expect.poll(async () => card.evaluate((el) => getComputedStyle(el).transform),
      { timeout: 5_000 }).toBe('none');
  });

  test('a measured headline counts up and lands on exactly the string the renderer wrote', async function ({ page }) {
    await openHome(page, 'no-preference');
    // read the published value BEFORE anything has counted it: the card is
    // below the fold, so the renderer's string is what stands there
    const headline = page.locator('.engine-perf').last();
    const published = await headline.textContent();
    expect(published?.length, 'the last card carries a measured line').toBeGreaterThan(0);

    await watchText(page, '.engine-perf');
    await lastCard(page).scrollIntoViewIfNeeded();
    await expect(headline).toHaveClass(/counting/);
    await expect(headline).not.toHaveClass(/counting/, { timeout: 5_000 });

    const seen = await seenText(page);
    expect(seen.length, 'the value was animated, not simply re-rendered').toBeGreaterThan(3);
    expect(seen.some((t) => t !== published), 'intermediate values really happened').toBe(true);
    expect(seen[seen.length - 1]).toBe(published);
    expect(await headline.textContent()).toBe(published);
  });

  test('nothing is ever lost to the motion: a jumped scroll and an opened disclosure still arrive', async function ({ page }) {
    // the failure this guards is the worst one motion can cause — a card
    // stuck at opacity 0 with its content unreachable. Two ways to
    // provoke it: jump the viewport past a card in strides no observation
    // cycle can catch, and reveal content that had no layout at all.
    await openHome(page, 'no-preference');
    await page.evaluate(() => { window.location.hash = '#/charts'; });
    await expect(page.locator('.chart-card').first()).toBeVisible();
    await page.waitForTimeout(800);

    /** Every stamped card the reader can reach that is still unpainted.
     * Content inside a CLOSED disclosure is not reachable — a browser
     * skips rendering it, which freezes the transition mid-flight, and
     * the second half of this test is what proves opening it finishes. */
    const invisible = () => page.evaluate(() => [...document.querySelectorAll('.reveal')]
      .filter((el) => el.getBoundingClientRect().height > 0
        && el.closest('details:not([open])') === null
        && Number(getComputedStyle(el).opacity) < 0.99)
      .map((el) => el.className));

    const jump = async () => {
      const height = await page.evaluate(() => document.scrollingElement.scrollHeight);
      for (let top = 0; top < height; top += 1_200) {
        await page.evaluate((y) => window.scrollTo(0, y), top);
        await page.waitForTimeout(60);
      }
      await page.waitForTimeout(1_200);
    };

    await jump();
    // polled, not sampled: a card the sweep has just released is still
    // fading, and "arrives" is the claim — not "arrived by this instant"
    await expect.poll(invisible, { timeout: 8_000 }).toEqual([]);

    // a disclosure's content has no box until it opens: it can never have
    // been observed, and no scroll follows the click
    await page.locator('details').first().scrollIntoViewIfNeeded();
    await page.locator('details').first().evaluate((el) => { el.open = true; });
    await expect.poll(invisible, { timeout: 8_000 }).toEqual([]);
  });

  test('the page entrance plays once per arrival', async function ({ page }) {
    await openHome(page, 'no-preference');
    const animation = () => page.locator('main.main')
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(await animation()).toBe('page-in');
    // a route swap mounts the page container again, so the entrance is new
    await page.evaluate(() => { window.location.hash = '#/benchmarks'; });
    await expect(page.locator('main.main h1')).toHaveText('Benchmarks');
    expect(await animation()).toBe('page-in');
    const played = await page.locator('main.main')
      .evaluate((el) => el.getAnimations().length > 0 || getComputedStyle(el).animationName === 'page-in');
    expect(played).toBe(true);
  });
});

test.describe('with reduced motion asked for', function () {

  test('nothing animates: final classes, no animation, no transition', async function ({ page }) {
    await openHome(page, 'reduce');
    const card = lastCard(page);
    const state = await card.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        classes: el.className,
        animation: style.animationName,
        duration: style.transitionDuration,
        opacity: style.opacity,
        transform: style.transform,
      };
    });
    expect(state.classes, 'the final class is stamped at once').toContain('reveal-in');
    expect(state.animation).toBe('none');
    expect(state.duration).toBe('0s');
    expect(state.opacity).toBe('1');
    expect(state.transform).toBe('none');

    // the page container, too — the entrance is behind the same preference
    expect(await page.locator('main.main').evaluate((el) => getComputedStyle(el).animationName))
      .toBe('none');
    expect(await page.locator('main.main').evaluate((el) => el.getAnimations().length)).toBe(0);
  });

  test('a headline shows its final value on first paint and never counts', async function ({ page }) {
    await openHome(page, 'reduce');
    const headline = page.locator('.engine-perf').last();
    const published = await headline.textContent();
    await watchText(page, '.engine-perf');
    await lastCard(page).scrollIntoViewIfNeeded();
    await page.waitForTimeout(1_500);
    expect(await seenText(page), 'the value was never rewritten').toEqual([]);
    expect(await headline.textContent()).toBe(published);
    await expect(headline).not.toHaveClass(/counting/);
    expect(await page.locator('.counting').count()).toBe(0);
  });
});
