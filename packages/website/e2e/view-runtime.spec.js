import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { renderToString } from '../../view/src/index.js';
import { CONTROLLED_CORPUS, SAFE_CORPUS } from '../../../test/view/interactive-corpus.js';

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


test('reflected zero, negative and fractional numbers and non-boolean flags match SSR through patch and hydration', async ({ page }) => {
  const failures = await page.evaluate(() => {
    const { createDomRenderer, renderToString } = window.JarenTest;
    const host = document.getElementById('host');
    const parsed = document.createElement('div');
    const failures = [];
    const cases = [
      ['input', 'size', [0, -1, 2.5]],
      ['select', 'size', [0, -1, 2.5]],
      ['textarea', 'rows', [0, -1, 2.5]],
      ['img', 'width', [0, -1, 2.5]],
      ['canvas', 'height', [0, -1, 2.5]],
      ['ol', 'start', [0, -1, 2.5]],
      ['progress', 'value', [0, -1, 2.5]],
      ['meter', 'max', [0, -1, 2.5]],
      ['button', 'disabled', [0, '', 'false', false, true]],
      ['option', 'selected', [true, false, 0, '', 'false', null]],
      ['audio', 'muted', [true, false, 0, '', 'false', null]],
    ];
    for (const safe of [false, true]) {
      for (const [tag, name, values] of cases) {
        const render = createDomRenderer(host, { safe });
        render([tag, { [name]: 5 }]);
        const mounted = host.firstChild;
        for (const value of values) {
          const vnode = [tag, { [name]: value }];
          render(vnode);
          parsed.innerHTML = renderToString(vnode, { safe });
          if (host.firstChild !== mounted || host.innerHTML !== parsed.innerHTML) {
            failures.push({ safe, tag, name, value, phase: 'patch', dom: host.innerHTML, ssr: parsed.innerHTML });
          }
          if (!safe && typeof host.firstChild[name] === 'boolean' && host.firstChild[name] !== parsed.firstChild[name]) {
            failures.push({ tag, name, value, phase: 'live-property', dom: host.firstChild[name], ssr: parsed.firstChild[name] });
          }
          const hydrate = createDomRenderer(parsed, { safe, hydrate: true });
          hydrate(vnode);
          if (host.innerHTML !== parsed.innerHTML) {
            failures.push({ safe, tag, name, value, phase: 'hydrate', dom: host.innerHTML, ssr: parsed.innerHTML });
          }
          hydrate.destroy();
        }
        render.destroy();
      }
    }
    return failures;
  });
  expect(failures).toEqual([]);
});

