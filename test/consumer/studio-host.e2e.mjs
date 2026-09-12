/** Run in ubuntu-playwright after test:packed with STUDIO_HOST_OUTPUT, served on port 5194. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium, firefox, webkit } from '@playwright/test';
const url = process.env.STUDIO_HOST_URL ?? 'http://127.0.0.1:5194';
const screenshots = process.env.STUDIO_HOST_SCREENSHOTS;
if (screenshots) mkdirSync(screenshots, { recursive: true });
let checks = 0;
for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => requests.push(request.url()));
    await page.addInitScript(() => {
      globalThis.editorWorkers = 0;
      const WorkerClass = globalThis.Worker;
      globalThis.Worker = class extends WorkerClass {
        constructor(...args) { super(...args); globalThis.editorWorkers++; }
        terminate() { if (!this.retired) { this.retired = true; globalThis.editorWorkers--; } return super.terminate(); }
      };
    });
    await page.goto(url);
    await page.waitForFunction(() => globalThis.document.getElementById('status').textContent === 'Installed editors passed', undefined, { timeout: 45_000 });
    assert.equal((await page.evaluate(() => globalThis.editorReceipt)).value, 24);
    assert.ok(requests.some(url => url.endsWith('.wasm'))); assert.ok(requests.every(request => request.startsWith(url)));
    assert.ok(await page.locator('#project .jstudio').isVisible());
    assert.ok(await page.locator('#flow .flow-canvas').isVisible());
    assert.ok(await page.locator('#data .data-query').isVisible());
    assert.equal(await page.locator('#flow .flow-panebar').isVisible(), false);
    const canvas = await page.locator('#flow .flow-canvas-card').boundingBox();
    const side = await page.locator('#flow .flow-side').boundingBox();
    assert.ok(canvas.x < side.x && Math.abs(canvas.y - side.y) < 2, `${name}: desktop Flow columns`);
    const projectBox = await page.locator('#project .jstudio').boundingBox();
    const flowBox = await page.locator('#flow').boundingBox();
    assert.ok(projectBox.y + projectBox.height < flowBox.y, `${name}: editor viewports overlap`); checks++;

    await page.locator('#flow').getByRole('button', { name: 'Add state', exact: true }).click();
    assert.equal(await page.evaluate(() => globalThis.editors.flow.read().document.states.length), 4);
    await page.locator('#flow').getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await page.evaluate(() => globalThis.editors.flow.read().document.states.length), 3); checks++;

    const replacement = await page.evaluate(async () => {
      const { project } = globalThis.editors;
      const model = { $model: '0.1', collections: { items: { schema: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'integer' } } }, key: '/id' } } };
      return project.replace({ project: '0.1', name: 'Private model', files: [
        { name: 'model', kind: 'model', text: JSON.stringify(model), input: 'seed' },
        { name: 'seed', kind: 'data', text: JSON.stringify({ items: [{ id: 'private', value: 9 }] }) },
        { name: 'query', kind: 'query', model: 'model', collection: 'items', text: JSON.stringify([{ $for: { row: '$[*]' }, $return: '$row' }]) },
      ], active: 'query' }, { expectedRevision: project.read().revision });
    });
    assert.equal(replacement.ok, true, JSON.stringify(replacement));
    await page.waitForFunction(() => globalThis.document.querySelector('#project .project-data-plan')?.textContent.includes('SELECT'));
    assert.ok((await page.locator('#project .project-data-result').textContent()).includes('private'));
    assert.equal((await page.evaluate(() => globalThis.editors.data.run())).result[0].value, 24); checks++;
    if (screenshots) await page.screenshot({ path: `${screenshots}/${name}-desktop.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#flow .flow-panebar').getByRole('button', { name: 'Inspector', exact: true }).click();
    assert.equal(await page.locator('#flow .flow-canvas-card').isVisible(), false);
    assert.equal(await page.locator('#flow .flow-inspector').isVisible(), true);
    const paneButton = await page.locator('#flow .flow-panebar button').first().boundingBox();
    assert.ok(paneButton.height >= 44);
    const overflow = await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth + 1);
    assert.equal(overflow, false, `${name}: independent editors overflow the phone`); checks++;
    if (screenshots) await page.screenshot({ path: `${screenshots}/${name}-phone.png`, fullPage: true });

    await page.evaluate(() => { globalThis.editors.dispose(); globalThis.editors.dispose(); });
    assert.equal(await page.locator('#project .jstudio').count(), 0);
    assert.equal(await page.locator('#flow .jaren-flow-editor').count(), 0);
    assert.equal(await page.locator('#data .jaren-data-editor').count(), 0);
    assert.equal(await page.evaluate(() => globalThis.editorWorkers), 0);
    assert.deepEqual(errors, []); checks++;
    process.stdout.write(`${name}: 5 installed-host checks passed\n`);
  }
  finally { await browser.close(); }
}
process.stdout.write(`${checks} installed-host checks passed across 3 browsers\n`);
