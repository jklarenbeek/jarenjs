import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const code = process.env.JAREN_ROUTES_BUNDLE ? readFileSync(process.env.JAREN_ROUTES_BUNDLE, 'utf8')
  : (await build({ stdin: { contents: readFileSync(`${root}/test/consumer/routes.js`, 'utf8'), resolveDir: root },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'RouteConsumer' })).outputFiles[0].text;

for (const mode of ['hash', 'history']) {
  test.describe(`${mode} public route owner`, () => {
    test.beforeEach(async ({ page }) => {
      await page.route('**/route-harness/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Route consumer</main>' }));
      await page.goto(mode === 'hash' ? '/route-harness/#/start' : '/route-harness/start');
      await page.addScriptTag({ content: code });
      await page.evaluate(mode => { window.owner = window.RouteConsumer.createRouteConsumer(window, mode); }, mode);
    });
    test('initial navigation, replace and native back/forward dispatch exactly once', async ({ page }) => {
      expect(await page.evaluate(() => window.owner.app.getState())).toMatchObject({ count: 1, route: { path: '/start' } });
      const before = await page.evaluate(() => history.length);
      await page.evaluate(mode => window.owner.routes.navigate((mode === 'hash' ? '' : '/route-harness') + '/next?tag=a&tag=b#section'), mode);
      expect(await page.evaluate(() => window.owner.app.getState())).toMatchObject({ count: 2,
        route: { path: '/next', query: { tag: ['a', 'b'] }, fragment: 'section' } });
      await page.evaluate(mode => { window.owner.routes.replace((mode === 'hash' ? '' : '/route-harness') + '/final'); window.owner.routes.refresh(); }, mode);
      expect(await page.evaluate(() => history.length)).toBe(before + 1);
      await page.goBack();
      await expect.poll(() => page.evaluate(() => window.owner.app.getState())).toMatchObject({ count: 4, route: { path: '/start' } });
      await page.goForward();
      await expect.poll(() => page.evaluate(() => window.owner.app.getState())).toMatchObject({ count: 5, route: { path: '/final' } });
    });
    test('external writes, stop/destroy and a new app reuse have explicit ownership', async ({ page }) => {
      await page.evaluate(mode => {
        if (mode === 'hash') location.hash = '#/external';
        else history.pushState(null, '', '/route-harness/external');
      }, mode);
      if (mode === 'history') {
        expect(await page.evaluate(() => window.owner.app.getState().count)).toBe(1);
        await page.evaluate(() => window.owner.routes.refresh());
      }
      await expect.poll(() => page.evaluate(() => window.owner.app.getState())).toMatchObject({ count: 2, route: { path: '/external' } });
      const url = page.url();
      expect(await page.evaluate(() => {
        try { window.owner.routes.navigate('https://foreign.test/no'); } catch (error) { return error.code; }
      })).toBe('JA2024');
      expect(page.url()).toBe(url);
      await page.evaluate(() => { window.owner.app.stop(); window.owner.app.destroy(); window.owner.app.destroy(); });
      expect(await page.evaluate(() => {
        try { window.owner.routes.refresh(); } catch (error) { return error.code; }
      })).toBe('JA2026');
      await page.evaluate(mode => { window.owner = window.RouteConsumer.createRouteConsumer(window, mode, window.owner.routes); }, mode);
      expect(await page.evaluate(() => window.owner.app.getState())).toMatchObject({ count: 1, route: { path: '/external' } });
      await page.evaluate(() => window.owner.app.destroy());
    });
  });
}