test('interactive profile: the safe corpus renders as safe does, in the DOM and the serializer', async ({ page }) => {
  const result = await page.evaluate((corpus) => {
    const { createDomRenderer, renderToString } = window.JarenTest;
    const safeHost = document.createElement('div'), interactiveHost = document.createElement('div');
    document.body.append(safeHost, interactiveHost);
    window.attacked = false;
    let events = 0;
    // two live roots on one page: one namespace given to both, so their ids compare
    const safe = createDomRenderer(safeHost, { safe: true, idPrefix: 'jaren-u-', onEvent: () => events++ });
    const interactive = createDomRenderer(interactiveHost, { safe: 'interactive', idPrefix: 'jaren-u-', onEvent: () => events++ });
    const failures = [];
    for (const { name, vnode } of corpus) {
      for (const frame of [['div', { key: 'same' }, 'before'], vnode, ['span', {}, 'removed'], vnode]) {
        safe(frame); interactive(frame);
        const parsed = document.createElement('div');
        // Test-only: compare how the browser parses the interactive serializer.
        parsed.innerHTML = renderToString(frame, { safe: 'interactive' });
        if (interactiveHost.innerHTML !== safeHost.innerHTML || interactiveHost.innerHTML !== parsed.innerHTML) {
          failures.push({ name, safe: safeHost.innerHTML, interactive: interactiveHost.innerHTML, ssr: parsed.innerHTML });
        }
        interactiveHost.firstElementChild?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }
    safe.destroy(); interactive.destroy();
    return { failures, events, attacked: window.attacked };
  }, SAFE_CORPUS);
  expect(result).toEqual({ failures: [], events: 0, attacked: false });
});

test('interactive profile: a textarea and a select show the value the serializer writes', async ({ page }) => {
  const failures = await page.evaluate((corpus) => {
    const { createDomRenderer, renderToString } = window.JarenTest;
    const host = document.createElement('div');
    document.body.append(host);
    const render = createDomRenderer(host, { safe: 'interactive', onEvent: () => {} });
    const state = (node) => ({ value: node.value, selected: [...(node.options ?? [])].map((o) => o.selected) });
    const failures = [];
    for (const { name, vnode } of corpus) {
      for (const frame of [['div', { key: 'same' }, 'before'], vnode, ['span', {}, 'removed'], vnode]) {
        render(frame);
        if (frame !== vnode) continue;
        const parsed = document.createElement('div');
        // Test-only: compare how the browser parses the interactive serializer.
        parsed.innerHTML = renderToString(frame, { safe: 'interactive' });
        const live = state(host.firstElementChild), server = state(parsed.firstElementChild);
        if (JSON.stringify(live) !== JSON.stringify(server) || host.firstElementChild.hasAttribute('value')) failures.push({ name, live, server });
      }
    }
    render.destroy();
    return failures;
  }, CONTROLLED_CORPUS);
  expect(failures).toEqual([]);
});

test('interactive profile: only gesture bindings fire, and the handler sees data, never the Event', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({ content: '@keyframes host-spin { from { opacity: 0.5 } to { opacity: 1 } }' });
  await page.evaluate(() => {
    const { createDomRenderer } = window.JarenTest;
    const host = document.getElementById('host');
    window.fired = [];
    window.leaks = [];
    const scan = (value, path) => {
      if (value === null || typeof value !== 'object') return;
      if (value instanceof Event || value instanceof Node || value === window) window.leaks.push(path);
      for (const key of Object.keys(value)) scan(value[key], `${path}.${key}`);
    };
    const render = createDomRenderer(host, {
      safe: 'interactive',
      onEvent: (binding, event) => {
        if (event instanceof Event) window.leaks.push('event');
        scan(event, 'event');
        if (!Object.isFrozen(event)) window.leaks.push('not frozen');
        window.fired.push({ binding, type: event.type, key: event.key, value: event.target.value });
      },
    });
    render(['div', {},
      ['button', { id: 'go', on: { click: { action: 'go', with: { n: 1 } }, mouseover: 'hover', focus: 'focus' } }, 'Go'],
      ['img', { src: '/missing.png', on: { error: 'auto-error', load: 'auto-load' } }],
      ['details', { open: true, on: { toggle: 'auto-toggle' } }, ['summary', {}, 's'], 'body'],
      ['input', { id: 'auto', autofocus: true, on: { focus: 'auto-focus', focusin: 'auto-focusin' } }],
      ['div', { id: 'spin', style: 'animation: host-spin 20ms 2', on: { animationstart: 'auto-anim', animationend: 'auto-anim', animationiteration: 'auto-anim' } }, 'spin'],
      ['input', { id: 'name', on: { input: 'typed', keydown: 'key' } }],
      ['input', { id: 'secret', type: 'password', on: { input: 'secret-typed', keydown: 'secret-key' } }],
    ]);
  });
  await page.waitForTimeout(300);
  await page.hover('#jaren-u-go');
  await page.click('#jaren-u-go');
  await page.type('#jaren-u-name', 'ab');
  await page.type('#jaren-u-secret', 'pw');
  const result = await page.evaluate(() => ({ fired: window.fired, leaks: window.leaks }));
  expect(result.leaks).toEqual([]);
  expect(result.fired).toEqual([
    { binding: { action: 'go', with: { n: 1 } }, type: 'click', key: null, value: '' },
    { binding: 'key', type: 'keydown', key: 'a', value: '' },
    { binding: 'typed', type: 'input', key: null, value: 'a' },
    { binding: 'key', type: 'keydown', key: 'b', value: 'a' },
    { binding: 'typed', type: 'input', key: null, value: 'ab' },
    { binding: 'secret-key', type: 'keydown', key: null, value: null },
    { binding: 'secret-typed', type: 'input', key: null, value: null },
    { binding: 'secret-key', type: 'keydown', key: null, value: null },
    { binding: 'secret-typed', type: 'input', key: null, value: null },
  ]);
});

