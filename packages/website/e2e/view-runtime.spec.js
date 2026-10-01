import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { renderToString } from '../../view/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = await build({ stdin: { contents: "export * from '@jarenjs/view';", resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'JarenTest' });
test.beforeEach(async ({ page }) => {
  await page.setContent('<main id="host"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});

test('safe attack corpus stays inert through update, removal and reinsertion', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { createDomRenderer, renderToString } = window.JarenTest;
    const host = document.getElementById('host');
    let mounted = 0, events = 0;
    window.attacked = false;
    const render = createDomRenderer(host, { safe: true, onEvent: () => events++,
      widgets: { attack: { mount: () => mounted++ } } });
    const corpus = [
      ['script', {}, 'window.attacked=true'],
      ['iframe', { srcdoc: '<script>parent.attacked=true</script>' }],
      ['div', { innerHTML: '<img src=x onerror="window.attacked=true">', onclick: 'window.attacked=true', on: { click: 'attack' } }, 'safe'],
      ['a', { href: 'java\nscript:window.attacked=true' }, 'link'],
      ['img', { src: 'data:text/html,<script>window.attacked=true</script>', srcset: 'javascript:evil 1x, https://example.invalid/a 2x' }],
      ['div', { style: { 'color:red;background': 'url(javascript:evil)', color: 'red' } }, 'style'],
      ['input', { files: 'readonly', is: 'evil-widget' }],
      ['jaren-widget', { name: 'attack' }],
      ['svg', {}, ['a', { 'xlink:href': 'javascript:evil' }, ['text', {}, 'svg']]],
    ];
    const failures = [];
    for (const attack of corpus) {
      const safe = ['div', { key: 'same' }, 'before'];
      for (const vnode of [safe, attack, ['span', {}, 'removed'], attack]) {
        render(vnode);
        const parsed = document.createElement('div');
        // Test-only: compare how the browser parses the safe serializer.
        parsed.innerHTML = renderToString(vnode, { safe: true });
        if (host.innerHTML !== parsed.innerHTML) failures.push([host.innerHTML, parsed.innerHTML]);
        host.firstElementChild?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }
    render.destroy();
    return { failures, mounted, events, attacked: window.attacked };
  });
  expect(result).toEqual({ failures: [], mounted: 0, events: 0, attacked: false });
});

test('composition defers authoritative writes and preserves selection on settlement', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const host = document.getElementById('host');
    const render = window.JarenTest.createDomRenderer(host);
    render(['textarea', { value: 'start' }]);
    const input = host.firstChild;
    input.focus(); input.setSelectionRange(2, 2);
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = 'composing'; input.setSelectionRange(3, 3);
    const tree = ['textarea', { value: 'authoritative' }];
    render(tree); render(tree);
    const during = input.value;
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settled = { value: input.value, start: input.selectionStart, end: input.selectionEnd };
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    render([]); input.dispatchEvent(new CompositionEvent('compositionend'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    render.destroy();
    return { during, settled, empty: host.childNodes.length };
  });
  expect(result).toEqual({ during: 'composing', settled: { value: 'authoritative', start: 3, end: 3 }, empty: 0 });
});

test('multiple select reconciles against options after a memoized render and reinsertion', async ({ page }) => {
  const result = await page.evaluate(() => {
    const host = document.getElementById('host');
    const render = window.JarenTest.createDomRenderer(host);
    const vnode = ['select', { multiple: true, value: ['b', 'Text value'] },
      ['option', { value: 'a' }, 'A'], ['optgroup', { label: 'group' },
        ['option', { value: 'b' }, 'B'], ['option', {}, ' Text\n value ']]];
    render(vnode);
    host.firstChild.options[0].selected = true;
    render(vnode);
    const first = [...host.firstChild.selectedOptions].map((o) => o.value);
    render([]); render(vnode);
    const second = [...host.firstChild.selectedOptions].map((o) => o.value);
    render.destroy(); return { first, second };
  });
  expect(result).toEqual({ first: ['b', 'Text value'], second: ['b', 'Text value'] });
});

test('hydrates fragment roots, repairs local mismatches and retains keyed nodes', async ({ page }) => {
  const vnode = [['p', { key: 'p', id: 'kept' }, 'server'], ['input', { value: 'value' }]];
  await page.locator('#host').evaluate((host, html) => { host.innerHTML = html; }, renderToString(vnode));
  const result = await page.evaluate((vnode) => {
    const host = document.getElementById('host');
    const original = host.firstChild;
    const render = window.JarenTest.createDomRenderer(host, { hydrate: true });
    render(vnode);
    const adopted = original === host.firstChild;
    render([['span', {}, 'new'], ['p', { key: 'p', id: 'kept' }, 'client']]);
    const retained = host.lastChild === original;
    const text = host.textContent;
    render.destroy(); return { adopted, retained, text, empty: host.childNodes.length };
  }, vnode);
  expect(result).toEqual({ adopted: true, retained: true, text: 'newclient', empty: 0 });
});

