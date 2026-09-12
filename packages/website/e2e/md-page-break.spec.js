//@ts-check
import { test, expect } from '@playwright/test';

test('Markdown page breaks update on screen and carry print boundaries', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/play?engine=markdown');
  await expect(page.locator('.jplay-engine')).toHaveText('Markdown');
  const editor = page.locator('.jplay-editors textarea.editor').first();
  const article = page.locator('.jplay-view .md');
  const breaks = article.getByRole('separator', { name: 'Page break' });
  await editor.fill('First page\n\n<!-- pagebreak -->\n\nSecond page\n\n<!-- pagebreak -->\n\nThird page');
  await expect(breaks).toHaveCount(2);
  await expect(breaks.first()).toBeVisible();
  await expect(breaks.first()).toHaveCSS('border-top-style', 'dashed');
  await expect(breaks.first()).toHaveCSS('break-after', 'auto');
  await expect(article).toContainText('Second page');
  await expect(article).not.toContainText('<!--');

  await page.emulateMedia({ media: 'print' });
  for (const separator of await breaks.all()) {
    await expect(separator).toHaveCSS('break-after', 'page');
    await expect(separator).toHaveCSS('border-top-width', '0px');
    await expect(separator).toHaveCSS('margin-top', '0px');
    await expect(separator).toHaveCSS('margin-bottom', '0px');
    await expect(separator).toHaveCSS('display', 'block');
  }

  await page.emulateMedia({ media: 'screen' });
  await editor.fill('First page\n\n<!-- pagebreak -->\n\nThird page');
  await expect(breaks).toHaveCount(1);
  await expect(article).not.toContainText('Second page');
  await expect(breaks.first()).toHaveCSS('border-top-style', 'dashed');
  await editor.fill('First page\n\nThird page');
  await expect(breaks).toHaveCount(0);
  await expect(article).toContainText('Third page');
});
