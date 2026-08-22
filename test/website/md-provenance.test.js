//@ts-check
/**
 * @file One markdown component, three provenances, three heading-id
 * policies.
 *
 * Ids are the page's namespace. The docs page addresses its own sections
 * by id, so a document that mints bare ids into it is claiming names it
 * does not own — which is fine for the repository's own documents and
 * wrong for everything else. The component takes the policy per call;
 * this asserts that the site names the right one at each of the three
 * places it renders markdown, on the ids that actually reach the DOM.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { renderToString } from '@jarenjs/view';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { viewModel } from '../../packages/website/src/app/viewmodel.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { md, rawUrl, TRUSTED, UNTRUSTED } from '../../packages/website/src/boundaries/markdown.js';
import { buildSiteData, buildSiteContent, buildSiteCards } from '../../scripts/generate-site-data.js';
import { buildInfo } from '../../scripts/generate-build-info.js';
import { createStubHost } from '../view/dom.stub.js';

const CONTENT = buildSiteContent();
const SITE_DATA = {
  packages: buildSiteData(), content: CONTENT, cards: buildSiteCards(CONTENT),
  build: buildInfo(),
};

/** A document whose heading slug would collide with a real docs section
 * id (`md` is the @jarenjs/md section) — the collision the prefix is
 * for, not a synthetic one. */
const SOURCE = '## md\n\nSee [below](#md).\n';

/** A headless site, only so a real state tree exists to project. */
function mountSite(hash = '#/') {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  const app = createSiteApp({
    node: container,
    document,
    schedule: (f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    fetchSite: (name) => (name in SITE_DATA
      ? Promise.resolve(SITE_DATA[name])
      : Promise.reject(new Error('404'))),
    applyTheme: () => {},
    listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
    navigate: (h) => routeCb(parseHash(h)),
    storage: { read: () => null, write: () => {} },
    scrollToAnchor: () => {},
    onError: (err) => { throw err; },
  });
  return app;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the site names a rendering policy per markdown provenance', function () {
  it('renders an assistant reply with ids kept out of the page namespace', function () {
    const app = mountSite();
    const state = app.getState();
    const model = viewModel({
      ...state,
      ai: { ...state.ai, messages: [{ role: 'assistant', content: SOURCE }] },
    });
    const html = renderToString(model.ui.assistant.messages[0].article);
    assert.match(html, /id="user-content-md"/,
      'a reply is text from elsewhere: its ids carry the prefix');
    assert.doesNotMatch(html, /id="md"/,
      'and never the bare id the docs page owns');
  });

  it('renders a repo README with the bare ids the document was written for', function () {
    const app = mountSite();
    const state = app.getState();
    const model = viewModel({
      ...state,
      readme: {
        ...state.readme,
        open: true,
        title: 'README.md',
        source: SOURCE,
        url: rawUrl('README.md'),
        status: 'ready',
      },
    });
    const html = renderToString(model.ui.readme.article);
    assert.match(html, /id="md"/,
      'a committed document is trusted with the ids it mints, so its own '
      + '`[see below](#the-section)` links land as they do on GitHub');
    assert.doesNotMatch(html, /id="user-content-md"/);
  });

  it('renders a package site document with bare ids too', async function () {
    // mounted ON the docs page: its sections are what the route effects
    // fetched, not what a hand-written route would have implied
    const app = mountSite('#/docs');
    await tick();
    const model = viewModel(app.getState());
    const owned = model.ui.docs.sections.filter((/** @type {any} */ s) => s.id === 'md');
    assert.strictEqual(owned.length, 1, 'the @jarenjs/md workspace still owns a section');
    const html = renderToString(owned[0].blocks);
    assert.doesNotMatch(html, /id="user-content-/,
      'a workspace committed this beside its code: it is the repository speaking');
  });

  it('keeps one component, one parse and one memo across the two policies', function () {
    const compiled = md.compile(SOURCE);
    const trusted = md.view(SOURCE, TRUSTED);
    const untrusted = md.view(SOURCE, UNTRUSTED);
    assert.notStrictEqual(trusted, untrusted, 'two policies, two vnodes');
    assert.strictEqual(md.compile(SOURCE), compiled, 'and one parse behind both');
    assert.strictEqual(md.view(SOURCE, TRUSTED), trusted, 'each still a memo hit');
    assert.strictEqual(md.view(SOURCE, UNTRUSTED), untrusted);
  });

  it('names a policy at every call site, inheriting none', function () {
    // the decision belongs to the SOURCE, so a call that renders
    // markdown without saying where it came from is the defect this
    // closes — not a style preference
    const files = ['app/viewmodel.js', 'boundaries/play.js', 'boundaries/studio.js'];
    for (const file of files) {
      const source = readFileSync(new URL(`../../packages/website/src/${file}`, import.meta.url), 'utf8');
      for (const line of source.split('\n')) {
        if (!line.includes('md.view(')) continue;
        assert.match(line, /\b(TRUSTED|UNTRUSTED)\b/,
          `${file}: \`${line.trim()}\` renders markdown without naming its provenance`);
      }
    }
  });
});
