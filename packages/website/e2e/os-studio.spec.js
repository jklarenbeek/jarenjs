//@ts-check
/**
 * Radiant OS's studio in a real engine, against the built app at
 * /jarenjs/os/: a crew project from the first idea to a shipped app you
 * can press, the board's notes and ordered todos, a letter the oracle
 * answers, the library read and asked, every game on the shelf played,
 * paused, resumed and quit, the three art directions, the deep links,
 * the WebMCP tools a model gets (and the human's it never does), and the
 * page a crawler reads before any script runs. The headless suites
 * (`test/website/os-*.test.js`) prove the logic; this proves the browser
 * half — canvases, real focus, real layout, the library the build ships.
 */
import { expect } from '@playwright/test';
import { test } from './outage.js';

/** Every page error and console error. @param {import('@playwright/test').Page} page */
function watchErrors(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

/** Whether a canvas under `selector` has painted anything. @param {import('@playwright/test').Page} page @param {string} selector */
const painted = (page, selector) => page.locator(`${selector} canvas`).first().evaluate((canvas) => {
  const c = /** @type {HTMLCanvasElement} */ (canvas);
  const data = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
  if (!data) return false;
  for (let i = 3; i < data.length; i += 16) if (data[i] !== 0) return true;
  return false;
});

test('ships a crew project: ideas in, blocks built, reviewed and shipped as an app you can use', async ({ page, site }) => {
  const errors = watchErrors(page);
  await page.goto(`${site.origin}/jarenjs/os/?app=crew`);
  const crew = page.locator('.os-crew');
  await expect(crew).toBeVisible();
  await page.getByPlaceholder('A habit tracker').fill('Tea log');
  await crew.locator('input[type=range]').fill('2');
  await page.getByRole('button', { name: 'Start the project' }).click();
  for (const idea of ['a counter for cups of tea', 'a checklist for the shopping']) {
    await page.getByLabel('Your idea').fill(idea);
    await page.getByRole('button', { name: 'Add idea' }).click();
  }
  await page.getByRole('button', { name: 'End my turn' }).click();
  await expect(page.locator('.os-crew-busy')).toBeVisible();
  const review = page.getByRole('region', { name: 'Review' });
  await expect(review).toBeVisible({ timeout: 30_000 });
  await expect(review.getByRole('button', { name: 'Approve' })).toHaveCount(2);
  while (await review.getByRole('button', { name: 'Approve' }).count() > 0) await review.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.locator('.os-crew-shipped')).toContainText('Shipped!');
  const app = page.locator('.os-crew-preview .os-mini');
  await app.getByRole('button', { name: /^More / }).click();
  await expect(app.locator('.mini-count')).toHaveText('1');
  await expect(page.getByRole('region', { name: 'Made' })).toContainText('Tea log');
  // the crew's work is in the post
  await page.getByRole('button', { name: /^Mail/ }).click();
  await page.getByRole('navigation', { name: 'Folders' }).getByRole('button', { name: /^crew/ }).click();
  await expect(page.getByRole('list', { name: 'Threads' }).locator('.os-thread')).not.toHaveCount(0);
  expect(errors).toEqual([]);
});

test('pins notes and todos to the board, orders them and ticks one off', async ({ page, site }) => {
  const errors = watchErrors(page);
  await page.goto(`${site.origin}/jarenjs/os/?app=board`);
  await page.getByRole('radio', { name: 'Todo' }).click();
  for (const text of ['Boil water', 'Pour the tea']) {
    await page.getByLabel('Card text').fill(text);
    await page.getByRole('button', { name: 'Pin it' }).click();
  }
  const cards = page.getByRole('list', { name: 'Cards' });
  await expect(cards.locator('.os-card')).toHaveCount(2);
  await cards.locator('.os-card', { hasText: 'Boil water' }).getByRole('button', { name: 'Link' }).click();
  await cards.locator('.os-card', { hasText: 'Pour the tea' }).getByRole('button', { name: 'Link' }).click();
  await expect(cards.locator('.os-card', { hasText: 'Pour the tea' })).toHaveClass(/is-blocked/);
  await page.getByRole('checkbox', { name: 'Done: Boil water' }).click();
  await expect(page.getByRole('checkbox', { name: 'Done: Boil water' })).toHaveAttribute('aria-checked', 'true');
  await expect(cards.locator('.os-card', { hasText: 'Pour the tea' })).not.toHaveClass(/is-blocked/);
  await expect(page.locator('.os-wallhost svg[role="img"]')).toHaveAttribute('aria-label', 'Board: 2 cards');
  await expect(page.locator('.os-wallhost svg rect')).not.toHaveCount(0);
  expect(errors).toEqual([]);
});

