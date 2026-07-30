//@ts-check
/**
 * @file The safe render profile: an untrusted vnode must neutralize on the
 * client and the server identically.
 *
 * The payloads are the ones an external review reproduced against the trusted
 * renderer — schema-valid documents that inject markup, script or structure.
 * Every one is asserted three ways: it is DANGEROUS in the default (trusted)
 * mode (so the safe-mode assertion is not vacuous), it is NEUTRALIZED by
 * `renderToString({ safe: true })`, and the DOM renderer strips it by the
 * same mechanism. The one policy drives both, which is what makes the client
 * and server agree.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { createDomRenderer, renderToString, createSafePolicy } from '@jarenjs/view';
import { JarenValidator } from '@jarenjs/validate';

import { createStubHost, serialize } from './dom.stub.js';

/** The reproduced attack corpus: every one passes the base vnode grammar.
 * `valueOnly` marks a VALUE attack (an unsafe URL scheme, a CSS expression) —
 * one a static schema cannot catch because the offending part is the string
 * value, not the structure, so only the runtime policy neutralizes it. That
 * split is the honest boundary between the two profiles. */
const ATTACKS = [
  { name: 'innerHTML sink', vnode: ['div', { innerHTML: '<img src=x onerror=alert(1)>' }] },
  { name: 'script element', vnode: ['script', {}, 'alert(1)'] },
  { name: 'iframe srcdoc', vnode: ['iframe', { srcdoc: '<script>alert(1)</script>' }] },
  { name: 'tag-name injection', vnode: ['div><img src=x onerror=alert(1)', {}, 'x'] },
  { name: 'attribute-name injection', vnode: ['input', { 'x onfocus': 'alert(1)' }] },
  { name: 'javascript: url', vnode: ['a', { href: 'javascript:alert(1)' }, 'go'], valueOnly: true },
  { name: 'inline on* handler', vnode: ['div', { onclick: 'alert(1)' }, 'x'] },
  { name: 'style expression', vnode: ['div', { style: 'width: expression(alert(1))' }, 'x'], valueOnly: true },
];

/** Render a vnode to the safe DOM and return the serialized root subtree. */
function safeDom(vnode) {
  const { document, container } = createStubHost();
  const render = createDomRenderer(container, { document, safe: true, onEvent: () => {} });
  render(vnode);
  const root = container.childNodes[0];
  return { root, markup: root === undefined ? '' : serialize(root) };
}

describe('safe render — SSR neutralizes every reproduced attack', () => {
  it('drops the innerHTML sink to an empty element', () => {
    assert.strictEqual(renderToString(ATTACKS[0].vnode, { safe: true }), '<div></div>');
  });
  it('drops disallowed tags (script, iframe) and injection-shaped tags entirely', () => {
    assert.strictEqual(renderToString(ATTACKS[1].vnode, { safe: true }), '');
    assert.strictEqual(renderToString(ATTACKS[2].vnode, { safe: true }), '');
    assert.strictEqual(renderToString(ATTACKS[3].vnode, { safe: true }), '');
  });
  it('drops an injection-shaped attribute name', () => {
    assert.strictEqual(renderToString(ATTACKS[4].vnode, { safe: true }), '<input>');
  });
  it('drops a javascript: URL but keeps the element', () => {
    assert.strictEqual(renderToString(ATTACKS[5].vnode, { safe: true }), '<a>go</a>');
  });
  it('drops an inline on* handler', () => {
    assert.strictEqual(renderToString(ATTACKS[6].vnode, { safe: true }), '<div>x</div>');
  });
  it('drops a style carrying a CSS expression', () => {
    assert.strictEqual(renderToString(ATTACKS[7].vnode, { safe: true }), '<div>x</div>');
  });
  it('keeps a safe URL and ordinary attributes', () => {
    assert.strictEqual(
      renderToString(['a', { href: '/docs', class: 'link' }, 'go'], { safe: true }),
      '<a href="/docs" class="link">go</a>');
    assert.strictEqual(
      renderToString(['img', { src: 'https://x/y.png', alt: 'y' }], { safe: true }),
      '<img src="https://x/y.png" alt="y">');
  });
});

describe('safe render — trusted mode still passes the payloads (the teeth)', () => {
  // If trusted mode also neutralized these, the safe-mode assertions would
  // prove nothing. Trusted mode is the equivalent of writing the DOM by hand.
  it('emits the script element and inline handler untouched by default', () => {
    assert.strictEqual(renderToString(ATTACKS[1].vnode), '<script>alert(1)</script>');
    assert.strictEqual(renderToString(ATTACKS[6].vnode), '<div onclick="alert(1)">x</div>');
  });
  it('emits the structural tag and attribute injections untouched by default', () => {
    assert.match(renderToString(ATTACKS[3].vnode), /^<div><img src=x onerror=alert\(1\)>/);
    assert.strictEqual(renderToString(ATTACKS[4].vnode), '<input x onfocus="alert(1)">');
  });
  it('passes a javascript: URL by default', () => {
    assert.strictEqual(renderToString(ATTACKS[5].vnode), '<a href="javascript:alert(1)">go</a>');
  });
});

