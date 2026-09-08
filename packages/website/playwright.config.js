//@ts-check
/**
 * @file The real-browser evidence harness (ROADMAP: real-browser
 * lifecycle matrix). Runs the e2e lifecycle/keyboard/landmark suite
 * against the BUILT website — the repository's own production consumer
 * of `createApp` — in real Chromium, Firefox and WebKit engines.
 *
 * This is deliberately the first honest slice of the browser matrix:
 * boot, client-side navigation lifecycle, keyboard activation, focus
 * and landmark semantics under real engine scheduling. It does not yet
 * claim the full accessibility audit.
 *
 * Run: `npm run test:browser` from the repository root (builds the
 * site first). Browsers: `npx playwright install chromium firefox
 * webkit` (plus `--with-deps` on CI, or run inside the Ubuntu
 * distrobox on hosts without the shared libraries).
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [{
    command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  }, {
    command: 'npm run preview -- --host 127.0.0.1 --port 4174 --strictPort --mode isolated',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  }],
});