test('SVG foreignObject changes namespace and namespaced attributes update and remove', async ({ page }) => {
  const result = await page.evaluate(() => {
    const host = document.getElementById('host');
    const render = window.JarenTest.createDomRenderer(host);
    const tree = (props) => ['svg', {}, ['foreignObject', {}, ['div', {}, 'HTML', ['svg', {}, ['circle', {}]]]], ['use', props]];
    render(tree({ 'xlink:href': '#one', 'xml:lang': 'en' }));
    render(tree({ 'xlink:href': '#two' }));
    const use = host.querySelector('use');
    const values = [host.querySelector('div').namespaceURI, host.querySelector('circle').namespaceURI,
      use.getAttributeNS('http://www.w3.org/1999/xlink', 'href'), use.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang')];
    render.destroy(); return values;
  });
  expect(result).toEqual(['http://www.w3.org/1999/xhtml', 'http://www.w3.org/2000/svg', '#two', null]);
});

test('enumerated attributes and removed properties: the DOM writes what the markup says', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { createDomRenderer, renderToString } = window.JarenTest;
    const host = document.getElementById('host');
    const parsed = document.createElement('div');
    const differ = [];
    for (const name of ['spellcheck', 'draggable', 'translate', 'autocorrect', 'contenteditable', 'writingsuggestions']) {
      for (const value of [true, false, 'true', 'false', null]) {
        const vnode = ['textarea', { [name]: value }];
        const render = createDomRenderer(host);
        render(vnode);
        parsed.innerHTML = renderToString(vnode);
        if (host.innerHTML !== parsed.innerHTML) differ.push(['render', name, value, host.innerHTML, parsed.innerHTML]);
        // hydration keeps the server's keyword rather than flipping it
        const hydrate = createDomRenderer(parsed, { hydrate: true });
        hydrate(vnode);
        if (parsed.innerHTML !== host.innerHTML) differ.push(['hydrate', name, value, parsed.innerHTML]);
        hydrate.destroy();
        render.destroy();
      }
    }
    const render = createDomRenderer(host);
    render(['textarea', { spellcheck: 'false' }]);
    const spellcheckOff = host.firstChild.spellcheck === false;
    render.destroy();
    const removals = [];
    for (const [from, to] of [
      [['input', { size: 5 }], ['input', {}]],
      [['img', { width: 40 }], ['img', {}]],
      [['a', { href: '/x' }], ['a', {}]],
      [['a', { href: '/x' }], ['a', { href: false }]],
      [['progress', { value: 3, max: 10 }], ['progress', { max: 10 }]],
    ]) {
      const patch = createDomRenderer(host);
      let error = null;
      patch(from);
      try { patch(to); } catch (thrown) { error = thrown.name; }
      parsed.innerHTML = renderToString(to);
      removals.push({ to: to[0], error, dom: host.innerHTML, ssr: parsed.innerHTML,
        indeterminate: to[0] === 'progress' ? host.firstChild.position === -1 : null });
      patch.destroy();
    }
    return { differ, spellcheckOff, removals };
  });
  expect(result.differ).toEqual([]);
  expect(result.spellcheckOff).toBe(true);
  for (const removal of result.removals) {
    expect(removal.error).toBeNull();
    expect(removal.dom).toBe(removal.ssr);
  }
  expect(result.removals.at(-1).indeterminate).toBe(true);
});

test("controlled: 'focus' keeps what the operator types through a refresh until blur, then reconciles", async ({ page }) => {
  for (const controlled of ['focus', undefined]) {
    await page.evaluate((controlled) => {
      const host = document.getElementById('host');
      window.view?.destroy();
      window.view = window.JarenTest.createDomRenderer(host, controlled === undefined ? {} : { controlled });
      window.tree = (value) => ['div', {}, ['input', { id: 'field', value }], ['button', { id: 'elsewhere' }, 'elsewhere']];
      window.view(window.tree('server'));
    }, controlled);
    await page.focus('#field');
    await page.keyboard.press('End');
    await page.keyboard.type(' typed');
    await page.evaluate(() => window.view(window.tree('refreshed')));
    if (controlled === 'focus') {
      await expect(page.locator('#field')).toHaveValue('server typed');
      await page.keyboard.type('!');
      await expect(page.locator('#field')).toHaveValue('server typed!');
      await page.focus('#elsewhere');
      await expect(page.locator('#field')).toHaveValue('refreshed');
    }
    else {
      // the default: the state's value wins at once
      await expect(page.locator('#field')).toHaveValue('refreshed');
    }
  }
  await page.evaluate(() => window.view.destroy());
});