test('the teeth of the gesture allow-list: trusted rendering of the same nodes fires the bindings with no gesture', async ({ page }) => {
  await page.addStyleTag({ content: '@keyframes host-spin { from { opacity: 0.5 } to { opacity: 1 } }' });
  await page.evaluate(() => {
    window.fired = [];
    const render = window.JarenTest.createDomRenderer(document.getElementById('host'), { onEvent: (binding) => window.fired.push(binding) });
    render(['div', {},
      ['img', { src: '/missing.png', on: { error: 'auto-error' } }],
      ['details', { open: true, on: { toggle: 'auto-toggle' } }, ['summary', {}, 's'], 'body'],
      ['input', { autofocus: true, on: { focus: 'auto-focus' } }],
      ['div', { style: 'animation: host-spin 20ms 2', on: { animationstart: 'auto-anim' } }, 'spin'],
    ]);
  });
  await page.waitForTimeout(300);
  const fired = await page.evaluate(() => [...new Set(window.fired)].sort());
  // the image error and the CSS animation fire in every engine; autofocus and
  // a toggle on a node inserted after load are engine-dependent extras
  expect(fired).toEqual(expect.arrayContaining(['auto-anim', 'auto-error']));
});

test('interactive profile controls an input: a state change resets what the user typed', async ({ page }) => {
  await page.evaluate(() => {
    const host = document.getElementById('host');
    window.renderField = window.JarenTest.createDomRenderer(host, { safe: 'interactive', onEvent: () => {} });
    window.renderField(['input', { id: 'field', value: 'start' }]);
  });
  await page.fill('#jaren-u-field', 'typed');
  const after = await page.evaluate(() => {
    window.renderField(['input', { id: 'field', value: '' }]);
    const field = document.getElementById('jaren-u-field');
    return { value: field.value, attribute: field.getAttribute('value') };
  });
  // the state's value wins, and the attribute is what the serializer writes
  expect(after).toEqual({ value: '', attribute: '' });
});

const appBundle = await build({ stdin: { contents: "export { createApp } from '@jarenjs/app'; export { createDialogWidget } from '@jarenjs/app/dialog';", resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'JarenAppTest' });

test('interactive app: a granted dialog renders hostile content sanitized, and its data binding runs a declared action', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addScriptTag({ content: appBundle.outputFiles[0].text });
  await page.evaluate(() => {
    const { createApp, createDialogWidget } = window.JarenAppTest;
    window.attacked = false;
    window.seen = [];
    window.mounted = [];
    const content = [
      ['div', { id: 'payload', innerHTML: '<img src=x onerror="window.attacked=true">' }, 'text'],
      ['img', { src: 'x', onerror: 'window.attacked=true' }],
      ['a', { id: 'link', href: 'javascript:window.attacked=true' }, 'link'],
      ['button', { id: 'pick', on: { click: { action: 'pick', with: 3 } } }, 'Pick'],
      ['jaren-widget', { name: 'chart' }],
    ];
    window.app = createApp({
      state: { picked: null, open: true },
      actions: { pick: { patch: [{ op: 'replace', path: '/picked', value: '$payload' }] }, close: { patch: [{ op: 'replace', path: '/open', value: false }] } },
      view: [{ match: '$', body: ['jaren-widget', { name: 'dialog', props: { id: 'd', title: 'Hostile', open: '$.open', content, close: 'close' } }] }],
    }, {
      node: document.getElementById('host'), safe: 'interactive',
      onUnsafe: (info) => window.seen.push(`${info.kind}:${info.name}`),
      widgets: { dialog: createDialogWidget(), chart: { mount: () => window.mounted.push('chart') } },
      capabilities: { widgets: ['dialog'] },
    });
  });
  await page.click('#jaren-u-pick');
  await page.waitForTimeout(100);
  const result = await page.evaluate(() => ({
    picked: window.app.getState().picked,
    attacked: window.attacked,
    mounted: window.mounted,
    // a stripped node is reported on every frame it appears: compare the set
    seen: [...new Set(window.seen)].sort(),
    payload: document.getElementById('jaren-u-payload').outerHTML,
    href: document.getElementById('jaren-u-link').hasAttribute('href'),
    modal: document.querySelector('dialog').open,
  }));
  expect(result).toEqual({
    picked: 3, attacked: false, mounted: [],
    seen: ['prop:href', 'prop:innerHTML', 'prop:onerror', 'widget:chart'],
    payload: '<div id="jaren-u-payload">text</div>', href: false, modal: true,
  });
});