test('reads the library, asks it, and gets an answer by letter from the oracle', async ({ page, site }) => {
  const errors = watchErrors(page);
  await page.goto(`${site.origin}/jarenjs/os/?app=library`);
  const docs = page.locator('.os-docs');
  await expect(docs.getByRole('button', { name: /Radiant OS field guide/ })).toBeVisible();
  await expect(docs.locator('li')).toHaveCount(24);
  await page.getByLabel('Ask the docs').fill('who decides the veto');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.os-answer-text')).not.toBeEmpty();
  await page.locator('.os-citations').getByRole('button').first().click();
  await expect(page.locator('.os-page-title')).not.toBeEmpty();
  await expect(page.getByRole('button', { name: /Listen/ })).toBeVisible();
  await page.getByRole('button', { name: /^Mail/ }).click();
  await page.getByLabel('Subject').fill('A question');
  await page.getByLabel('Message').fill('how does the council vote on amendments?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.os-message', { hasText: 'how does the council vote' })).toBeVisible();
  await expect(page.locator('.os-message[data-member="oracle"]').last()).not.toBeEmpty();
  expect(errors).toEqual([]);
});

for (const game of ['grove', 'dancers', 'arena']) {
  test(`plays ${game}: title, play, pause, continue and quit, like a real game`, async ({ page, site }) => {
    const errors = watchErrors(page);
    await page.goto(`${site.origin}/jarenjs/os/?game=${game}`);
    const arcade = page.locator(`.os-arcade[data-game="${game}"]`);
    await expect(arcade).toHaveAttribute('data-phase', 'title');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(arcade).toHaveAttribute('data-phase', 'playing');
    await expect(arcade.locator('.os-hud')).toBeVisible();
    await expect.poll(() => painted(page, '.os-arcade')).toBe(true);
    await page.keyboard.press('Escape');
    await expect(arcade).toHaveAttribute('data-phase', 'paused');
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(arcade).toHaveAttribute('data-phase', 'playing');
    await page.keyboard.press('p');
    await page.getByRole('button', { name: 'Quit to the studio' }).click();
    await expect(page.locator('.os-arcade')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('wears three art directions, and the stage follows', async ({ page, site }) => {
  const errors = watchErrors(page);
  await page.goto(`${site.origin}/jarenjs/os/?app=settings`);
  const os = page.locator('.os');
  for (const [name, theme] of [['Neon Night', 'neon'], ['Subway Chalk', 'dark'], ['Pop Shop', 'light']]) {
    await page.getByRole('radio', { name: new RegExp(name) }).click();
    await expect(os).toHaveAttribute('data-theme', theme);
  }
  await page.reload();
  await expect(os).toHaveAttribute('data-theme', 'light');
  expect(await painted(page, '.os-stage')).toBe(true);
  expect(errors).toEqual([]);
});

test('offers a model every public operation over WebMCP, and none of the human’s', async ({ page, site }) => {
  await page.addInitScript(() => {
    /** @type {Record<string, any>} */
    const tools = {};
    /** @type {any} */ (window).__tools = tools;
    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      value: { registerTool: (/** @type {any} */ tool) => { tools[tool.name] = tool; }, unregisterTool: (/** @type {string} */ name) => { delete tools[name]; } },
    });
  });
  await page.goto(`${site.origin}/jarenjs/os/`);
  await expect.poll(() => page.evaluate(() => Object.keys(/** @type {any} */ (window).__tools).length)).toBeGreaterThan(20);
  const names = await page.evaluate(() => Object.keys(/** @type {any} */ (window).__tools));
  expect(names).toEqual(expect.arrayContaining(['radiant_board_add', 'radiant_mail_send', 'radiant_library_search', 'radiant_crew_build', 'radiant_arcade_tool']));
  for (const human of ['veto', 'approve', 'repeal', 'crew_start', 'crew_idea', 'crew_end', 'crew_review']) expect(names.some((n) => n.endsWith(human))).toBe(false);
  const added = await page.evaluate(() => /** @type {any} */ (window).__tools.radiant_board_add.execute({ text: 'From a model', kind: 'note' }));
  expect(added).toMatchObject({ ok: true });
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Cards' })).toContainText('From a model');
});

test('reads as a page before any script runs, with the address of every app and game', async ({ browser, site }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${site.origin}/jarenjs/os/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Radiant OS' })).toBeVisible();
  for (const href of ['?app=crew', '?app=library', '?game=grove', '?game=dancers', '?game=arena']) await expect(page.locator(`a[href="${href}"]`)).toHaveCount(1);
  expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe('https://jklarenbeek.github.io/jarenjs/os/');
  const graph = JSON.parse(/** @type {string} */ (await page.locator('script[type="application/ld+json"]').textContent()));
  expect(graph['@graph'][0].hasPart.map((/** @type {any} */ g) => g.name)).toEqual(['Monkey Grove', 'Tape Dancers', 'Bench Arena']);
  await context.close();
});
