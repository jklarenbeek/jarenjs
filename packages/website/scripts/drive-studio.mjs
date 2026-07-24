//@ts-check
/* eslint-disable no-console */
/* global document */
/**
 * Deterministic studio duplication probe (no AI): load the form
 * template, then swap the document repeatedly through the editor
 * textarea (the same studio/doc → revision → destroy/reboot path the
 * assistant's studio tools use), counting <form> elements in the live
 * mount after every step. Also exercises typing into a field between
 * swaps, and route leave/return.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173';
const OUT = '/tmp/jaren-drive/studio-probe';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });

const countForms = () => page.evaluate(() => {
  const mount = document.querySelector('.studio-mount');
  return {
    forms: mount?.querySelectorAll('section.jaren-form').length ?? 0,
    fields: mount?.querySelectorAll('.jaren-form-field').length ?? 0,
    inputs: mount?.querySelectorAll('input, textarea, select').length ?? 0,
    apps: mount?.querySelectorAll('.studio-app').length ?? 0,
    rev: document.querySelector('.studio-stage .muted')?.textContent ?? '',
    firstChars: (mount?.textContent ?? '').slice(0, 80),
  };
});

const log = [];
const step = async (name) => {
  await page.waitForTimeout(400);
  const c = await countForms();
  log.push({ name, ...c });
  console.log(name, JSON.stringify(c));
};

await page.goto(BASE + '/#/studio');
await page.waitForSelector('.example-grid');
// load the form template
await page.locator('.example-card', { hasText: 'Form + validation' }).locator('button').click();
await page.waitForSelector('.studio-mount section.jaren-form');
await step('template-loaded');

// swap the doc via the editor: change the title, blur (change event)
const swapTitle = async (title) => {
  const text = await page.locator('.studio-editor textarea').inputValue();
  const doc = JSON.parse(text);
  doc.state.schema.title = title;
  await page.locator('.studio-editor textarea').fill(JSON.stringify(doc, null, 2));
  await page.locator('.studio-editor textarea').blur();
};

await swapTitle('Swap One');
await step('after-swap-1');
await swapTitle('Swap Two');
await step('after-swap-2');

// type into a field, then swap again (dirty nested state + reboot)
await page.locator('.studio-mount section.jaren-form input').first().fill('hello');
await step('after-typing');
await swapTitle('Swap Three');
await step('after-swap-3');

// leave the route and come back
await page.goto(BASE + '/#/');
await page.waitForTimeout(400);
await page.goto(BASE + '/#/studio');
await page.waitForSelector('.studio-mount section.jaren-form');
await step('after-route-roundtrip');

// invalid doc then valid again (error block appears/disappears around the keyed children)
const textarea = page.locator('.studio-editor textarea');
const good = await textarea.inputValue();
await textarea.fill('{"$app":"0.1"}');
await textarea.blur();
await step('after-invalid');
await textarea.fill(good);
await textarea.blur();
await step('after-valid-again');

await page.screenshot({ path: `${OUT}/final.png`, fullPage: true });
console.log('errors:', JSON.stringify(errors, null, 2));
fs.writeFileSync(`${OUT}/log.json`, JSON.stringify({ log, errors }, null, 2));
await browser.close();