for (const safe of [true, 'interactive']) {
  test(`safe profile ${JSON.stringify(safe)}: references reach only the document's elements, and its forms send nothing`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('afterbegin', '<input id="x" value="host"><div id="pop" popover>host pop</div>'
        + '<form id="f" action="/host-submit"><input name="csrf" value="token"></form>');
    });
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    const before = page.url();
    const result = await page.evaluate((safe) => {
      const { createDomRenderer, renderToString } = window.JarenTest;
      const host = document.getElementById('host');
      window.submits = [];
      const vnode = ['div', {},
        ['label', { for: 'x', id: 'label' }, 'Name'], ['input', { id: 'x' }],
        ['button', { id: 'opener', popovertarget: 'pop' }, 'open'], ['div', { id: 'pop', popover: 'auto' }, 'doc pop'],
        ['p', { id: 'described', 'aria-labelledby': 'label x' }, 'p'],
        ['button', { id: 'cross', form: 'f', type: 'submit' }, 'host form?'],
        ['form', { id: 'login', name: 'cookie', action: 'https://evil.test/collect', method: 'post', target: '_top', on: { submit: { action: 'login' } } },
          ['input', { id: 'pw', type: 'password', name: 'pw', autocomplete: 'current-password' }],
          ['button', { id: 'go', formaction: 'https://evil.test/', formmethod: 'post' }, 'Go']],
        ['img', { name: 'forms', alt: 'i', src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }]];
      createDomRenderer(host, { safe, onEvent: (binding, event) => window.submits.push([binding, event.type]) })(vnode);
      const parsed = document.createElement('div');
      parsed.innerHTML = renderToString(vnode, { safe });
      const docInput = host.querySelector('input:not([type])');
      document.getElementById('jaren-u-pw').value = 'hunter2'; // what autofill does
      return {
        matchesSsr: host.innerHTML === parsed.innerHTML,
        labelControl: host.querySelector('label').control === docInput,
        popoverTarget: host.querySelector('#jaren-u-opener').popoverTargetElement === host.querySelector('[popover]'),
        crossForm: host.querySelector('#jaren-u-cross').form,
        hostX: document.getElementById('x').value,
        // a clobbered cookie would read as the document's element (reading the
        // real one is refused on this test page, which is no element either)
        cookie: (() => { try { return document.cookie instanceof Element; } catch { return false; } })(),
        named: document['jaren-u-cookie'] === host.querySelector('form'),
        forms: document.forms instanceof HTMLCollection,
        method: host.querySelector('form').method,
        action: host.querySelector('form').getAttribute('action'),
      };
    }, safe);
    await page.click('#jaren-u-go');
    await page.click('#jaren-u-cross');
    await page.focus('#jaren-u-pw');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({ submits: window.submits, stillHere: !!document.getElementById('jaren-u-pw'), pw: document.getElementById('jaren-u-pw').value }));
    expect(result).toEqual({ matchesSsr: true, labelControl: true, popoverTarget: true, crossForm: null, hostX: 'host',
      cookie: false, named: true, forms: true, method: 'dialog', action: null });
    expect(page.url()).toBe(before);
    expect(requests).toEqual([]);
    expect(after.stillHere).toBe(true);
    expect(after.submits).toEqual(safe === 'interactive' ? [[{ action: 'login' }, 'submit'], [{ action: 'login' }, 'submit']] : []);
  });
}

test('a safe root reports a prefixed name of document the page already holds, by name or by id', async ({ page }) => {
  const result = await page.evaluate(() => {
    const host = document.getElementById('host');
    // Test-only host markup: the page's own elements before the root.
    host.insertAdjacentHTML('beforebegin', '<object id="jaren-u-logo"></object><form name="jaren-u-pic"></form>'
      + '<img id="jaren-u-alt" name="other"><form id="jaren-u-ok"></form><img id="jaren-u-bare">');
    const seen = [];
    const render = window.JarenTest.createDomRenderer(host, { safe: true, onUnsafe: (info) => seen.push(`${info.kind}:${info.name}`) });
    render(['div', {}, ['img', { name: 'logo' }], ['img', { id: 'pic', name: 'p' }], ['form', { name: 'alt' }],
      ['img', { name: 'ok' }], ['img', { name: 'bare' }]]);
    const kind = (key) => {
      const value = document[key];
      return value instanceof HTMLCollection ? `collection(${value.length})` : host.contains(value) ? 'own' : String(value);
    };
    return { seen, answers: ['jaren-u-logo', 'jaren-u-pic', 'jaren-u-alt', 'jaren-u-ok', 'jaren-u-bare'].map(kind) };
  });
  expect(result).toEqual({
    seen: ['name:jaren-u-logo', 'name:jaren-u-pic', 'name:jaren-u-alt'],
    answers: ['collection(2)', 'collection(2)', 'collection(2)', 'own', 'own'],
  });
});

