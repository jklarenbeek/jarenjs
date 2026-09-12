import { test, expect } from '@playwright/test';

function inject(mode) {
  const record = { tools: {}, added: [], removed: [], calls: [], selected: null };
  window.__webmcp = record;
  const context = root => ({
    registerTool(tool) { record.calls.push(root); record.selected = root; record.tools[tool.name] = tool; record.added.push(tool.name); },
    unregisterTool(name) { delete record.tools[name]; record.removed.push(name); },
  });
  const doc = context('document'), nav = context('navigator');
  let preferred;
  if (['document', 'both', 'alias'].includes(mode)) preferred = doc;
  if (mode === 'unusable') preferred = { registerTool: 1 };
  if (mode === 'legacy') preferred = { provideContext({ tools }) { tools.forEach(tool => doc.registerTool(tool)); return () => tools.forEach(tool => doc.unregisterTool(tool.name)); } };
  if (mode === 'refused') preferred = { registerTool() { record.calls.push('document'); throw new Error('registration refused by fixture'); } };
  Object.defineProperty(document, 'modelContext', mode === 'throwing' ? { configurable: true, get() { throw new Error('root blocked'); } } : { configurable: true, writable: true, value: preferred });
  Object.defineProperty(navigator, 'modelContext', { configurable: true, value: ['navigator','both','unusable','throwing','refused'].includes(mode) ? nav : mode === 'alias' ? doc : undefined });
  record.enable = () => { document.modelContext = doc; };
}

const count = page => page.evaluate(() => Object.keys(window.__webmcp.tools).length);

test('actual site binds both roots and owns route cleanup across the compatibility matrix', async ({ browser }) => {
  for (const mode of ['document','navigator','both','alias','unusable','throwing','legacy']) {
    const page = await browser.newPage();
    try {
      await page.addInitScript(inject, mode);
      await page.goto('http://127.0.0.1:4173/#/project');
      await expect.poll(() => count(page)).toBe(5);
      const expected = ['navigator','unusable','throwing'].includes(mode) ? 'navigator' : 'document';
      expect(await page.evaluate(() => window.__webmcp.selected)).toBe(expected);
      const read = await page.evaluate(() => window.__webmcp.tools.jaren_editor_read.execute({}));
      expect(typeof read.revision).toBe('string');
      expect(await page.evaluate(revision => window.__webmcp.tools.jaren_editor_apply.execute({ revision, patch: [{ op:'replace', path:'/name', value:'Browser reviewed' }] }), read.revision)).toMatchObject({ ok: true });
      expect(await page.evaluate(revision => window.__webmcp.tools.jaren_editor_apply.execute({ revision, patch: [] }), read.revision)).toMatchObject({ ok: false, conflict: true });
      await page.evaluate(() => { window.__oldWebMcpTool = window.__webmcp.tools.jaren_editor_read; location.hash = '#/docs'; });
      await expect.poll(() => count(page)).toBe(1);
      expect(await page.evaluate(() => window.__webmcp.removed.length)).toBe(5);
      expect(await page.evaluate(() => window.__oldWebMcpTool.execute({}))).toHaveProperty('error');
      expect(await page.evaluate(() => window.__webmcp.tools.jaren_site_read.execute({}))).toEqual({ page:'docs', editor:null });
      await expect(page.locator('main.main')).toBeVisible();
    }
    finally { await page.close(); }
  }
});

test('late availability on focus registers and Flow operations keep the canonical validation gate', async ({ page }) => {
  await page.addInitScript(inject, 'late');
  await page.goto('/#/flow');
  await expect(page.locator('main.main')).toBeVisible();
  expect(await count(page)).toBe(0);
  await page.evaluate(() => { window.__webmcp.enable(); window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => count(page)).toBe(5);
  const read = await page.evaluate(() => window.__webmcp.tools.jaren_editor_read.execute({}));
  expect(await page.evaluate(revision => window.__webmcp.tools.jaren_editor_replace.execute({ revision, kind:'fsm', document:{ initial:'missing', states:['idle'], transitions:[] } }), read.revision)).toMatchObject({ ok:false });
  expect(await page.evaluate(revision => window.__webmcp.tools.jaren_editor_replace.execute({ revision, kind:'fsm', document:{ initial:'idle', states:['idle','done'], transitions:[{from:'idle',to:'done',event:'go'}] } }), read.revision)).toMatchObject({ ok:true });
  const run = await page.evaluate(async () => {
    const tools = window.__webmcp.tools, current = await tools.jaren_editor_read.execute({});
    return tools.jaren_editor_run.execute({ revision:current.revision, input:{} });
  });
  expect(run).toMatchObject({ ok:true, started:true });
});

test('browser refusal does not mutate another root and the editor stays usable', async ({ page }) => {
  await page.addInitScript(inject, 'refused');
  await page.goto('/#/project');
  await expect(page.locator('main.main')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__webmcp.calls.length)).toBe(1);
  expect(await page.evaluate(() => window.__webmcp.calls)).toEqual(['document']);
  expect(await count(page)).toBe(0);
});

test('a persisted pagehide keeps ownership and the later final pagehide releases it', async ({ page }) => {
  await page.addInitScript(inject, 'document');
  await page.goto('/#/project');
  await expect.poll(() => count(page)).toBe(5);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted:true })));
  expect(await count(page)).toBe(5);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted:true })));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted:false })));
  await expect.poll(() => count(page)).toBe(0);
  expect(await page.evaluate(() => window.__webmcp.removed.length)).toBe(5);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await count(page)).toBe(0);
});

test('records native WebMCP support separately from injected contexts', async ({ page, browser }, testInfo) => {
  await page.goto('/#/');
  const roots = await page.evaluate(() => ['document','navigator'].map(root => {
    try { const context = window[root].modelContext; return { root, present:context != null, registerTool:typeof context?.registerTool, provideContext:typeof context?.provideContext }; }
    catch (error) { return { root, error:error.message }; }
  }));
  await testInfo.attach('native-webmcp', { body:JSON.stringify({ browser:browser.version(), secure:await page.evaluate(() => isSecureContext), roots }), contentType:'application/json' });
  await expect(page.locator('main.main')).toBeVisible();
});
