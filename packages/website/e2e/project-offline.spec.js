import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { encodeShare } from '@jarenjs/app';
import { projectTemplate } from '../src/content/projectTemplates.js';

test.use({ serviceWorkers: 'block' });
test('the downloaded ZIP runs an app and SQLite offline using only bundled assets', async ({ page }) => {
  test.slow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const project = projectTemplate('store');
  const starter = projectTemplate('starter');
  project.files.push(starter.files[0]); project.active = starter.active;
  await page.goto(`/#/project?s=${encodeShare({ e: 'project', i: { project } })}`);
  const directory = await mkdtemp(join(tmpdir(), 'jaren-offline-browser-'));
  let server;
  try {
    const [download] = await Promise.all([page.waitForEvent('download'),
      page.getByRole('button', { name: 'Offline ZIP', exact: true }).click()]);
    const archive = join(directory, 'project.zip');
    await download.saveAs(archive);
    execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', archive, directory]);
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
    server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://localhost').pathname;
      const name = path === '/' ? '/index.html' : path;
      try { response.setHeader('Content-Type', types[extname(name)] ?? 'application/octet-stream'); response.end(await readFile(join(directory, name))); }
      catch { response.statusCode = 404; response.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const remote = [], errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.context().route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      remote.push(route.request().url()); return route.abort();
    });
    await page.goto(origin);
    await expect(page.locator('h1')).toContainText(['Jaren project', 'Hello from the studio']);
    await page.getByRole('combobox', { name: 'Project file' }).selectOption('notes.model');
    await expect(page.locator('.project-data-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Insert row', exact: true }).click();
    await expect(page.locator('.project-data-live')).toContainText('New note');
    await page.getByRole('combobox', { name: 'Project file' }).selectOption('notes.query');
    await expect(page.locator('.project-data-result')).toContainText('New note');
    expect(remote).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }
  finally {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  }
});
