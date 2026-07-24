//@ts-check
/**
 * @file The AI assistant panel in a real mobile viewport (375 × 812,
 * touch): the launcher and panel chrome meet the 44 px tap-target
 * class, the panel opens as an on-screen sheet, the chat is gated on
 * configuration (settings first, composer only once the assistant can
 * actually send), and the transcript persists across a reload through
 * localStorage. No provider network is involved — everything here is
 * chrome, gating and persistence.
 */
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

test('the assistant opens as an on-screen sheet, gated on configuration', async ({ page }) => {
  await page.goto('/');
  const launch = page.locator('.ai-launch');
  await expect(launch).toBeVisible();
  const launchBox = await launch.boundingBox();
  expect(launchBox.height, 'the launcher meets the 44px class').toBeGreaterThanOrEqual(43);

  await launch.tap();
  const panel = page.locator('.ai-panel');
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box.x, 'the sheet starts inside the viewport').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'the sheet ends inside the viewport').toBeLessThanOrEqual(376);

  // unconfigured: the settings form shows and there is no composer yet
  await expect(page.locator('.ai-settings')).toBeVisible();
  await expect(page.locator('.ai-composer')).toHaveCount(0);
  await expect(page.locator('.ai-intro')).toContainText('Pick a provider above');

  const icon = await page.locator('.ai-icon').first().boundingBox();
  expect(icon.width, 'panel icons meet the 44px class').toBeGreaterThanOrEqual(43);
  expect(icon.height).toBeGreaterThanOrEqual(43);

  // configuring a local provider brings the composer to life
  await page.locator('.ai-settings select').selectOption('ollama');
  await page.getByPlaceholder('qwen/qwen3-4b · llama3.2 · …').fill('qwen3:4b');
  await page.locator('.ai-settings .btn').tap();
  await expect(page.locator('.ai-composer')).toBeVisible();
  await expect(page.locator('.ai-settings')).toHaveCount(0);
});

test('the transcript persists across a reload and clear wipes it', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('jaren-ai',
      JSON.stringify({ provider: 'ollama', baseUrl: '', model: 'qwen3:4b', apiKey: '' }));
    localStorage.setItem('jaren-ai-chat', JSON.stringify({
      messages: [
        { role: 'user', content: 'hello there' },
        { role: 'assistant', content: 'Hi! **Ready** to drive the playground.' },
      ],
    }));
  });
  await page.goto('/');
  await page.locator('.ai-launch').tap();

  // the restored transcript renders, assistant turns through @jarenjs/md
  await expect(page.locator('.ai-msg.user')).toHaveText('hello there');
  await expect(page.locator('.ai-msg.assistant strong')).toHaveText('Ready');

  await page.locator('.ai-icon[title="Clear the conversation"]').tap();
  await expect(page.locator('.ai-msg')).toHaveCount(0);
  const stored = await page.evaluate(() => localStorage.getItem('jaren-ai-chat'));
  expect(JSON.parse(stored).messages, 'clear wiped the persisted transcript').toEqual([]);
});
