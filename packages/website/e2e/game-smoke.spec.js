// Smoke test for the adventure game (#/game): title → play → verbs →
// hotspots → dialogue → flow-engine navigation. Screenshots for visual review.
import { test, expect } from '@playwright/test';

// screenshots only when SHOT is set (keeps CI runs from writing images)
const shot = (page, name) => (process.env.SHOT ? page.screenshot({ path: `${process.env.SHOT}${name}.png`, fullPage: true }) : Promise.resolve());

test('the adventure boots, plays, and navigates via the flow engine', async ({ page }) => {
  await page.goto('/#/game');

  // title card
  await expect(page.getByText('Name your pirate')).toBeVisible();
  await expect(page.getByRole('button', { name: /Set sail/ })).toBeVisible();
  await shot(page, 'title');

  // start
  await page.getByPlaceholder('Guybrush Threepwood').fill('Threepwood the Mildly Damp');
  await page.getByRole('button', { name: /Set sail/ }).click();
  await expect(page.locator('.game-play')).toBeVisible();
  await expect(page.locator('.game-scene h2')).toContainText('The Dock of Shame');
  await shot(page, 'play');

  // LOOK at the crate → narration mentions the padlock
  await page.getByRole('button', { name: 'Look at', exact: true }).click();
  await page.getByRole('button', { name: /cargo crate/ }).click();
  await expect(page.locator('.game-log')).toContainText(/padlock/i);

  // TAKE the compass → it enters the inventory
  await page.getByRole('button', { name: 'Pick up', exact: true }).click();
  await page.getByRole('button', { name: /magnetized compass/ }).click();
  await expect(page.locator('.game-inv')).toContainText('magnetized compass');

  // TALK to Gullbert → dialogue overlay
  await page.getByRole('button', { name: 'Talk to', exact: true }).click();
  await page.getByRole('button', { name: /Gullbert/ }).click();
  await expect(page.locator('.game-dialogue')).toBeVisible();
  await shot(page, 'dialogue');
  // pick a real option → it advances the tree (reveals the crate clue)
  await page.getByRole('button', { name: /Any advice about that crate/ }).click();
  await expect(page.locator('.gd-text')).toContainText(/Rust/i);
  await page.locator('.gd-close').click();
  await expect(page.locator('.game-dialogue')).toHaveCount(0);

  // NAVIGATE via the flow-engine scene action → room changes
  await page.getByRole('button', { name: /The Bazaar of Bargains/ }).click();
  await expect(page.locator('.game-scene h2')).toContainText('The Bazaar of Bargains');
  await shot(page, 'room2');
});

test('the adventure is winnable — no soft-lock: brine the biscuits, plate the sandwich', async ({ page }) => {
  const verb = (v) => page.getByRole('button', { name: v, exact: true }).click();
  const arm = (re) => page.locator('.game-inv').getByRole('button', { name: re }).click();
  const hotspot = (re) => page.getByRole('button', { name: re }).click();

  await page.goto('/#/game');
  await page.getByRole('button', { name: /Set sail/ }).click();

  // wharf: take the empty bottle, fill it at the tide pool
  await verb('Pick up'); await hotspot(/empty bottle/);
  await verb('Use'); await arm(/empty bottle/); await hotspot(/tide pool/);
  await expect(page.locator('.game-inv')).toContainText('seawater');

  // to the diner; take the biscuits; combine them with the seawater
  await hotspot(/The Salty Spoon/);
  await expect(page.locator('.game-scene h2')).toContainText('The Salty Spoon');
  await verb('Pick up'); await hotspot(/archipelago biscuits/);
  await arm(/bottle of seawater/); await arm(/archipelago biscuits/);
  await expect(page.locator('.game-inv')).toContainText('brine-glazed');

  // give the softened biscuits to Miles → the recipe → the wholesome ending
  await verb('Give'); await arm(/brine-glazed/); await hotspot(/Miles/);
  await expect(page.locator('.game-goalbar')).toContainText(/TRUCE ACHIEVED/);
  await shot(page, 'win');
});

// the DYNAMIC tier: with a real key, an NPC answers live and in-voice.
// Skipped without OR_KEY so CI stays offline.
test('dynamic tier — an NPC answers live when the player brings a key', async ({ page }) => {
  const KEY = process.env.OR_KEY;
  test.skip(!KEY, 'set OR_KEY to exercise the live AI tier');
  test.setTimeout(60000);
  // seed the shared BYOK slot the assistant uses (localStorage 'jaren-ai')
  await page.addInitScript((key) => {
    window.localStorage.setItem('jaren-ai', JSON.stringify({ provider: 'openrouter', baseUrl: '', model: 'qwen/qwen3.6-27b', apiKey: key }));
  }, KEY);
  await page.goto('/#/game');
  await page.getByRole('button', { name: /Set sail/ }).click();
  await page.getByRole('button', { name: 'Talk to', exact: true }).click();
  await page.getByRole('button', { name: /Gullbert/ }).click();
  await page.getByPlaceholder('Ask them anything…').fill('Gullbert, what is the meaning of a sandwich?');
  await page.getByRole('button', { name: /Ask/ }).click();
  // a live, in-character reply lands in the narration feed (format "<Name>: <line>")
  await expect(page.locator('.game-log')).toContainText(/Gullbert the Gull: \S/, { timeout: 45000 });
  await shot(page, 'dynamic');
});
