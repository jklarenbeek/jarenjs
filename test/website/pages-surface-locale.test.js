//@ts-check
/**
 * The benchmarks, charts, collection and docs pages and the README dialog
 * speak the reader's language in everything a reader clicks or scans —
 * headings, tabs, table headers, buttons, status lines, accessible names —
 * while the prose they show stays English and says so (`lang="en"
 * dir="ltr"`). A pseudo site pack maps every id of those pages to a marker
 * that names the id: under it no English value of those ids may remain on
 * screen, and every id must turn up somewhere, so a label the pages stopped
 * reading through the catalog, or an id nothing renders, fails here.
 */

import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert';

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { compileMessageTemplate, compileMessageCatalog } from '@jarenjs/core/message';
import { collectionMessagesEn } from '@jarenjs/collection';
import { rulesMessagesEn } from '@jarenjs/rules';
import { nodeDriver } from '@jarenjs/db/node';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { viewModel } from '../../packages/website/src/app/viewmodel.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { siteMessagesEn, siteText } from '../../packages/website/src/messages.js';
import { SUITES, deriveSuite } from '../../packages/website/src/boundaries/bench.js';
import {
  createBinanceFeed, binanceNodes, binanceToggle, binancePageSync, stopBinance,
} from '../../packages/website/src/boundaries/binance.js';
import { createCollectionDemoWidget } from '../../packages/website/src/boundaries/collection.js';
import { mountRulesDemo } from '../../packages/website/src/boundaries/rules.js';
import { mountAdoptionDemo } from '../../packages/website/src/boundaries/adoption.js';
import { readmeUrl } from '../../packages/website/src/boundaries/markdown.js';
import { buildSiteData, buildSiteContent, buildSiteCards } from '../../scripts/generate-site-data.js';
import { createStubHost, StubElement, StubDocument } from '../view/dom.stub.js';
import { collectionHost } from '../collection/dom-host.js';

const SITE = new URL('../../packages/website/', import.meta.url);

/** The id families these pages own. */
const FAMILIES = ['site/bench/', 'site/charts/', 'site/collection/', 'site/lexical/', 'site/adoption/', 'site/docs/', 'site/readme/'];
const IDS = Object.keys(siteMessagesEn).filter((id) => FAMILIES.some((f) => id.startsWith(f)));

/**
 * Every id of a catalog as a marker naming it, its placeholders kept so the params still land.
 * @param {Record<string, unknown>} catalog @param {string[]} ids
 */
const pseudo = (catalog, ids) => Object.freeze(Object.fromEntries(ids.map((id) => {
  const value = String(catalog[id]);
  const params = [...compileMessageTemplate(value).parameters].map((p) => ` {${p}}`).join('');
  return [id, `⟪${id}${params}⟫`];
})));
const PSEUDO = pseudo(siteMessagesEn, IDS);
const say = siteText(PSEUDO);
/** The components' own words on these pages, marked the same way (their catalogs are theirs to check). */
const COMPONENTS = compileMessageCatalog({
  ...pseudo(collectionMessagesEn, Object.keys(collectionMessagesEn).filter((id) => typeof (/** @type {any} */ (collectionMessagesEn))[id] === 'string')),
  ...pseudo(rulesMessagesEn, Object.keys(rulesMessagesEn).filter((id) => typeof (/** @type {any} */ (rulesMessagesEn))[id] === 'string')),
});

/**
 * Ids no committed run or offline driver reaches: the failure paths of a
 * demo (a database that cannot open, a refused search, an oversized export)
 * and the steps of the interrupted-send journey `adoption.test.js` walks —
 * in English, through these same ids. The dead-id check below still finds
 * each in the source that renders it.
 */
const UNREACHED = new Set([
  'site/collection/unavailable', 'site/collection/rules/unavailable', 'site/lexical/unavailable',
  'site/adoption/unavailable', 'site/adoption/sending', 'site/adoption/recovered-no-resend',
  'site/adoption/recovered', 'site/adoption/interrupted',
]);

/** The English values a reader could meet as a whole string (templates excepted). */
const ENGLISH = new Map(IDS
  .map((id) => [/** @type {Record<string, string>} */ (siteMessagesEn)[id], id])
  .filter(([value]) => !value.includes('{')));

/** @param {string} text @param {Set<string>} seen */
const markers = (text, seen) => { for (const m of text.matchAll(/⟪([^ ⟫]+)/g)) seen.add(m[1]); };

