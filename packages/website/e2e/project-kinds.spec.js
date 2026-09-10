import { test, expect } from '@playwright/test';
import { encodeShare } from '@jarenjs/app';
import { projectTemplate } from '../src/content/projectTemplates.js';

test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });
const open = (page, id) => page.goto(`/#/project?s=${encodeShare({ e: 'project', i: { project: projectTemplate(id) } })}`);
const problems = (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
};

test('flow files use the diagram editor, write edits to the file and run in isolation', async ({ page }) => {
  const errors = problems(page);
  await open(page, 'fsm');
  await expect(page.locator('.project-flow')).toBeVisible();
  const idle = page.locator('.project-flow').getByRole('button', { name: 'state idle', exact: true });
  await idle.focus();
  await idle.press('Enter');
  await expect(idle).toHaveClass(/mm-selected/);
  await page.getByRole('button', { name: 'Add state', exact: true }).click();
  await expect.poll(async () => JSON.parse(await page.locator('.js-editor-input').inputValue()).states.length).toBe(3);
  await page.getByRole('button', { name: 'Run machine', exact: true }).click();
  await page.locator('.project-flow').getByRole('button', { name: 'finish', exact: true }).click();
  await expect(page.locator('.flow-run-current')).toContainText('done');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => JSON.parse(await page.locator('.js-editor-input').inputValue()).states.length).toBe(2);
  expect(errors).toEqual([]);
});

for (const kind of ['fsm', 'store']) {
  test(`${kind} project stage fits a phone and keeps its runtime while switching panes`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = problems(page);
    await open(page, kind);
    const stage = page.locator(kind === 'fsm' ? '.project-flow' : '.project-data');
    await expect(stage).toBeVisible();
    if (kind === 'store') await expect(page.locator('.project-data-status')).toHaveText('Ready', { timeout: 30_000 });
    const identity = await stage.elementHandle();
    await page.locator('.js-panebar').getByRole('button', { name: 'Editor', exact: true }).click();
    await expect(stage).toBeHidden();
    await page.locator('.js-panebar').getByRole('button', { name: 'Stage', exact: true }).click();
    await expect(stage).toBeVisible();
    expect(await stage.evaluate((node, original) => node === original, identity)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`${kind}-phone.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('a project DAG runs the edited input and reports its output', async ({ page }) => {
  const errors = problems(page);
  await open(page, 'dag');
  await page.locator('.flow-dag-input').fill('{"message":"through the graph"}');
  await page.getByRole('button', { name: 'Run graph', exact: true }).click();
  await expect(page.locator('.project-flow')).toContainText('through the graph');
  await expect(page.locator('.project-flow pre')).toContainText(['through the graph']);
  expect(errors).toEqual([]);
});

test('a split app hot-updates its imported state and keeps the stage identity', async ({ page }) => {
  const errors = problems(page);
  await open(page, 'split-app');
  const mount = page.locator('.js-stage-mount');
  await expect(mount.locator('h1')).toHaveText('Hello from the studio');
  await mount.locator('input').fill('keep this');
  await page.locator('.js-file').filter({ hasText: 'app.state' }).click();
  await expect(page.locator('.js-editor-name')).toHaveValue('app.state');
  await page.locator('.js-editor-input').fill('{"title":"From a state file","note":"works"}');
  await page.locator('.js-editor-input').blur();
  await expect(mount.locator('h1')).toHaveText('From a state file');
  await expect(mount.locator('input')).toHaveValue('keep this');
  expect(errors).toEqual([]);
});

test('model and query files share their private worker, explain SQL and receive live commits', async ({ page }) => {
  const errors = problems(page);
  await open(page, 'store');
  await expect(page.locator('.project-data-status')).toHaveText('Ready', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Insert row', exact: true }).click();
  await expect(page.locator('.project-data-live')).toContainText('New note');
  await page.locator('.js-file').filter({ hasText: 'notes.query' }).click();
  await expect(page.locator('.project-data-status')).toHaveText('Ready', { timeout: 30_000 });
  await expect(page.locator('.project-data-result')).toContainText('New note');
  await page.locator('.project-data summary').click();
  await expect(page.locator('.project-data-plan')).toBeVisible();
  await expect(page.locator('.project-data-plan')).toContainText('SELECT');
  await expect(page.locator('.project-data-live')).toContainText('New note');
  await page.getByRole('button', { name: 'Delete row', exact: true }).click();
  await expect(page.locator('.project-data-live')).not.toContainText('New note');
  await page.locator('.js-file').filter({ hasText: 'notes.model' }).click();
  await expect(page.locator('.project-data-status')).toHaveText('Ready');
  await expect(page.locator('.project-data-result')).toHaveText('[]');
  expect(errors).toEqual([]);
});
