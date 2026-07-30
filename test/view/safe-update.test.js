//@ts-check
/**
 * @file The safe profile across the UPDATE cycle, not just the first frame.
 *
 * An external re-audit of v0.22.32 found that the first-frame repair did not
 * hold on later frames: a widget stripped on frame one could mount on frame
 * two, a read-only property assignment could crash the render, a cleared URL
 * diverged between DOM and SSR, and a style payload smuggled through an object
 * KEY survived. Each is pinned here — the fix normalizes a rejected node to a
 * stable sentinel before the diff, writes attributes only in safe mode, and
 * validates style keys.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createDomRenderer, renderToString } from '@jarenjs/view';

import { createStubHost, serialize } from './dom.stub.js';

function safeHost(extra = {}) {
  const { document, container } = createStubHost();
  const render = createDomRenderer(container, { document, safe: true, ...extra });
  return { render, container };
}

describe('safe update cycle — a stripped widget can never mount later', () => {
  it('does not mount a widget on the second frame that was stripped on the first', () => {
    const mounted = [];
    const h = safeHost({
      widgets: {
        first: { mount: () => mounted.push('first') },
        second: { mount: () => mounted.push('second') },
      },
    });
    h.render(['jaren-widget', { name: 'first' }]);
    h.render(['jaren-widget', { name: 'second' }]);
    assert.deepStrictEqual(mounted, [], 'no widget may mount in safe mode, on any frame');
    assert.strictEqual(serialize(h.container), '<div></div>', 'the host stays empty');
  });

  it('does not mount a widget that replaces a stripped element of the same key', () => {
    const mounted = [];
    const h = safeHost({ widgets: { w: { mount: () => mounted.push('w') } } });
    h.render(['div', { key: 'x' }, 'a']);
    h.render(['jaren-widget', { key: 'x', name: 'w' }]);
    assert.deepStrictEqual(mounted, []);
  });

  it('does not throw patching a blocked element in place of a real one', () => {
    const h = safeHost();
    h.render(['div', {}, 'ok']);
    assert.doesNotThrow(() => h.render(['script', {}, 'alert(1)']));
    assert.doesNotThrow(() => h.render(['div><img', {}, 'x']));
  });

  it('reports the stripped widget through onUnsafe on every frame it appears', () => {
    const seen = [];
    const h = safeHost({
      onUnsafe: (i) => seen.push(`${i.kind}:${i.name}`),
      widgets: { a: { mount() {} } },
    });
    h.render(['jaren-widget', { name: 'a' }]);
    assert.ok(seen.includes('widget:a'));
  });
});

describe('safe mode — attribute-only writes cannot crash or diverge from SSR', () => {
  it('does not throw assigning a read-only DOM property name', () => {
    // `input.files` is read-only; the trusted property path would throw and
    // abort the render. Safe mode writes the attribute instead.
    const h = safeHost();
    assert.doesNotThrow(() => h.render(['input', { files: 'x' }]));
    assert.strictEqual(h.container.childNodes[0].getAttribute('files'), 'x');
  });

  it('proves the teeth: the trusted property path really does throw here', () => {
    const { document, container } = createStubHost();
    const trusted = createDomRenderer(container, { document });
    assert.throws(() => trusted(['input', { files: 'x' }]),
      'the stub models files as read-only, as the browser does');
  });

  it('removes a cleared URL attribute, matching SSR omission (no empty reflection)', () => {
    const h = safeHost();
    h.render(['a', { href: 'javascript:alert(1)' }, 'go']);
    assert.strictEqual(h.container.childNodes[0].getAttribute('href'), null,
      'a cleared URL is removed, not left as an empty reflected attribute');
    assert.strictEqual(renderToString(['a', { href: 'javascript:alert(1)' }, 'go'], { safe: true }),
      '<a>go</a>');
  });

  it('clears a cleared URL on a later frame too', () => {
    const h = safeHost();
    h.render(['a', { href: '/ok' }, 'go']);
    assert.strictEqual(h.container.childNodes[0].getAttribute('href'), '/ok');
    h.render(['a', { href: 'javascript:alert(1)' }, 'go']);
    assert.strictEqual(h.container.childNodes[0].getAttribute('href'), null,
      'a good→bad URL transition removes the attribute');
  });
});

describe('safe mode — the is= customized-built-in escape', () => {
  it('denies the is attribute on both renderers', () => {
    // `is` upgrades an element to a registered customized built-in when the
    // markup is PARSED, so safe SSR emitting it would run host code.
    assert.strictEqual(renderToString(['button', { is: 'evil-button' }, 'x'], { safe: true }),
      '<button>x</button>');
    const h = safeHost();
    h.render(['button', { is: 'evil-button' }, 'x']);
    assert.strictEqual(h.container.childNodes[0].getAttribute('is'), null);
    // any casing
    assert.strictEqual(renderToString(['span', { IS: 'x' }, 'y'], { safe: true }), '<span>y</span>');
  });

  it('rejects is in the safe schema too', () => {
    // (validated in safe.test.js against the schema; pinned here for locality)
    assert.doesNotThrow(() => renderToString(['button', { is: 'x' }], { safe: true }));
  });
});

describe('safe/trusted — a non-vnode child fails closed to nothing', () => {
  it('renders a stray object child as empty on both the DOM and SSR', () => {
    // A malformed child (not text, not a valid element) must not become an
    // <undefined> element that skips the allow-list; it renders as nothing,
    // matching SSR.
    for (const safe of [false, true]) {
      const { document, container } = createStubHost();
      createDomRenderer(container, { document, safe })(['div', {}, { foo: 'bar' }, 'ok']);
      const div = container.childNodes[0];
      // the object child is an empty text node; only 'ok' shows
      assert.strictEqual(serialize(div), '<div>ok</div>', `safe=${safe}`);
      assert.strictEqual(renderToString(['div', {}, { foo: 'bar' }, 'ok'], { safe }), '<div>ok</div>');
    }
  });
});

describe('safe mode — style keys and URL lists', () => {
  it('drops a style whose payload hides in an object KEY', () => {
    const attack = ['div', { style: { 'color:red;background-image:url("javascript:alert(1)")': 'ok' } }, 'x'];
    assert.strictEqual(renderToString(attack, { safe: true }), '<div>x</div>');
    const h = safeHost();
    h.render(attack);
    assert.strictEqual(h.container.childNodes[0].getAttribute('style'), null);
  });

  it('keeps an ordinary object style', () => {
    assert.strictEqual(
      renderToString(['div', { style: { color: 'red', fontWeight: 'bold' } }, 'x'], { safe: true }),
      '<div style="color:red;font-weight:bold">x</div>');
  });

  it('drops a whole srcset when any candidate URL is unsafe, and keeps a clean one', () => {
    assert.strictEqual(
      renderToString(['img', { srcset: 'a.png 1x, javascript:alert(1) 2x' }], { safe: true }),
      '<img>');
    assert.strictEqual(
      renderToString(['img', { srcset: 'a.png 1x, b.png 2x' }], { safe: true }),
      '<img srcset="a.png 1x, b.png 2x">');
  });

  it('preserves a comma-bearing data: URL in srcset instead of corrupting it', () => {
    // The URL runs to whitespace, so the commas inside the base64 payload stay
    // part of the URL — the naive comma-split mangled this.
    assert.strictEqual(
      renderToString(['img', { srcset: 'data:image/png;base64,iVBORw0KGgo 1x, b.png 2x' }], { safe: true }),
      '<img srcset="data:image/png;base64,iVBORw0KGgo 1x, b.png 2x">');
  });

  it('validates every ping URL', () => {
    assert.strictEqual(renderToString(['a', { ping: '/ok javascript:alert(1)' }, 'go'], { safe: true }), '<a>go</a>');
    assert.strictEqual(renderToString(['a', { ping: '/one /two' }, 'go'], { safe: true }), '<a ping="/one /two">go</a>');
  });
});

describe('safe mode — onUnsafe reports events and widgets, on both renderers', () => {
  it('reports a stripped on binding and a widget in SSR', () => {
    const seen = [];
    renderToString(['button', { on: { click: 'act' } }, ['jaren-widget', { name: 'w' }]],
      { safe: true, onUnsafe: (i) => seen.push(`${i.kind}:${i.name}`) });
    assert.ok(seen.includes('event:on'), `expected event report, got ${seen}`);
    assert.ok(seen.includes('widget:w'));
  });

  it('reports a stripped on binding in the DOM renderer', () => {
    const seen = [];
    safeHost({ onUnsafe: (i) => seen.push(`${i.kind}:${i.name}`) })
      .render(['button', { on: { click: 'act' } }, 'x']);
    assert.ok(seen.includes('event:on'));
  });
});
