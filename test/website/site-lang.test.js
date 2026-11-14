//@ts-check
/**
 * The site language: one switch in the header (every language named in its
 * own), remembered, deep-linkable with `?lang=`, put on the document, and
 * followed by Play; the site's own words load per language on demand, and
 * English holds until (or unless) they arrive.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { compileMessageTemplate } from '@jarenjs/core/message';
import { compileMessageCatalog } from '@jarenjs/validate';
import { LOCALE_NAMES } from '@jarenjs/locales/names';
import * as packs from '@jarenjs/locales';
import { playText } from '@jarenjs/play';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { siteMessagesEn, siteText, sitePackOf } from '../../packages/website/src/messages.js';
import { SITE_LANGUAGES, isSiteLanguage, languageDir, loadSitePack, loadLocalePack, warmSitePacks } from '../../packages/website/src/boundaries/lang.js';
import { LOCALES, catalogFor } from '../../packages/website/src/boundaries/validator.js';
import { readLang, writeLang, LANG_KEY } from '../../packages/website/src/lib/lang.js';
import { createStubHost, fire } from '../view/dom.stub.js';

const SRC = new URL('../../packages/website/src/', import.meta.url).pathname;

/** @param {{ hash?: string, initialLang?: string | null, loadSitePack?: any, loadLocalePack?: any, share?: any, replaceHash?: any }} [options] */
function mountSite({ hash = '#/play', initialLang = null, loadSitePack: loader, loadLocalePack: localeLoader, share, replaceHash } = {}) {
  const { document, container } = createStubHost();
  /** @type {Array<[string, string]>} */
  const applied = [];
  /** @type {any} */
  let routeCb = null;
  const app = createSiteApp({
    node: container, document, schedule: (f) => f(), debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
    navigate: (h) => routeCb(parseHash(h)),
    storage: { read: () => null, write: () => {} },
    initialLang, applyLang: (code, dir) => applied.push([code, dir]),
    ...(loader === undefined ? {} : { loadSitePack: loader }),
    ...(localeLoader === undefined ? {} : { loadLocalePack: localeLoader }),
    replaceHash,
    share,
    onError: (err) => { throw err; },
  });
  return { app, container, applied, go: (/** @type {string} */ h) => routeCb(parseHash(h)) };
}