test('a form whose controls are named after its DOM members neither throws nor hangs a pass, and stays a form to the policy', async ({ page }) => {
  const result = await page.evaluate(() => {
    const host = document.getElementById('host');
    const names = ['parentNode', 'getAttribute', 'namespaceURI', 'localName'];
    // Test-only host markup: a page form holding a prefixed name, its controls named after the same members.
    host.insertAdjacentHTML('beforebegin', `<form name="jaren-u-g">${names.map((name) => `<input name="${name}">`).join('')}</form>`);
    const seen = [];
    const controls = (value) => ['form', { name: 'f' }, ...names.map((name) => ['input', { name }]), ['input', { value }]];
    const render = window.JarenTest.createDomRenderer(host, { safe: 'interactive', onUnsafe: (info) => seen.push(`${info.kind}:${info.name}`) });
    render(['div', {}, controls('typed'), ['form', { name: 'g' }]]);
    render(['div', {}, controls('next'), ['form', { name: 'g' }]]);
    const value = host.querySelectorAll('input')[4].value;
    // a patch deciding the form's props as some other tag would write where it sends
    render(['div', {}, ['form', { action: 'https://example.invalid/', method: 'post', target: '_blank', name: 'f' }, ...controls('next').slice(2)]]);
    const form = host.querySelector('form');
    // the form's own members are shadowed by its controls: read it through Element's
    const attributes = Element.prototype.getAttributeNames.call(form);
    return { seen, value, form: attributes.map((name) => `${name}=${Element.prototype.getAttribute.call(form, name)}`) };
  });
  expect(result).toEqual({ seen: ['name:jaren-u-g', 'prop:action', 'prop:method', 'prop:target'], value: 'next',
    form: ['method=dialog', 'name=jaren-u-f'] });
});