/**
 * The strings a person meets on a node tree outside English prose: text,
 * accessible names, titles, placeholders. The site header and footer are
 * the shell (another catalog's); a table cell and a chart's SVG carry data
 * (a suite's label in a benchmark file is English by design), so they are
 * read for markers only.
 * @param {any} node @param {string[]} out @param {Set<string>} seen @param {boolean} [data]
 */
function shown(node, out, seen, data = false) {
  if (node.nodeValue != null) {
    markers(node.nodeValue, seen);
    if (!data && node.nodeValue.trim() !== '') out.push(node.nodeValue.trim());
    return;
  }
  const tag = node.tagName;
  const english = node.getAttribute?.('lang') === 'en';
  const quiet = data || english || tag === 'header' || tag === 'footer' || tag === 'td' || tag === 'svg';
  for (const name of ['aria-label', 'title', 'placeholder']) {
    const value = node.getAttribute?.(name);
    if (typeof value !== 'string') continue;
    markers(value, seen);
    if (!quiet && value.trim() !== '') out.push(value.trim());
  }
  for (const child of node.childNodes ?? []) shown(child, out, seen, quiet);
}

/** Every element marked English prose, and whether it says which way it reads. @param {any} node @param {any[]} out */
function englishBlocks(node, out = []) {
  if (node.getAttribute?.('lang') === 'en') out.push(node);
  for (const child of node.childNodes ?? []) englishBlocks(child, out);
  return out;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** @param {URL} url */
const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));

/** The build-generated site documents, collected from the workspaces as the build does (the files are not committed). */
const siteDocuments = (() => {
  /** @type {Record<string, any> | null} */
  let built = null;
  return () => {
    if (built === null) {
      const content = buildSiteContent();
      built = JSON.parse(JSON.stringify({ packages: buildSiteData(), content, cards: buildSiteCards(content) }));
    }
    return /** @type {Record<string, any>} */ (built);
  };
})();

function mountSite() {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  /** @type {{ reject: (e: Error) => void } | null} */
  let readme = null;
  const app = createSiteApp({
    node: container, document, schedule: (f) => f(), debounceMs: 0,
    fetchJson: async (name) => readJson(new URL(`public/benchmarks/${name}.json`, SITE)),
    fetchSite: async (name) => {
      const documents = siteDocuments();
      if (!Object.hasOwn(documents, name)) throw new Error('404');
      return documents[name];
    },
    fetchText: () => new Promise((_resolve, reject) => { readme = { reject }; }),
    listenHash: (cb) => { routeCb = cb; cb(parseHash('#/benchmarks')); },
    navigate: (h) => routeCb(parseHash(h)),
    storage: { read: () => null, write: () => {} },
    loadSitePack: () => Promise.resolve(PSEUDO),
    loadLocalePack: () => Promise.resolve(null),
    onError: (err) => { throw err; },
  });
  return { app, container, go: (/** @type {string} */ h) => routeCb(parseHash(h)), readmeAsked: () => readme !== null, failReadme: () => readme?.reject(new Error('offline')) };
}

/** Settle until a condition holds (fetches land through the contract client). @param {() => boolean} done */
async function until(done) {
  for (let i = 0; i < 400 && !done(); i++) await settle();
  assert.ok(done(), 'the page settled');
}

/** @param {any[]} sockets */
function stubSocket(sockets) {
  return class {
    /** @param {string} url */
    constructor(url) { this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; sockets.push(this); }
    close() { this.closed = true; }
  };
}

const MINITICKER = JSON.stringify({ stream: 'btcusdt@miniTicker', data: { e: '24hrMiniTicker', E: 1000, s: 'BTCUSDT', c: '64000.0' } });
const REST_KLINES = JSON.stringify([
  [1721555880000, '64000.0', '64100.0', '63950.0', '64050.0', '10.1', 1721555939999, '1', 100, '1', '1', '0'],
  [1721555940000, '64050.0', '64150.2', '64020.1', '64123.4', '12.5', 1721555999999, '1', 120, '1', '1', '0'],
]);