/** @param {any} node @param {(n: any) => boolean} pred @returns {any[]} */
const findAll = (node, pred) => [...(pred(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((/** @type {any} */ c) => findAll(c, pred))];
/** @param {any} node @returns {string} */
const textOf = (node) => (node.nodeValue != null ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
/** The header's language switch. @param {any} c */
const languageSwitch = (c) => findAll(c, (n) => n.tagName === 'select' && (n.getAttribute?.('class') ?? '') === 'lang-switch')[0];
/** Settle the pack import the switch started. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Wait until a language's package words have landed on this page. @param {any} app @param {string} code */
async function packLanded(app, code) {
  for (let i = 0; i < 200 && app.getState().packs?.[code] !== true && catalogFor(code) === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}
/** The placeholders of a template, sorted. @param {string} template */
const placeholders = (template) => [...compileMessageTemplate(template).parameters].sort();

describe('website — the site language packs', () => {
  it('offers English and every locale pack, each named in its own language, the ones the validator compiles', () => {
    assert.deepStrictEqual(SITE_LANGUAGES.map((l) => l.code), LOCALES);
    assert.deepStrictEqual(SITE_LANGUAGES.map((l) => l.name), ['English', ...LOCALE_NAMES.map((l) => l.name)]);
    assert.strictEqual(languageDir('ar'), 'rtl');
    assert.strictEqual(languageDir('de'), 'ltr');
    assert.strictEqual(languageDir('xx'), 'ltr');
    assert.strictEqual(isSiteLanguage('zh-tw'), true);
    assert.strictEqual(isSiteLanguage('constructor'), false);
  });

  for (const { code } of LOCALE_NAMES) {
    it(`${code}: its site pack has every site message, the English placeholders, nothing else`, async () => {
      const pack = await loadSitePack(code);
      assert.ok(pack !== null);
      assert.deepStrictEqual(Object.keys(pack).sort(), Object.keys(siteMessagesEn).sort());
      for (const [key, english] of Object.entries(siteMessagesEn)) {
        assert.deepStrictEqual(placeholders(pack[key]), placeholders(english), `${code} ${key}`);
        const params = Object.fromEntries(placeholders(english).map((name) => [name, `<${name}>`]));
        assert.ok(siteText(pack)(/** @type {any} */ (key), params).length > 0);
      }
      // the too-large refusal points at the Download button by the name Play gives it
      const download = playText(compileMessageCatalog(/** @type {any} */ (packs)[LOCALE_NAMES.find((l) => l.code === code)?.pack ?? '']))('play/action/download');
      assert.ok(pack['site/play/too-large'].includes(download), `${code}: ${pack['site/play/too-large']} names ${download}`);
    });
  }

  it('English is built in: no pack to load; every package loader returns its pack', async () => {
    assert.strictEqual(await loadSitePack('en'), null);
    assert.strictEqual(await loadLocalePack('en'), null);
    for (const { code, pack } of LOCALE_NAMES) assert.strictEqual(await loadLocalePack(code), /** @type {any} */ (packs)[pack], `${code} loads its pack`);
  });

  it('the offline warm-up fetches only the stored language: nothing for English, both packs of one other', async () => {
    assert.deepStrictEqual(await warmSitePacks(null), []);
    assert.deepStrictEqual(await warmSitePacks('en'), []);
    assert.deepStrictEqual(await warmSitePacks('xx'), []);
    assert.deepStrictEqual(await warmSitePacks('de'), ['site:de', 'locale:de']);
    assert.deepStrictEqual(await warmSitePacks('zh-tw'), ['site:zh-tw', 'locale:zh-tw']);
    const main = readFileSync(join(SRC, 'main.js'), 'utf8');
    assert.match(main, /warmSitePacks\(lang\)/, 'the boot warms the stored language only');
  });

  it('each pack is reached by one literal dynamic import, and nothing else imports a pack', () => {
    const lang = readFileSync(join(SRC, 'boundaries/lang.js'), 'utf8');
    for (const { code } of LOCALE_NAMES) {
      assert.ok(lang.includes(`() => import('../lang/${code}.js')`), `${code} has its site loader`);
      assert.ok(lang.includes(`() => import('@jarenjs/locales/${code}')`), `${code} has its package loader`);
    }
    assert.deepStrictEqual(readdirSync(join(SRC, 'lang')).sort(), LOCALE_NAMES.map(({ code }) => `${code}.js`).sort());
    /** @param {string} dir @returns {string[]} */
    const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []);
    for (const file of files(SRC)) {
      if (file.endsWith('boundaries/lang.js') || file.includes('/lang/')) continue;
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /['"](\.\.?\/)+(src\/)?lang\/[a-z-]+\.js['"]/, `${file} imports a site pack`);
      assert.doesNotMatch(text, /from '@jarenjs\/locales(\/(?!names')[a-z-]+)?'/, `${file} imports a locale pack statically`);
    }
  });

  it('a site pack still loading, or none, speaks English', () => {
    assert.strictEqual(siteText()('site/lang/label'), 'Language');
    assert.strictEqual(siteText({ 'site/lang/label': 'Sprache' })('site/play/link-copied'), 'link copied', 'a key the pack lacks');
    assert.strictEqual(sitePackOf({ lang: 'de', siteMessages: { code: 'fr', messages: {} } }), null, 'a pack of another language');
    assert.strictEqual(sitePackOf({}), null);
  });

  it('the stored choice survives storage a browser refuses', () => {
    /** @type {Record<string, string>} */
    const store = {};
    const storage = { getItem: (/** @type {string} */ k) => store[k] ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { store[k] = v; } };
    assert.strictEqual(readLang(() => storage), null);
    writeLang(() => storage, 'de');
    assert.strictEqual(store[LANG_KEY], 'de');
    assert.strictEqual(readLang(() => storage), 'de');
    const refused = () => { throw new Error('blocked'); };
    assert.strictEqual(readLang(refused), null);
    assert.doesNotThrow(() => writeLang(refused, 'fr'));
  });
});

describe('website — one language switch for the whole site', () => {
  it('the header lists the 12 languages, each in its own language, the current one selected', () => {
    const { container } = mountSite();
    const options = languageSwitch(container).childNodes.filter((/** @type {any} */ n) => n.tagName === 'option');
    assert.deepStrictEqual(options.map((/** @type {any} */ o) => o.getAttribute('value')), LOCALES);
    assert.deepStrictEqual(options.map((/** @type {any} */ o) => o.getAttribute('lang')), LOCALES, 'each name is marked as its language');
    assert.deepStrictEqual(options.filter((/** @type {any} */ o) => o.getAttribute('selected') != null).map((/** @type {any} */ o) => o.getAttribute('value')), ['en']);
    assert.strictEqual(languageSwitch(container).getAttribute('aria-label'), 'Language');
  });

  it("picking a language puts it on the document, loads the site's words and Play follows, without a reload", async () => {
    const { app, container, applied } = mountSite();
    app.dispatch('play/example', 'validate-invalid');
    fire(languageSwitch(container), 'change', { target: { value: 'de' } });
    assert.strictEqual(app.getState().lang, 'de');
    assert.deepStrictEqual(applied, [['de', 'ltr']]);
    assert.strictEqual(languageSwitch(container).getAttribute('aria-label'), 'Language', 'English until the pack arrives');
    await settle();
    assert.strictEqual(app.getState().siteMessages?.code, 'de');
    assert.strictEqual(languageSwitch(container).getAttribute('aria-label'), 'Sprache');
    const de = playText(compileMessageCatalog(packs.de));
    const buttons = findAll(container, (n) => n.tagName === 'button').map(textOf);
    assert.ok(buttons.includes(de('play/action/save')), `Play's own words: ${buttons.join(' | ')}`);
    const cells = findAll(container, (n) => n.tagName === 'td').map(textOf);
    assert.ok(cells.includes('muss >= 13 sein'), 'the result re-ran in German');
  });

  it('a result already on screen re-runs in the new language, for any engine', async () => {
    const { app, container } = mountSite();
    app.dispatch('play/example', 'path-authors');
    const labels = () => app.getState().play.result.panels.map((/** @type {any} */ p) => p.label);
    assert.ok(labels().includes('How it matched'), labels().join(' | '));
    fire(languageSwitch(container), 'change', { target: { value: 'ja' } });
    await packLanded(app, 'ja');
    const ja = playText(compileMessageCatalog(packs.ja));
    assert.ok(labels().includes(ja('play/panel/how-matched')), labels().join(' | '));
    assert.ok(!labels().includes('How it matched'));
  });

  it('a ?lang= link applies once: it leaves the address bar, so a reload keeps the later choice', () => {
    /** @type {string[]} */
    const replaced = [];
    const { app, container, go } = mountSite({ hash: '#/docs?lang=ja&s=readme', replaceHash: (/** @type {string} */ h) => replaced.push(h) });
    assert.strictEqual(app.getState().lang, 'ja');
    assert.deepStrictEqual(replaced, ['#/docs?s=readme']);
    fire(languageSwitch(container), 'change', { target: { value: 'fr' } });
    go('#/docs?s=readme'); // the reload of the address the bar now holds
    assert.strictEqual(app.getState().lang, 'fr');
    assert.deepStrictEqual(replaced, ['#/docs?s=readme'], 'nothing else to remove');
    go('#/?lang=xx');
    assert.deepStrictEqual(replaced, ['#/docs?s=readme', '#/'], 'an unknown one leaves too, applying nothing');
    assert.strictEqual(app.getState().lang, 'fr');
  });

  it('until a language\'s pack lands its words render English, never ids; then they switch', async () => {
    // Turkish: no other test of this file loads its pack
    assert.strictEqual(catalogFor('tr'), undefined);
    /** @type {(pack: any) => void} */
    let land = () => {};
    const arrives = new Promise((resolve) => { land = resolve; });
    const { app, container } = mountSite({ loadLocalePack: () => arrives });
    app.dispatch('play/example', 'validate-invalid');
    fire(languageSwitch(container), 'change', { target: { value: 'tr' } });
    await settle();
    const words = () => [...findAll(container, (n) => n.nodeValue != null).map(textOf), ...findAll(container, (n) => n.getAttribute?.('aria-label') != null).map((n) => n.getAttribute('aria-label'))];
    assert.ok(words().includes('Save'), 'English Play chrome while loading');
    assert.ok(findAll(container, (n) => n.tagName === 'td').map(textOf).includes('must be >= 13'), 'English errors while loading');
    assert.ok(!words().some((text) => /^(play|site|form|query)\//.test(text)), 'no id on screen');
    land(packs.tr);
    await packLanded(app, 'tr');
    const tr = compileMessageCatalog(packs.tr);
    assert.ok(findAll(container, (n) => n.tagName === 'td').map(textOf).includes(tr.minimum({ comparison: '>=', limit: 13 })), 'then Turkish');
    assert.ok(words().includes(playText(tr)('play/action/save')));
  });

  it('a pack that never lands leaves its words English; asked again only when the language is needed anew', async () => {
    /** @type {string[]} */
    const asked = [];
    const { app, container } = mountSite({ loadLocalePack: (/** @type {string} */ code) => { asked.push(code); return Promise.reject(new Error('offline')); } });
    app.dispatch('play/example', 'validate-invalid');
    fire(languageSwitch(container), 'change', { target: { value: 'pt' } });
    await settle();
    assert.ok(findAll(container, (n) => n.tagName === 'td').map(textOf).includes('must be >= 13'));
    app.dispatch('play/example', 'validate-user');
    await settle();
    assert.deepStrictEqual(asked, ['pt'], 'no retry on every change while offline');
    fire(languageSwitch(container), 'change', { target: { value: 'es' } });
    fire(languageSwitch(container), 'change', { target: { value: 'pt' } });
    await settle();
    assert.deepStrictEqual(asked, ['pt', 'es', 'pt'], 'asked again when needed anew');
  });

  it('an example made to show a language never writes the site language or the stored choice', async () => {
    const { app, applied } = mountSite();
    app.dispatch('play/example', 'validate-locale-ko');
    await packLanded(app, 'ko');
    assert.strictEqual(app.getState().lang, null);
    assert.deepStrictEqual(applied, [], 'the document and the stored choice are untouched');
    assert.strictEqual(app.getState().packs.ko, true, 'its pack loaded for its own run');
  });

  it("the IDE's share status speaks the site's words", async () => {
    /** @type {string[]} */
    const shared = [];
    const { app, container } = mountSite({ hash: '#/project', share: (/** @type {string} */ h) => { shared.push(h); return h; } });
    fire(languageSwitch(container), 'change', { target: { value: 'nl' } });
    await settle();
    app.dispatch('ide/share');
    const nl = await loadSitePack('nl');
    assert.strictEqual(shared.length, 1);
    assert.strictEqual(app.getState().ide.shared, nl?.['site/play/link-copied']);
    fire(languageSwitch(container), 'change', { target: { value: 'fr' } });
    assert.strictEqual(app.getState().ide.shared, null, 'a switch clears it');
  });

  it('a language switch remounts the collection demo in the new words', async () => {
    const { viewModel } = await import('../../packages/website/src/app/viewmodel.js');
    const { createInitialState } = await import('../../packages/website/src/app/state.js');
    const at = (/** @type {string | null} */ lang) => viewModel({ ...createInitialState(), lang,
      route: { page: 'collection', params: { mode: 'rules' } } }).ui.collection.key;
    // the widget is keyed by its mode and the language: a switch is a new key
    assert.strictEqual(at(null), 'rules:en');
    assert.strictEqual(at('de'), 'rules:de');
  });

  it("a diagram that does not parse says so in the reader's language", async () => {
    const { mermaidText } = await import('@jarenjs/mermaid');
    const { app, container } = mountSite();
    app.dispatch('play/example', 'mermaid-er');
    fire(languageSwitch(container), 'change', { target: { value: 'de' } });
    await packLanded(app, 'de');
    app.dispatch('play/source', { key: 'source' }, { target: { value: 'flowchart TD\n  A --> ' } });
    const words = findAll(container, (n) => n.nodeValue != null).map(textOf);
    const de = mermaidText(compileMessageCatalog(packs.de));
    assert.ok(words.includes(de('mermaid/error/title')), words.filter((w) => /mermaid|Mermaid/i.test(w)).join(' | '));
    assert.ok(!words.includes('Mermaid parse error'));
  });

  it('Arabic writes right to left', () => {
    const { container, applied } = mountSite();
    fire(languageSwitch(container), 'change', { target: { value: 'ar' } });
    assert.deepStrictEqual(applied, [['ar', 'rtl']]);
  });

  it("Play's Messages select writes the same language", () => {
    const { app, container, applied } = mountSite();
    app.dispatch('play/example', 'validate-invalid');
    const messages = findAll(container, (n) => n.tagName === 'select' && (n.getAttribute?.('class') ?? '') !== 'lang-switch'
      && (n.childNodes ?? []).some((/** @type {any} */ o) => o.getAttribute?.('value') === 'fr'))[0];
    fire(messages, 'change', { target: { value: 'fr' } });
    assert.strictEqual(app.getState().lang, 'fr');
    assert.deepStrictEqual(applied, [['fr', 'ltr']]);
    const selected = languageSwitch(container).childNodes.filter((/** @type {any} */ o) => o.getAttribute?.('selected') != null);
    assert.deepStrictEqual(selected.map((/** @type {any} */ o) => o.getAttribute('value')), ['fr'], 'the header follows');
  });

  it('a ?lang= link picks the language on any page; an unknown one is ignored', () => {
    const docs = mountSite({ hash: '#/docs?lang=ja' });
    assert.strictEqual(docs.app.getState().lang, 'ja');
    docs.go('#/play?lang=xx');
    assert.strictEqual(docs.app.getState().lang, 'ja');
  });

  it('a session naming a language the site does not offer adopts none, and a hand-made one is English', async () => {
    const { encodeShare } = await import('@jarenjs/app');
    for (const locale of ['xx', 5, null, 'constructor']) {
      const session = { engine: 'validate', exampleId: null, source: { schema: '{}' }, data: { data: '{}' }, config: { locale } };
      const { app, container, applied } = mountSite({ hash: `#/play?s=${encodeShare(session)}` });
      assert.strictEqual(app.getState().lang, null, `${String(locale)} is not adopted`);
      assert.deepStrictEqual(applied, []);
      // read as before, ignored for the language: it renders in its reader's (English)
      assert.deepStrictEqual(app.getState().play.config, { locale });
      const selected = languageSwitch(container).childNodes.filter((/** @type {any} */ o) => o.getAttribute?.('selected') != null);
      assert.deepStrictEqual(selected.map((/** @type {any} */ o) => o.getAttribute('value')), ['en']);
    }
    const { app, applied } = mountSite();
    app.dispatch('site/lang', 'xx');
    assert.strictEqual(app.getState().lang, null);
    assert.deepStrictEqual(applied, []);
    app.dispatch('play/example', 'validate-invalid');
    app.dispatch('play/option', { key: 'locale' }, { target: { value: 'xx' } });
    assert.strictEqual(app.getState().lang, null, 'the Messages select writes only an offered language');
  });

  it('the stored choice is the language at boot; one the site does not offer is English', () => {
    const stored = mountSite({ initialLang: 'ko' });
    assert.strictEqual(stored.app.getState().lang, 'ko');
    assert.deepStrictEqual(stored.applied, [['ko', 'ltr']]);
    assert.strictEqual(mountSite({ initialLang: 'xx' }).app.getState().lang, null);
  });

  it("a status line speaks the site's words, and a switch clears it", async () => {
    const shared = [];
    const { app, container } = mountSite({ share: (/** @type {string} */ h) => { shared.push(h); return h; } });
    fire(languageSwitch(container), 'change', { target: { value: 'nl' } });
    await settle();
    app.dispatch('play/share');
    const nl = await loadSitePack('nl');
    assert.strictEqual(app.getState().play.shared, nl?.['site/play/link-copied']);
    fire(languageSwitch(container), 'change', { target: { value: 'fr' } });
    assert.strictEqual(app.getState().play.shared, null);
  });

  it("a schema that is not JSON is refused in the site's words, the parser's own text kept", async () => {
    const { app, container } = mountSite();
    app.dispatch('play/example', 'validate-invalid');
    fire(languageSwitch(container), 'change', { target: { value: 'es' } });
    await settle();
    app.dispatch('play/source', { key: 'schema' }, { target: { value: '{"type": ' } });
    const es = await loadSitePack('es');
    const message = app.getState().play.result.error.message;
    assert.ok(message.startsWith(String(es?.['site/schema/invalid-json']).split('{reason}')[0]), message);
    assert.match(message, /JSON/);
  });

  it("a site pack that cannot load leaves the site's words English and the packages' words switched", async () => {
    const { app, container } = mountSite({ loadSitePack: () => Promise.reject(new Error('offline')) });
    app.dispatch('play/example', 'validate-invalid');
    fire(languageSwitch(container), 'change', { target: { value: 'de' } });
    await settle();
    assert.strictEqual(app.getState().siteMessages, null);
    assert.strictEqual(languageSwitch(container).getAttribute('aria-label'), 'Language');
    const cells = findAll(container, (n) => n.tagName === 'td').map(textOf);
    assert.ok(cells.includes('muss >= 13 sein'));
  });
});
