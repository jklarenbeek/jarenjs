//@ts-check
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('real wasm replicas preserve envelopes, replay receipts, reset and live patches', async ({ page }, testInfo) => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../../test/db/replication-browser-fixture.js', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', write: false });
  const wasm = await readFile(fileURLToPath(import.meta.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm')));
  await page.route('**/replication-fixture/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('.wasm')) return route.fulfill({ body: wasm, contentType: 'application/wasm' });
    if (path.endsWith('.js')) return route.fulfill({ body: bundle.outputFiles[0].text, contentType: 'application/javascript' });
    return route.fulfill({ body: '<!doctype html><title>Replication oracle</title>', contentType: 'text/html' });
  });
  await page.goto('/replication-fixture/');
  const report = await page.evaluate(async () => {
    const fixture = await import('/replication-fixture/run.js');
    return fixture.runReplicationBrowser();
  });
  expect(report.checks).toBe(55);
  expect(report.envelopes).toBe(6);
  await testInfo.attach('replication-correctness', { body: JSON.stringify(report), contentType: 'application/json' });
});
