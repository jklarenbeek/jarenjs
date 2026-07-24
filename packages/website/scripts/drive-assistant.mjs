//@ts-check
/* eslint-disable no-console */
/* global document, localStorage, location */
/**
 * Manual live-driving harness (a dev tool, not part of the e2e suite):
 * drives the BUILT site in real Chromium against a real OpenRouter model.
 * Serve dist first (`npm run preview -- --host 127.0.0.1 --port 4173`).
 *
 * Usage (on a host with Playwright browser libraries):
 *   node scripts/drive-assistant.mjs <runName> <prompt...>
 * Separate sequential turns of one conversation with ' || '.
 *
 * Env: OPENROUTER_KEY, MODEL (default qwen/qwen3.6-35b-a3b),
 *      VIEWPORT=mobile|desktop, BASE=http://127.0.0.1:4173
 *
 * Configures the assistant through localStorage, sends the prompt,
 * waits for the turn to finish (composer button back to 'Send'),
 * then reports: transcript, route, studio revision/doc summary,
 * form-element counts inside the studio mount, console errors.
 */
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';

const [runName = 'run', ...promptParts] = process.argv.slice(2);
const prompt = promptParts.join(' ') || 'Write a questionare for people with mental health problems';
const KEY = process.env.OPENROUTER_KEY;
const MODEL = process.env.MODEL ?? 'qwen/qwen3.6-35b-a3b';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4173';
const MOBILE = process.env.VIEWPORT === 'mobile';
const OUT = `/tmp/jaren-drive/${runName}`;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext(MOBILE
  ? { ...devices['iPhone 13'] }
  : { viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

/** @type {string[]} */
const consoleLog = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning')
    consoleLog.push(`[console.${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', (err) => consoleLog.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`));
page.on('requestfailed', (req) => consoleLog.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`));

// capture the raw provider traffic so we can audit what the model actually did
/** @type {any[]} */
const providerCalls = [];
page.on('request', (req) => {
  if (req.url().includes('openrouter.ai')) {
    let body = null;
    try { body = JSON.parse(req.postData() ?? 'null'); } catch { body = req.postData(); }
    providerCalls.push({ t: Date.now(), body });
  }
});

await page.addInitScript(([key, model]) => {
  localStorage.setItem('jaren-ai', JSON.stringify({
    provider: 'openrouter', baseUrl: '', model, apiKey: key,
  }));
}, [KEY, MODEL]);

await page.goto(BASE + '/');
await page.locator('.ai-launch').click();

// '||' separates sequential turns in one conversation
const turns = prompt.split('||').map((t) => t.trim()).filter((t) => t !== '');
let turnNo = 0;
for (const turn of turns) {
  turnNo += 1;
  await page.locator('.ai-composer textarea').fill(turn);
  await page.locator('.ai-send').click();
  // wait for the turn: button shows '…' while streaming, back to 'Send' when done
  await page.waitForFunction(() => {
    const btn = document.querySelector('.ai-send');
    return btn !== null && btn.textContent === 'Send';
  }, null, { timeout: 300_000, polling: 500 });
  // let any trailing renders settle
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/turn-${turnNo}.png`, fullPage: true });
}

const report = await page.evaluate(() => {
  const txt = (el) => el?.textContent ?? '';
  const messages = [...document.querySelectorAll('.ai-msg')].map((el) => ({
    role: el.classList.contains('user') ? 'user' : 'assistant',
    text: txt(el).slice(0, 4000),
  }));
  const error = txt(document.querySelector('.ai-error')) || null;
  const mount = document.querySelector('.studio-mount');
  const forms = mount ? mount.querySelectorAll('section.jaren-form').length : 0;
  const fieldsets = mount ? mount.querySelectorAll('.jaren-form-field').length : 0;
  const labels = mount ? [...mount.querySelectorAll('label')].map((l) => txt(l).trim()) : [];
  const inputs = mount ? mount.querySelectorAll('input, textarea, select').length : 0;
  const mountHtml = mount ? mount.innerHTML.slice(0, 20000) : null;
  const chat = localStorage.getItem('jaren-ai-chat');
  return {
    hash: location.hash,
    messages, error,
    studio: { forms, fieldsets, inputs, labels },
    mountHtml,
    persistedChatChars: chat === null ? 0 : chat.length,
  };
});

// duplicate detection: repeated label texts inside the mount
const counts = {};
for (const l of report.studio.labels) counts[l] = (counts[l] ?? 0) + 1;
const dupLabels = Object.entries(counts).filter(([, n]) => n > 1);

const summary = {
  runName, prompt, hash: report.hash,
  error: report.error,
  formCount: report.studio.forms,
  fieldsetCount: report.studio.fieldsets,
  inputCount: report.studio.inputs,
  duplicateLabels: dupLabels,
  messages: report.messages,
  console: consoleLog,
  providerRounds: providerCalls.length,
};
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ summary, providerCalls, mountHtml: report.mountHtml }, null, 2));
console.log(JSON.stringify(summary, null, 2));
await browser.close();