describe('website — the benchmarks, charts, collection and docs pages speak the reader\'s language', () => {
  /** every id some surface below rendered */
  const seen = new Set();
  /** @type {string[]} */
  const left = [];
  /** @type {any[]} */
  const prose = [];

  afterEach(() => { stopBinance(); delete (/** @type {any} */ (globalThis)).WebSocket; });

  it('leaves no English label on the benchmarks, charts and docs pages or the README dialog', async () => {
    const { app, container, go, readmeAsked, failReadme } = mountSite();
    app.dispatch('site/lang', 'de');
    await until(() => app.getState().siteMessages?.code === 'de');
    /** @param {string} page */
    const read = (page) => {
      /** @type {string[]} */
      const words = [];
      shown(container, words, seen);
      for (const text of words) if (ENGLISH.has(text)) left.push(`${page}: "${text}" (${ENGLISH.get(text)})`);
      prose.push(...englishBlocks(container));
      // a lead, article or refusal that lost its mark is English left unmarked
      const unmarked = (/** @type {any} */ node) => [
        ...(['page-lead', 'docs-article', 'error-message'].includes(node.getAttribute?.('class') ?? '') && node.getAttribute('lang') !== 'en' ? [node] : []),
        ...(node.childNodes ?? []).flatMap(unmarked)];
      assert.deepStrictEqual(unmarked(container).map((/** @type {any} */ n) => n.getAttribute('class')), [], `${page} has an unmarked English block`);
      return words.length;
    };
    let read_ = 0;
    for (const { key } of SUITES) {
      go(`#/benchmarks?suite=${key}`);
      const need = key === 'overview' ? 'meta' : key;
      await until(() => app.getState().bench[need] !== undefined);
      read_ += read(`#/benchmarks?suite=${key}`);
    }
    go('#/benchmarks?suite=nope');
    read('#/benchmarks?suite=nope');
    go('#/charts');
    read_ += read('#/charts');
    go('#/docs');
    read('#/docs (loading)');
    await until(() => app.getState().site.data.packages !== undefined && app.getState().site.data.content !== undefined);
    read_ += read('#/docs');
    app.dispatch('readme/open', { title: '@jarenjs/core', url: readmeUrl('packages/core') });
    read('README (loading)');
    await until(readmeAsked);
    failReadme();
    await until(() => app.getState().readme.status === 'error');
    read('README (failed)');
    assert.deepStrictEqual([...new Set(left)], [], 'English left on screen');
    assert.ok(read_ > 500, `read ${read_} strings`);
    const lead = prose.find((n) => n.getAttribute('class') === 'page-lead');
    assert.ok(lead !== undefined, 'the page lead is marked English');
    assert.ok(prose.some((n) => n.tagName === 'article'), 'the docs article is marked English');
    // the collection page's heading is the shell's to place, in these words
    const model = viewModel({ ...app.getState(), route: { page: 'collection', params: {} } });
    markers(model.ui.collection.title, seen);
    // the docs rail when the census could not load
    const failed = viewModel({ ...app.getState(), route: { page: 'docs', params: {} },
      site: { ...app.getState().site, data: { ...app.getState().site.data, packages: undefined }, status: { ...app.getState().site.status, packages: 'error' } } });
    markers(JSON.stringify(failed.ui.docs.note), seen);
    assert.match(model.ui.collection.key, /^array:de\+site$/, 'the widget remounts once the words land');
  });

  it('leaves no English label in the collection demos', async () => {
    // every status line a demo writes, the transient ones included
    const setter = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(StubElement.prototype, 'textContent'));
    Object.defineProperty(StubElement.prototype, 'textContent', { ...setter,
      set(value) { markers(String(value), seen); setter.set?.call(this, value); } });
    const createText = StubDocument.prototype.createTextNode;
    StubDocument.prototype.createTextNode = function (/** @type {string} */ text) { markers(String(text), seen); return createText.call(this, text); };
    const directory = mkdtempSync(join(tmpdir(), 'jaren-pages-locale-'));
    try {
    /** @param {any} host @param {string} name */
    const check = (host, name) => {
      /** @type {string[]} */
      const words = [];
      shown(host, words, seen);
      for (const text of words) if (ENGLISH.has(text)) left.push(`${name}: "${text}"`);
      prose.push(...englishBlocks(host));
    };
    const widget = createCollectionDemoWidget({ siteWords: () => say, messages: () => COMPONENTS });
    for (const mode of ['array', 'lexical']) {
      const env = collectionHost();
      const handle = widget.mount(env.host, { mode });
      check(env.host, `collection ${mode} (loading)`);
      await handle.ready;
      for (const fn of [...env.observers.values()]) fn();
      env.flush();
      if (mode === 'array') {
        env.host.querySelectorAll('button')[0].click();
        await new Promise((resolve) => setImmediate(resolve));
      }
      check(env.host, `collection ${mode}`);
      await handle.dispose();
    }
    // an export larger than the browser's download budget
    {
      const env = collectionHost();
      const handle = widget.mount(env.host, { mode: 'array' });
      await handle.ready; await new Promise((resolve) => setImmediate(resolve));
      const viewport = env.host.querySelector('.jc-viewport'); viewport.fire('focusin', { target: viewport });
      viewport.fire('keydown', { key: 'End', ctrlKey: true, shiftKey: true, target: viewport, preventDefault() {} });
      await new Promise((resolve) => setImmediate(resolve));
      env.host.querySelectorAll('button')[0].click(); await new Promise((resolve) => setImmediate(resolve));
      await handle.dispose();
    }
    {
      const env = collectionHost();
      const handle = mountRulesDemo(env.host, { driver: nodeDriver(), say, messages: COMPONENTS });
      check(env.host, 'collection rules (opening)');
      await handle.ready;
      check(env.host, 'collection rules');
      await handle.dispose();
    }
    {
      const values = new Map();
      // wide enough that every column of the journey's catalog mounts
      const env = collectionHost({ width: 960 });
      const handle = mountAdoptionDemo(env.host, { driver: nodeDriver(), path: join(directory, 'catalog.sqlite'), say, messages: COMPONENTS,
        storage: { getItem: (/** @type {string} */ key) => values.get(key), setItem: (/** @type {string} */ key, /** @type {string} */ value) => values.set(key, value) } });
      check(env.host, 'adoption (opening)');
      await handle.ready;
      for (const fn of [...env.observers.values()]) fn();
      env.flush();
      check(env.host, 'adoption');
      /** @param {string} name */
      const click = async (name) => {
        const target = env.host.querySelectorAll('[data-journey-action]').find((/** @type {any} */ node) => node.getAttribute('data-journey-action') === name);
        for (const fn of env.host.listeners.get('click')) await fn({ target });
      };
      for (const name of ['search', 'save', 'ingest', 'send', 'recover', 'restart']) await click(name);
      env.host.querySelector('[data-rule-draft]').value = '{ not json';
      await click('save');
      check(env.host, 'adoption (after the journey)');
      await handle.dispose();
    }
    }
    finally {
      Object.defineProperty(StubElement.prototype, 'textContent', setter);
      StubDocument.prototype.createTextNode = createText;
      rmSync(directory, { recursive: true, force: true });
    }
    assert.deepStrictEqual([...new Set(left)], [], 'English left on screen');
  });

  it('paints the live feed in the words it was started in', () => {
    /** @type {any[]} */
    const sockets = [];
    (/** @type {any} */ (globalThis)).WebSocket = stubSocket(sockets);
    /** @type {any[]} */
    const sunk = [];
    const dispatch = (/** @type {string} */ _action, /** @type {any} */ nodes) => sunk.push(nodes);
    binanceToggle(dispatch, () => say);
    sockets[0].onopen();
    sockets[0].onclose();
    sockets[1].onclose();
    binanceToggle(dispatch, () => say);
    binanceToggle(dispatch, () => say);
    binanceToggle(dispatch, () => say);
    binancePageSync(false);
    delete (/** @type {any} */ (globalThis)).WebSocket;
    binanceToggle(dispatch, () => say);
    const feed = createBinanceFeed(say);
    feed.seedKlines(REST_KLINES);
    feed.handleMessage(MINITICKER);
    sunk.push(binanceNodes(feed, 'live', undefined, say));
    const text = JSON.stringify(sunk);
    markers(text, seen);
    for (const value of ENGLISH.keys()) {
      if (value.length > 3) assert.ok(!text.includes(JSON.stringify(value)), `the feed still says "${value}"`);
    }
  });

  it('derives every suite state in the reader\'s words', () => {
    // the states a committed run never shows: a file that failed to load, an unknown key
    const nodes = [
      ...deriveSuite({ bench: {}, benchStatus: { meta: 'error' }, benchUi: { search: '', limit: 10 } }, 'overview', say),
      ...deriveSuite({ bench: { nope: {} }, benchStatus: {}, benchUi: { search: '', limit: 10 } }, 'nope', say),
      ...deriveSuite({ bench: {}, benchStatus: {}, benchUi: { search: '', limit: 10 } }, 'validate', say),
    ];
    markers(JSON.stringify(nodes), seen);
    // the first-calls tables, a qt3 card set, a quick run, a check that
    // disagrees and a machine that does not survive, from runs that carry them
    const base = readJson(new URL('public/benchmarks/meta.json', SITE));
    const meta = { ...base, qt3: { total: 1, pass: 1, regressions: 0 }, lastRun: { ...base.lastRun, quick: true } };
    const geo = readJson(new URL('public/benchmarks/geo.json', SITE));
    const flow = readJson(new URL('public/benchmarks/flow.json', SITE));
    markers(JSON.stringify([
      ...deriveSuite({ bench: { geo: { ...geo, checks: [{ name: 'n', rival: 'r', agrees: false, detail: 'd', note: '' }] } }, benchStatus: {}, benchUi: { search: '', limit: 10 } }, 'geo', say),
      ...deriveSuite({ bench: { flow: { ...flow, wedge: { guardsSurviveJson: { jaren: false, xstate: false } } } }, benchStatus: {}, benchUi: { search: '', limit: 10 } }, 'flow', say),
    ]), seen);
    const view = { ...readJson(new URL('public/benchmarks/view.json', SITE)),
      firstCalls: { operation: 'x', tables: [{ title: 't', columns: ['a'], rows: [{ name: 'r', results: [1] }] }] } };
    const headlines = meta.headlines.map((/** @type {any} */ h, /** @type {number} */ i) => (i === 0 ? { ...h, generated: undefined } : h));
    markers(JSON.stringify([
      ...deriveSuite({ bench: { meta: { ...meta, headlines } }, benchStatus: {}, benchUi: { search: '', limit: 10 } }, 'overview', say),
      ...deriveSuite({ bench: { meta: { ...meta, headlines: headlines.map((/** @type {any} */ h, /** @type {number} */ i) => (i < 2 ? { ...h, generated: undefined } : h)) } }, benchStatus: {}, benchUi: { search: '', limit: 10 } }, 'overview', say),
      ...deriveSuite({ bench: { view }, benchStatus: {}, benchUi: { search: '', limit: 10 } }, 'view', say),
    ]), seen);
  });

  it('re-renders a page read in English once the reader switches', async () => {
    const { app, container, go } = mountSite();
    /** @type {Array<[string, string]>} */
    const pages = [['#/benchmarks?suite=overview', 'meta'], ['#/benchmarks?suite=toml', 'toml'],
      ['#/benchmarks?suite=jsonpointer', 'jsonpointer'], ['#/benchmarks?suite=validate', 'validate']];
    for (const [hash, need] of pages) {
      go(hash);
      await until(() => app.getState().bench[need] !== undefined);
    }
    go('#/charts');
    go('#/docs');
    await until(() => app.getState().site.data.content !== undefined);
    /** @type {string[]} */
    const english = [];
    shown(container, english, new Set());
    assert.ok(english.includes('Docs'), 'the docs page first renders in English');
    app.dispatch('site/lang', 'de');
    await until(() => app.getState().siteMessages?.code === 'de');
    for (const hash of [...pages.map(([h]) => h), '#/charts', '#/docs']) {
      go(hash);
      /** @type {string[]} */
      const words = [];
      const marked = new Set();
      shown(container, words, marked);
      assert.deepStrictEqual(words.filter((text) => ENGLISH.has(text)), [], `${hash} kept English after the switch`);
      assert.ok(marked.size >= 3, `${hash} renders the new words (${marked.size} ids)`);
      if (hash.includes('suite=toml')) {
        // a chart's title, inside its SVG, moves with the language too
        assert.ok(marked.has('site/bench/toml/compliance-chart'), 'the chart titles follow the switch');
      }
    }
  });

  it('marks every prose block it leaves English with the way it reads', () => {
    assert.ok(prose.length > 10, `${prose.length} English blocks`);
    // the page leads, the docs article and a refusal's own words are marked, on every page visited
    const marked = new Set(prose.map((n) => `${n.tagName}.${n.getAttribute('class') ?? ''}`));
    for (const block of ['p.page-lead', 'article.docs-article', 'p.error-message', 'p.doc-p']) {
      assert.ok(marked.has(block), `${block} is marked English`);
    }
    // a node the renderer later reused for a translated line no longer says English: judge the ones that still do
    const unmarked = prose.filter((n) => n.getAttribute('lang') === 'en' && n.getAttribute('dir') !== 'ltr').map((n) => `${n.tagName}.${n.getAttribute('class') ?? ''}`);
    assert.deepStrictEqual([...new Set(unmarked)], []);
  });

  it('renders every one of its ids somewhere', () => {
    assert.deepStrictEqual(IDS.filter((id) => !seen.has(id) && !UNREACHED.has(id)), []);
    assert.deepStrictEqual([...UNREACHED].filter((id) => seen.has(id)), [], 'an id listed as unreached is reached: drop it from the list');
  });
});

describe('website — the pages\' catalog has no dead id', () => {
  it('names every id it declares in the source that renders it', () => {
    const files = ['boundaries/bench.js', 'boundaries/binance.js', 'boundaries/chartspage.js', 'boundaries/collection.js',
      'boundaries/lexical.js', 'boundaries/rules.js', 'boundaries/adoption.js', 'app/viewmodel.js']
      .map((f) => readFileSync(new URL(`src/${f}`, SITE), 'utf8')).join('\n');
    assert.deepStrictEqual(IDS.filter((id) => !files.includes(`'${id}'`)), []);
  });
});