test('a form control named after any DOM member renders, patches, hydrates and binds as the serializer writes it', async ({ page }) => {
  const failures = await page.evaluate(() => {
    const J = window.JarenTest;
    // every member a form has, from the engine's own interfaces
    const members = [...new Set([EventTarget, Node, Element, HTMLElement, HTMLFormElement]
      .flatMap((type) => Object.getOwnPropertyNames(type.prototype)))].filter((name) => !/^[A-Z_]+$/.test(name));
    const frames = (c) => [
      ['form', { class: 'a' }, c, ['b', { key: 1 }, '1'], ['b', { key: 2 }, '2']],
      ['form', { class: 'b', title: 't' }, c, ['i', {}, 'new'], ['b', { key: 2 }, '2'], ['b', { key: 1 }, '1']],
      ['form', { dir: 'rtl' }, c, ['b', { key: 1 }, '1']],
      ['form', { 'aria-label': 'x' }, c],
      ['form', { lang: 'en' }, c, ['s', {}, 'end']],
    ];
    const failed = [];
    const check = (label, host, vnode, safe) => {
      const want = J.renderToString(vnode, { safe });
      if (host.innerHTML !== want) failed.push(`${label}: ${host.innerHTML}`);
    };
    const host = document.getElementById('host');
    for (const safe of [undefined, true, 'interactive']) for (const attr of safe ? ['name'] : ['name', 'id']) for (const member of members) {
      const label = `${member} by ${attr}, safe ${safe}`;
      try {
        host.textContent = '';
        const render = J.createDomRenderer(host, { safe });
        for (const frame of frames(['input', { [attr]: member }])) { render(frame); check(label, host, frame, safe); }
        render.destroy();
        // a document without a defaultView, as createHTMLDocument and DOMParser make
        const other = document.implementation.createHTMLDocument('').body;
        const renderOther = J.createDomRenderer(other, { safe });
        for (const frame of frames(['input', { [attr]: member }])) { renderOther(frame); check(`${label}, no defaultView`, other, frame, safe); }
        if (safe === undefined) {
          // hydration adopts the server's form, through the members it reads
          const server = frames(['input', { [attr]: member }])[0];
          host.innerHTML = J.renderToString(server);
          const adopted = host.firstChild;
          const hydrated = J.createDomRenderer(host, { hydrate: true });
          hydrated(server);
          const next = frames(['input', { [attr]: member }])[1];
          hydrated(next);
          check(`${label}, hydrated`, host, next, safe);
          if (host.firstChild !== adopted) failed.push(`${label}: the server form was not adopted`);
          hydrated.destroy();
          // a form's own binding, bound and unbound
          const seen = [];
          const bound = J.createDomRenderer(host, { onEvent: (binding) => seen.push(binding) });
          bound(['form', { on: { click: 'save' } }, ['input', { [attr]: member }], ['button', { type: 'button' }, 'go']]);
          host.querySelector('button').click();
          bound(['form', {}, ['input', { [attr]: member }], ['button', { type: 'button' }, 'go']]);
          host.querySelector('button').click();
          if (seen.join() !== 'save') failed.push(`${label}: bindings fired ${JSON.stringify(seen)}`);
          bound.destroy();
        }
        if (safe === 'interactive') {
          // a binding around the form: delivery walks up from the target through the form
          const seen = [];
          const outer = J.createDomRenderer(host, { safe, onEvent: (binding) => seen.push(binding) });
          outer(['div', { on: { click: 'pick' } }, ['form', {}, ['input', { [attr]: member }], ['button', { type: 'button' }, 'go']]]);
          host.querySelector('button').click();
          if (seen.join() !== 'pick') failed.push(`${label}: delivered ${JSON.stringify(seen)}`);
          outer.destroy();
        }
      }
      catch (error) {
        failed.push(`${label}: ${error}`);
      }
    }
    // a prop the form has no property of, named like one of its controls, is the form's attribute
    for (const name of ['foo', 'aria-label', 'data-x']) {
      try {
        host.textContent = '';
        const render = J.createDomRenderer(host);
        for (const props of [{ [name]: 'a' }, { [name]: 'b' }, {}]) {
          const frame = ['form', props, ['input', { name }]];
          render(frame);
          check(`prop ${name}`, host, frame, undefined);
        }
        render.destroy();
      }
      catch (error) {
        failed.push(`prop ${name}: ${error}`);
      }
    }
    return failed;
  });
  expect(failures).toEqual([]);
});

test('a form control named after any key the renderer once kept on a node binds and unmounts as under any other name', async ({ page }) => {
  const failures = await page.evaluate(() => {
    const J = window.JarenTest;
    const keys = ['x', '__jarenOn', '__jarenEmit', '__jarenWidget', '__jarenControlled', '__jarenComposition',
      '__jarenComposing', '__jarenDeferred', '__jarenDeferFocused', '__jarenSecret'];
    const failed = [];
    const host = document.getElementById('host');
    for (const key of keys) for (const safe of [undefined, 'interactive']) {
      const label = `${key}, safe ${safe}`;
      try {
        host.textContent = '';
        const seen = [];
        const render = J.createDomRenderer(host, { safe, onEvent: (binding) => seen.push(binding) });
        const frames = [
          ['form', { on: { click: 'save' } }, ['input', { name: key }], ['button', { type: 'button' }, 'go']],
          ['form', { on: { click: 'again' } }, ['input', { name: key }], ['button', { type: 'button' }, 'go']],
          ['form', {}, ['input', { name: key }], ['button', { type: 'button' }, 'go']],
        ];
        for (const frame of frames) { render(frame); host.querySelector('button').click(); }
        if (JSON.stringify(seen) !== '["save","again"]') failed.push(`${label}: bindings fired ${JSON.stringify(seen)}`);
        if (host.innerHTML !== J.renderToString(frames[2], { safe })) failed.push(`${label}: ${host.innerHTML}`);
        render.destroy();
        if (safe === undefined) {
          // the widgets inside such a form unmount when it leaves
          const log = [];
          const widgets = { w: { mount: () => { log.push('mount'); return 1; }, unmount: () => { log.push('unmount'); } } };
          const withWidget = J.createDomRenderer(host, { widgets });
          withWidget(['div', {}, ['form', {}, ['input', { name: key }], ['jaren-widget', { name: 'w' }]]]);
          withWidget(['div', {}, ['form', { title: 'b' }, ['input', { name: key }], ['jaren-widget', { name: 'w' }]]]);
          withWidget(['p', {}, 'gone']);
          if (log.join() !== 'mount,unmount') failed.push(`${label}: widget ${log.join()}`);
          withWidget.destroy();
          // a form widget host whose widget names a control after the key stays a host
          const hostLog = [];
          const formWidget = { mount: (node) => { hostLog.push('mount'); const c = node.ownerDocument.createElement('input'); c.name = key; node.appendChild(c); return 1; },
            update: () => { hostLog.push('update'); }, unmount: () => { hostLog.push('unmount'); } };
          const withHost = J.createDomRenderer(host, { widgets: { f: formWidget } });
          withHost(['div', {}, ['jaren-widget', { name: 'f', tag: 'form', props: { n: 1 } }]]);
          withHost(['div', {}, ['jaren-widget', { name: 'f', tag: 'form', props: { n: 2 } }]]);
          withHost(['p', {}, 'gone']);
          if (hostLog.join() !== 'mount,update,unmount') failed.push(`${label}: form host ${hostLog.join()}`);
          withHost.destroy();
        }
      }
      catch (error) {
        failed.push(`${label}: ${error}`);
      }
    }
    return failed;
  });
  expect(failures).toEqual([]);
});

