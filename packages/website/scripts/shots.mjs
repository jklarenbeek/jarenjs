//@ts-check
/* eslint-disable no-console */
/* global document, localStorage, getComputedStyle */
/** Mobile + desktop appearance sweep: screenshot key pages/states. */
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173';
const OUT = '/tmp/jaren-drive/shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

const PAGES = [
  ['home', '/#/'],
  ['playground', '/#/playground?engine=validate'],
  ['jslt', '/#/playground?engine=jslt'],
  ['charts', '/#/charts'],
  ['benchmarks', '/#/benchmarks'],
  ['docs', '/#/docs'],
  ['studio', '/#/studio'],
];

async function sweep(tag, contextOpts, dark) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  if (dark) await page.addInitScript(() => localStorage.setItem('jaren-theme', 'dark'));
  for (const [name, path] of PAGES) {
    await page.goto(BASE + path);
    await page.waitForTimeout(1200);
    // horizontal overflow check: any element wider than the viewport
    const overflow = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const bad = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > vw + 2 || r.left < -2) && getComputedStyle(el).position !== 'fixed') {
          const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
          bad.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} right=${Math.round(r.right)} left=${Math.round(r.left)} vw=${vw}`);
        }
        if (bad.length >= 8) break;
      }
      return { vw, docScrollW: document.documentElement.scrollWidth, bad };
    });
    if (overflow.docScrollW > overflow.vw + 2)
      problems.push(`${name}: horizontal scroll ${overflow.docScrollW}>${overflow.vw} — ${overflow.bad.slice(0, 4).join(' | ')}`);
    await page.screenshot({ path: `${OUT}/${tag}-${name}.png`, fullPage: true });
  }

  // studio with form template loaded
  await page.goto(BASE + '/#/studio');
  await page.waitForSelector('.example-grid');
  await page.locator('.example-card', { hasText: 'Form + validation' }).locator('button').click();
  await page.waitForSelector('.studio-mount section.jaren-form');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${tag}-studio-form.png`, fullPage: true });

  await context.close();
  return problems;
}

const mobileLight = await sweep('mob', { ...devices['iPhone 13'] }, false);
const mobileDark = await sweep('mobdark', { ...devices['iPhone 13'] }, true);
const smallMobile = await sweep('mob320', { viewport: { width: 320, height: 660 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }, false);
const desktop = await sweep('desk', { viewport: { width: 1440, height: 900 } }, false);

console.log(JSON.stringify({ mobileLight, mobileDark, smallMobile, desktop }, null, 2));
await browser.close();
