//@ts-check
/**
 * Under a right-to-left language, code and the English the site keeps by
 * design are left-to-right islands: every element marked `lang="en"` carries
 * `dir="ltr"`, every editor and code block reads left to right, a table
 * column of paths is code, and the stylesheet makes all of them compute
 * `direction: ltr` (the browser check lives in e2e/rtl-islands.spec.js).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { catalogFor } from '../../packages/website/src/boundaries/validator.js';
import { playComponent } from '../../packages/website/src/boundaries/play.js';
import { createStubHost } from '../view/dom.stub.js';

function mountSite() {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  const app = createSiteApp({
    node: container, document, schedule: (f) => f(), debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (cb) => { routeCb = cb; cb(parseHash('#/play')); },
    navigate: (h) => routeCb(parseHash(h)),
    storage: { read: () => null, write: () => {} },
    onError: (err) => { throw err; },
  });
  return { app, container };
}

/** @param {any} node @param {(n: any) => boolean} pred @returns {any[]} */
const findAll = (node, pred) => [...(pred(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((/** @type {any} */ c) => findAll(c, pred))];
/** @param {any} n */
const describeNode = (n) => `<${n.tagName} class="${n.getAttribute?.('class') ?? ''}">`;
/** A code surface: an editor, a code block, an input that holds JSON or a path. @param {any} n */
const isCode = (n) => n.tagName === 'textarea' || n.tagName === 'pre'
  || (n.tagName === 'input' && (n.getAttribute?.('class') ?? '').split(' ').includes('editor'));

describe('website — LTR islands inside a right-to-left page', () => {
  it('under Arabic, every English block and every code surface reads left to right, one example per engine', async () => {
    const { app, container } = mountSite();
    app.dispatch('site/lang', 'ar');
    for (let i = 0; i < 200 && catalogFor('ar') === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    /** @type {string[]} */
    const wrong = [];
    let english = 0;
    let code = 0;
    for (const id of [...new Map(playComponent.examples.map((e) => [e.engine, e.id])).values()]) {
      app.dispatch('play/example', id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const n of findAll(container, (x) => x.getAttribute?.('lang') === 'en')) {
        english++;
        if (n.getAttribute('dir') !== 'ltr') wrong.push(`${id}: ${describeNode(n)} lang="en" without dir="ltr"`);
      }
      // an example's name is example content, English by design
      for (const n of findAll(container, (x) => (x.getAttribute?.('class') ?? '').split(' ').includes('jplay-ex'))) {
        if (n.getAttribute('lang') !== 'en' || n.getAttribute('dir') !== 'ltr') wrong.push(`${id}: an example name is no English island`);
      }
      for (const n of findAll(container, isCode)) {
        code++;
        if (n.getAttribute('dir') !== 'ltr') wrong.push(`${id}: ${describeNode(n)} code without dir="ltr"`);
      }
    }
    assert.deepStrictEqual([...new Set(wrong)], []);
    assert.ok(english > 50 && code > 20, `checked ${english} English blocks and ${code} code surfaces`);
  });

  it("the IDE's running app takes its own text's direction under a right-to-left page", async () => {
    const { document, container } = createStubHost();
    /** @type {any} */
    let routeCb = null;
    const app = createSiteApp({
      node: container, document, schedule: (f) => f(), debounceMs: 0,
      fetchJson: () => Promise.reject(new Error('404')),
      listenHash: (cb) => { routeCb = cb; cb(parseHash('#/project')); },
      navigate: (h) => routeCb(parseHash(h)),
      storage: { read: () => null, write: () => {} },
      onError: () => {},
    });
    app.dispatch('site/lang', 'ar');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stage = findAll(container, (n) => (n.getAttribute?.('class') ?? '').split(' ').includes('js-stage-mount'));
    assert.strictEqual(stage.length, 1);
    assert.strictEqual(stage[0].getAttribute('dir'), 'auto');
  });

  it("a page's paragraphs (callouts, notes) take their own text's direction", async () => {
    const { document, container } = createStubHost();
    /** @type {any} */
    let routeCb = null;
    createSiteApp({
      node: container, document, schedule: (f) => f(), debounceMs: 0,
      fetchJson: () => Promise.reject(new Error('404')),
      listenHash: (cb) => { routeCb = cb; cb(parseHash('#/benchmarks')); },
      navigate: (h) => routeCb(parseHash(h)),
      storage: { read: () => null, write: () => {} },
      onError: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const paragraphs = findAll(container, (n) => n.tagName === 'p' && n.parentNode?.getAttribute?.('class') === 'callout');
    assert.ok(paragraphs.length > 0, 'a callout is on screen');
    assert.ok(paragraphs.every((n) => n.getAttribute('dir') === 'auto' || (n.getAttribute('dir') === 'ltr' && n.getAttribute('lang') === 'en')));
  });

  it('a paragraph the site writes is marked English unless its catalog said it', async () => {
    /** @param {string} hash @param {any} fetchJson */
    const mount = (hash, fetchJson) => {
      const { document, container } = createStubHost();
      /** @type {any} */
      let routeCb = null;
      createSiteApp({
        node: container, document, schedule: (f) => f(), debounceMs: 0, fetchJson,
        listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
        navigate: (h) => routeCb(parseHash(h)),
        storage: { read: () => null, write: () => {} },
        onError: () => {},
      });
      return container;
    };
    const calloutText = (/** @type {any} */ c) => findAll(c, (n) => n.tagName === 'p' && n.parentNode?.getAttribute?.('class') === 'callout');
    // a file that failed: its explanation is English prose, written by the site
    const failed = mount('#/benchmarks', () => Promise.reject(new Error('404')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const english = calloutText(failed);
    assert.ok(english.length > 0);
    assert.ok(english.every((n) => n.getAttribute('lang') === 'en' && n.getAttribute('dir') === 'ltr'));
    // a file still loading: its line is the catalog's, in the reader's language
    const loading = mount('#/benchmarks', () => new Promise(() => {}));
    const said = calloutText(loading);
    assert.ok(said.length > 0);
    assert.ok(said.every((n) => n.getAttribute('lang') === null && n.getAttribute('dir') === 'auto'));
  });

  it('the stylesheets compute direction ltr for code and English blocks, whatever the page', () => {
    const site = readFileSync(new URL('../../packages/website/src/styles.css', import.meta.url), 'utf8');
    assert.match(site, /code, pre, kbd, samp, textarea, input\.editor, \[dir="ltr"\] \{ direction: ltr; unicode-bidi: isolate; \}/);
    assert.match(site, /\[lang="en"\] \{ direction: ltr; unicode-bidi: isolate; \}/);
    assert.match(site, /^svg \{ direction: ltr; \}/m, 'a chart or a diagram does not mirror');
    const play = readFileSync(new URL('../../components/play/styles/play.css', import.meta.url), 'utf8');
    assert.match(play, /\.jplay textarea\.editor, \.jplay input\.editor, \.jplay pre, \.jplay code, \.jplay \[lang="en"\] \{ direction: ltr; unicode-bidi: isolate; \}/);
  });
});