test('a document element named after a document member leaves the render, its reports and focus as under any other name', async ({ page }) => {
  const failures = await page.evaluate(() => {
    const J = window.JarenTest;
    const failed = [];
    const host = document.getElementById('host');
    for (const tag of ['img', 'form', 'embed', 'object', 'iframe']) for (const member of ['x', 'createElement', 'createElementNS', 'createTextNode']) {
      const label = `${tag} named ${member}`;
      try {
        host.textContent = '';
        const render = J.createDomRenderer(host);
        const frames = [['div', {}, [tag, { name: member }]], ['div', {}, [tag, { name: member }], ['p', {}, 'x'], ['svg', {}, ['g', {}]]]];
        for (const frame of frames) render(frame);
        if (host.innerHTML !== J.renderToString(frames[1])) failed.push(`${label}: ${host.innerHTML}`);
        // a safe root of the same document builds too
        const section = host.firstChild.appendChild(Document.prototype.createElement.call(document, 'section'));
        J.createDomRenderer(section, { safe: true })(['p', { class: 'c' }, 'safe']);
        if (section.innerHTML !== '<p class="c">safe</p>') failed.push(`${label}, safe root: ${section.innerHTML}`);
        render.destroy();
      }
      catch (error) {
        failed.push(`${label}: ${error}`);
      }
    }
    // a safe root's reports of a prefixed id and name the page holds
    for (const [member, page, inner, want] of [
      ['getElementById', ['p', { id: 'jaren-u-a' }], ['p', { id: 'a' }], [{ kind: 'id', name: 'jaren-u-a' }]],
      ['querySelectorAll', ['form', { name: 'jaren-u-f' }], ['form', { name: 'f' }], [{ kind: 'name', name: 'jaren-u-f' }]],
    ]) {
      for (const name of ['x', member]) {
        try {
          host.textContent = '';
          J.createDomRenderer(host)(['div', {}, ['img', { name }], page, ['section', {}]]);
          const reports = [];
          J.createDomRenderer(host.querySelector('section'), { safe: true, onUnsafe: (r) => reports.push(r) })(inner);
          if (JSON.stringify(reports) !== JSON.stringify(want)) failed.push(`report beside an img named ${name}: ${JSON.stringify(reports)}`);
        }
        catch (error) {
          failed.push(`report beside an img named ${name}: ${error}`);
        }
      }
    }
    // controlled: 'focus' holds a focused edit back beside an img named activeElement
    for (const name of ['x', 'activeElement']) {
      host.textContent = '';
      const render = J.createDomRenderer(host, { controlled: 'focus' });
      render(['div', {}, ['img', { name }], ['input', { value: 'a' }]]);
      const input = host.querySelector('input');
      input.focus();
      input.value = 'typed';
      render(['div', {}, ['img', { name }], ['input', { value: 'b' }]]);
      if (input.value !== 'typed') failed.push(`focused edit beside an img named ${name}: ${input.value}`);
      render.destroy();
    }
    host.textContent = '';
    return failed;
  });
  expect(failures).toEqual([]);
});