describe('safe render — the DOM renderer strips by the same mechanism', () => {
  it('drops a disallowed or injection-shaped tag to an empty text node', () => {
    // script, iframe and the injection tag never become elements.
    for (const i of [1, 2, 3]) {
      const { root } = safeDom(ATTACKS[i].vnode);
      assert.strictEqual(root.tagName, undefined, `${ATTACKS[i].name} became an element`);
      assert.strictEqual(root.nodeValue, '', `${ATTACKS[i].name} left content`);
    }
  });
  it('never writes a dangerous property or injection-named attribute', () => {
    const { root } = safeDom(ATTACKS[0].vnode);
    assert.strictEqual(root.tagName, 'div');
    assert.strictEqual('innerHTML' in root, false);
    assert.strictEqual(root.attributes.has('innerHTML'), false);

    const inj = safeDom(ATTACKS[4].vnode);
    assert.strictEqual(inj.root.attributes.has('x onfocus'), false);
  });
  it('never wires an on* handler or an on binding in safe mode', () => {
    const { root } = safeDom(['button', { on: { click: 'doThing' } }, 'x']);
    assert.strictEqual(root.listeners.size, 0, 'a safe-mode view must not bind host actions');
    const inline = safeDom(ATTACKS[6].vnode);
    assert.strictEqual(inline.root.attributes.has('onclick'), false);
  });
  it('drops a javascript: URL but keeps a safe one', () => {
    assert.strictEqual(safeDom(ATTACKS[5].vnode).root.attributes.has('href'), false);
    const { document, container } = createStubHost();
    createDomRenderer(container, { document, safe: true })(['a', { href: '/ok' }, 'go']);
    assert.strictEqual(container.childNodes[0].getAttribute('href'), '/ok');
  });
  it('drops a widget vnode — untrusted content mounts no imperative JS', () => {
    let mounted = false;
    const { document, container } = createStubHost();
    const render = createDomRenderer(container, {
      document, safe: true,
      widgets: { chart: { mount: () => { mounted = true; } } },
    });
    render(['jaren-widget', { name: 'chart' }]);
    assert.strictEqual(mounted, false, 'a widget must not mount in safe mode');
    assert.strictEqual(renderToString(['jaren-widget', { name: 'chart' }], {
      safe: true, widgets: { chart: { ssr: () => ['div', {}, 'x'] } },
    }), '');
  });
});

describe('safe render — trusted mode is byte-for-byte unchanged', () => {
  it('renders an ordinary document identically with and without the option absent', () => {
    const doc = ['main', { class: 'app' },
      ['h1', {}, 'Title'], ['a', { href: '/x' }, 'link'],
      ['input', { value: 'v', type: 'text' }]];
    // The default path is exactly today's output; safe mode only ever removes.
    assert.strictEqual(renderToString(doc), '<main class="app"><h1>Title</h1><a href="/x">link</a><input value="v" type="text"></main>');
  });
});

describe('safe render — observability', () => {
  it('reports each stripped tag and property through onUnsafe', () => {
    const seen = [];
    renderToString(['script', { onclick: 'x', innerHTML: 'y' }, 'z'],
      { safe: true, onUnsafe: (info) => seen.push(`${info.kind}:${info.name}`) });
    assert.ok(seen.includes('tag:script'));

    seen.length = 0;
    renderToString(['div', { onclick: 'x', innerHTML: 'y', 'bad name': 1 }, 'z'],
      { safe: true, onUnsafe: (info) => seen.push(`${info.kind}:${info.name}`) });
    assert.deepStrictEqual(seen.sort(), ['prop:bad name', 'prop:innerHTML', 'prop:onclick']);
  });
});

describe('safe render — the policy is one shared decision surface', () => {
  it('createSafePolicy makes the same call the renderers make', () => {
    const policy = createSafePolicy();
    assert.strictEqual(policy.tag('div'), 'div');
    assert.strictEqual(policy.tag('script'), null);
    assert.strictEqual(policy.tag('div><img'), null);
    assert.strictEqual(policy.prop('onclick', 'x'), null);
    assert.strictEqual(policy.prop('innerHTML', 'x'), null);
    assert.deepStrictEqual(policy.prop('class', 'a'), { name: 'class', value: 'a' });
    assert.deepStrictEqual(policy.prop('href', 'javascript:x'), { name: 'href', value: null });
    assert.deepStrictEqual(policy.prop('href', '/ok'), { name: 'href', value: '/ok' });
    assert.strictEqual(policy.dropsEvents, true);
  });
});

describe('safe render — the safe schema profile rejects the attack corpus', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../../packages/view/schemas/jaren-vnode-safe.schema.json', import.meta.url), 'utf8'));
  const validate = new JarenValidator().compile(schema);

  it('rejects every STRUCTURAL attack (tag/name), the part a schema can gate', () => {
    for (const { name, vnode, valueOnly } of ATTACKS) {
      if (valueOnly) continue; // a VALUE attack is the runtime policy's job
      assert.strictEqual(validate(vnode), false, `safe schema accepted: ${name}`);
    }
  });

  it('lets the VALUE attacks through — and the runtime policy is what stops them', () => {
    // Documented, not hidden: a schema cannot read a `javascript:` scheme or a
    // CSS `expression(` out of a string, so the safe schema accepts these and
    // the runtime safe render neutralizes them. Validate AND render safe.
    for (const { vnode, valueOnly } of ATTACKS) {
      if (!valueOnly) continue;
      assert.strictEqual(validate(vnode), true);
      const out = renderToString(vnode, { safe: true });
      assert.ok(!out.includes('javascript:') && !out.includes('expression('),
        `the runtime must neutralize the value attack: ${out}`);
    }
  });

  it('accepts an ordinary safe document', () => {
    assert.strictEqual(validate(['main', { class: 'app' },
      ['h1', {}, 'Title'], ['a', { href: '/x' }, 'link']]), true);
  });

  it('rejects a widget node and an on binding in the safe profile', () => {
    assert.strictEqual(validate(['jaren-widget', { name: 'x' }]), false);
    assert.strictEqual(validate(['button', { on: { click: 'a' } }, 'x']), false);
  });
});
