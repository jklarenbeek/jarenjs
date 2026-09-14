import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const code = process.env.JAREN_FILE_TOKENS_BUNDLE ? readFileSync(process.env.JAREN_FILE_TOKENS_BUNDLE, 'utf8')
  : (await build({ stdin: { contents: "export * from './test/consumer/file-tokens.js'; export { createFileTokenRegistry } from '@jarenjs/app/file-tokens';", resolveDir: root },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'FileConsumer' })).outputFiles[0].text;
test.beforeEach(async ({ page }) => {
  await page.setContent('<main id="host"></main>');
  await page.addScriptTag({ content: code });
});

test('native input selection stays JSON, cancels, retries a byte upload and commits metadata', async ({ page }) => {
  await page.evaluate(() => {
    let id = 0, sends = 0;
    window.sent = []; window.commits = [];
    window.owner = window.FileConsumer.createFileUploadConsumer({ node: document.querySelector('#host'),
      runtime: { uuid: () => `browser-${++id}`, now: () => 100 }, fetch: async (url, init) => {
        if (url.includes('/uploads/')) {
          window.sent.push(await new Response(init.body).text());
          if (++sends === 1) throw new TypeError('synthetic transport failure');
          return new Response(null, { status: 204 });
        }
        const body = JSON.parse(init.body); window.commits.push(body);
        return Response.json({ id: body.id });
      } });
  });
  const input = page.locator('input[type=file]');
  await input.setInputFiles([{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('first') },
    { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('second') }]);
  expect(await page.evaluate(() => ({ types: window.owner.app.getState().tokens.map(t => typeof t),
    files: window.owner.files.stats().files, bytes: window.owner.files.stats().bytes })))
    .toEqual({ types: ['string', 'string'], files: 2, bytes: 11 });
  expect(await page.evaluate(() => {
    const old = window.owner.app.getState().tokens; window.owner.cancel();
    return { retained: window.owner.files.stats().files, old: old.map(t => window.owner.files.take(t)) };
  })).toEqual({ retained: 0, old: [null, null] });
  await input.setInputFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  expect(await page.evaluate(async () => {
    const token = window.owner.app.getState().tokens[0];
    const result = await window.owner.upload(token);
    return { ok: result.ok, sent: window.sent, commits: window.commits, stale: window.owner.files.take(token),
      tokens: window.owner.app.getState().tokens, files: window.owner.files.stats().files };
  })).toEqual({ ok: true, sent: ['hello', 'hello'], commits: [{ id: 'upload-1', name: 'hello.txt' }],
    stale: null, tokens: [], files: 0 });
  await input.setInputFiles({ name: 'too-big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(17) });
  expect(await page.evaluate(() => ({ cause: window.owner.errors[0].cause.code,
    tokens: window.owner.app.getState().tokens, files: window.owner.files.stats().files })))
    .toEqual({ cause: 'JA2019', tokens: [], files: 0 });
  await input.setInputFiles({ name: 'left.txt', mimeType: 'text/plain', buffer: Buffer.from('left') });
  expect(await page.evaluate(() => {
    window.owner.app.destroy(); window.owner.app.destroy();
    return { ...window.owner.files.stats(), nodes: document.querySelector('#host').childNodes.length };
  })).toEqual({ files: 0, bytes: 0, maxFiles: 2, maxBytes: 16, disposed: true, nodes: 0 });
});

test('foreign-realm Files keep their identity and repeated owners release all references', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    const file = new frame.contentWindow.File(['abc'], 'foreign.txt');
    const identities = [], retained = [];
    for (let index = 0; index < 3; index++) {
      let id = 0;
      const files = window.FileConsumer.createFileTokenRegistry({ maxBytes: 3,
        runtime: { now: () => 1, uuid: () => `owner-${index}-${++id}` } });
      const [token] = files.register([file]);
      identities.push(files.take(token) === file);
      Object.defineProperty(file, 'size', { value: 0, configurable: true });
      const [next] = files.register([file]);
      retained.push(files.stats().bytes);
      files.dispose(); files.dispose();
      retained.push(files.stats().bytes); identities.push(files.take(next) === null);
    }
    const text = await file.text();
    frame.remove(); return { identities, retained, text };
  });
  expect(result).toEqual({ identities: [true, true, true, true, true, true], retained: [3, 0, 3, 0, 3, 0], text: 'abc' });
});
