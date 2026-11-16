//@ts-check
/**
 * @file `@jarenjs/josl/ical` in Chromium, Firefox and WebKit: the module,
 * bundled for the browser, reads, writes and patches the vendored
 * iCalendar corpus exactly as Node does.
 *
 * The page needs no site: the bundle (esbuild, built here from the
 * package's entry) and the computation are served on their own origin
 * through `page.route`, and the corpus files reach the page as octets.
 * The computation is one function, run here in Node over the package's
 * source and in the page over the bundle; the assertion compares the
 * two answers whole - each file's model and report as JSON, the
 * canonical calendar it writes, its lossless octets and the octets of
 * one edit. No zone provider is used: a TZID resolves only through the
 * file's own VTIMEZONE, so an engine's ICU and tzdata cannot enter the
 * answer. A file count is asserted too, so a runner that read nothing
 * cannot pass, and no engine is skipped.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as ical from '@jarenjs/josl/ical';

const FIXTURES = fileURLToPath(new URL('../../../test/josl/fixtures/', import.meta.url));
const ORIGIN = 'http://ical.test';

/** Every corpus file, as octets: the reader's fixtures, the VTIMEZONE examples in a calendar, the RFC examples. */
function corpus() {
  /** @type {{ name: string, bytes: number[] }[]} */
  const out = [];
  for (const dir of ['ical', 'ical-vtimezone', 'ical-rfc']) {
    for (const name of readdirSync(`${FIXTURES}${dir}`).filter((file) => file.endsWith('.ics')).sort()) {
      let bytes = readFileSync(`${FIXTURES}${dir}/${name}`);
      if (dir === 'ical-vtimezone')
        bytes = Buffer.concat([Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:p\r\n'), bytes, Buffer.from('END:VCALENDAR\r\n')]);
      out.push({ name: `${dir}/${name}`, bytes: [...bytes] });
    }
  }
  return out;
}

/**
 * Read, write and patch each file; every refusal is an answer too.
 * Self-contained: it is also served to the page as a module.
 * @param {any} lib - `@jarenjs/josl/ical`
 * @param {{ name: string, bytes: number[] }[]} files
 */
function compute(lib, files) {
  const hex = (/** @type {Uint8Array} */ bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const refusal = (/** @type {any} */ error) => ({ refused: String(error?.code ?? error?.name), reason: String(error?.message) });
  return files.map(({ name, bytes }) => {
    const input = new Uint8Array(bytes);
    /** @type {Record<string, unknown>} */
    const out = { name };
    let read;
    try {
      read = lib.parseIcal(input, { mode: 'lossless' });
    }
    catch (error) {
      out.read = refusal(error);
      return out;
    }
    out.model = JSON.stringify(read.calendar);
    out.report = JSON.stringify(read.report);
    out.zones = JSON.stringify({ compiled: Object.keys(read.zones.compiled), undeclared: read.zones.undeclared });
    try {
      out.written = lib.stringifyIcal(read.calendar, { zones: 'embed', provider: read.zones.provider,
        horizon: [Date.UTC(1990, 0, 1), Date.UTC(2040, 0, 1)] });
    }
    catch (error) {
      out.written = refusal(error);
    }
    out.lossless = hex(lib.patchIcal(read.tree));
    out.same = out.lossless === hex(input);
    const first = read.calendar.components.find((/** @type {any} */ c) => c.type === 'event');
    const uid = first?.series?.uid ?? first?.uid;
    if (uid !== undefined) {
      try {
        out.edited = hex(lib.patchIcal(read.tree, [{ op: 'retitle', uid, summary: 'Café, 会议 👋' }]));
      }
      catch (error) {
        out.edited = refusal(error);
      }
    }
    return out;
  });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('the iCalendar codec reads, writes and patches the corpus as Node does, in this engine', async ({ page }) => {
  test.slow();
  const files = corpus();
  expect(files.length).toBeGreaterThanOrEqual(36);
  const bundle = await build({ stdin: { contents: "export * from '@jarenjs/josl/ical';", resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'browser' });
  const modules = /** @type {Record<string, string>} */ ({
    '/ical.js': bundle.outputFiles[0].text,
    '/compute.js': `export ${compute.toString()}`,
    '/': '<!doctype html><title>ical</title>',
  });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = modules[path];
    return body === undefined ? route.fulfill({ status: 404 })
      : route.fulfill({ status: 200, contentType: path === '/' ? 'text/html' : 'text/javascript', body });
  });
  const errors = /** @type {string[]} */ ([]);
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${ORIGIN}/`);
  const inPage = await page.evaluate(async ({ origin, files }) => {
    const lib = await import(`${origin}/ical.js`);
    const { compute } = await import(`${origin}/compute.js`);
    return compute(lib, files);
  }, { origin: ORIGIN, files });
  const inNode = compute(ical, files);
  expect(errors).toEqual([]);
  expect(inPage.length).toBe(files.length);
  for (const [i, answer] of inNode.entries())
    expect(inPage[i], answer.name).toEqual(answer);
  // the corpus is read, not refused: every file but the one the RFC misprints
  expect(inNode.filter((answer) => answer.read !== undefined).map((answer) => answer.name)).toEqual(['ical-rfc/rfc7986-erratum-conference.ics']);
  expect(inNode.every((answer) => answer.read !== undefined || answer.same === true)).toBe(true);
});
