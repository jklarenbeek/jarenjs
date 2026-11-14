//@ts-check
/**
 * Play speaks the language the reader chose: the Messages select is a
 * play-wide preference that every later load keeps (an example, a deep
 * link, New, a saved session, an imported file, a share link), an
 * example made to show one language sets it, the text a schema wrote
 * stays as written, and the generated form's chrome speaks the language
 * its field alerts speak.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { encodeShare } from '@jarenjs/app';
import { compileMessageCatalog } from '@jarenjs/validate';
import { formChromeLabels } from '@jarenjs/forms';
import * as packs from '@jarenjs/locales';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { LOCALES } from '../../packages/website/src/boundaries/validator.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, fire } from '../view/dom.stub.js';

/** A headless site over persisting storage, entered at `hash`. @param {{ hash?: string, openFile?: any, share?: any }} [options] */
function mountSite({ hash = '#/play', openFile, share } = {}) {
  const { document, container } = createStubHost();
  const cell = { data: null };
  /** @type {any} */
  let routeCb = null;
  const app = createSiteApp({
    node: container,
    document,
    schedule: (f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
    navigate: (h) => routeCb(parseHash(h)),
    storage: { read: () => cell.data, write: (d) => { cell.data = JSON.parse(JSON.stringify(d)); } },
    openFile,
    share,
    onError: (err) => { throw err; },
  });
  return { app, container, go: (/** @type {string} */ h) => routeCb(parseHash(h)) };
}

/** @param {any} node @param {(n: any) => boolean} pred @returns {any[]} */
const findAll = (node, pred) => [...(pred(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((/** @type {any} */ c) => findAll(c, pred))];
/** @param {any} node @param {(n: any) => boolean} pred */
const find = (node, pred) => findAll(node, pred)[0];
/** @param {any} node @returns {string} */
const textOf = (node) => (node.nodeValue != null ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
/** @param {any} c */
const playRoot = (c) => find(c, (n) => n.getAttribute?.('class') === 'jplay');
/** The validate engine's Messages select. @param {any} c */
const messages = (c) => find(playRoot(c), (n) => n.tagName === 'select'
  && (n.childNodes ?? []).some((/** @type {any} */ o) => o.getAttribute?.('value') === 'de'));
/** @param {any} c @param {string} locale */
const choose = (c, locale) => fire(messages(c), 'change', { target: { value: locale } });
/** The message cells of the errors table (every second cell; the first is the path). @param {any} c */
const messageCells = (c) => findAll(playRoot(c), (n) => n.tagName === 'td').map(textOf).filter((_, i) => i % 2 === 1);
/** @param {any} app @param {string} key @param {string} value */
const source = (app, key, value) => app.dispatch('play/source', { key }, { target: { value } });
/** @param {any} app @param {string} value */
const data = (app, value) => app.dispatch('play/data', { key: 'data' }, { target: { value } });
/** @param {any} c */
const openForm = (c) => fire(find(playRoot(c), (n) => n.tagName === 'button' && n.childNodes?.[0]?.nodeValue === 'Form'), 'click', {});

/** A German run of the stock invalid-data example: the reader chose Deutsch. */
function german(options = {}) {
  const site = mountSite(options);
  site.app.dispatch('play/example', 'validate-invalid');
  choose(site.container, 'de');
  return site;
}

/** The answer a German table gives for the stock User example's invalid data. */
const GERMAN_REQUIRED = "muss die Pflichteigenschaft 'email' enthalten";

/** An English validate session, as a saved record, a file or a link carries it. */
const ENGLISH_SESSION = {
  engine: 'validate', exampleId: null, config: { locale: 'en' },
  source: { schema: JSON.stringify({ type: 'object', required: ['email'] }) },
  data: { data: '{}' },
};

/**
 * The pack each LOCALES code names.
 * @type {Record<string, any>}
 */
const PACK = { nl: packs.nl, fr: packs.fr, es: packs.es, pt: packs.pt, de: packs.de, ja: packs.ja, ko: packs.ko, 'zh-tw': packs.zhTW, ru: packs.ru, tr: packs.tr, ar: packs.ar };

describe('website — Play keeps the message language the reader chose', () => {
  it('through another example', () => {
    const { app, container } = german();
    app.dispatch('play/example', 'validate-user');
    data(app, '{"name":"Al"}');
    assert.strictEqual(app.getState().play.locale, 'de');
    assert.deepStrictEqual(messageCells(container), [GERMAN_REQUIRED]);
    const selected = (messages(container).childNodes ?? []).filter((/** @type {any} */ o) => o.getAttribute?.('selected') != null);
    assert.deepStrictEqual(selected.map((/** @type {any} */ o) => o.getAttribute('value')), ['de'], 'the select shows the language in use');
  });

  it('through another engine and back', () => {
    const { app, container } = german();
    app.dispatch('play/example', 'path-authors');
    app.dispatch('play/example', 'validate-invalid');
    assert.ok(messageCells(container).includes('darf nicht weniger als 2 Zeichen enthalten'), messageCells(container).join(' | '));
  });

  it('through a deep link', () => {
    const { app, container, go } = german();
    go('#/play?example=validate-user');
    assert.strictEqual(app.getState().play.exampleId, 'validate-user', 'the link loaded its example');
    data(app, '{"name":"Al"}');
    assert.deepStrictEqual(messageCells(container), [GERMAN_REQUIRED]);
  });

  it('through New', () => {
    const { app, container } = german();
    app.dispatch('play/new');
    source(app, 'schema', JSON.stringify({ type: 'object', required: ['email'] }));
    data(app, '{}');
    assert.deepStrictEqual(messageCells(container), [GERMAN_REQUIRED]);
  });

  it('through opening a session saved in English', () => {
    const { app, container } = german();
    app.dispatch('play/loaded-session', { ...ENGLISH_SESSION, name: 'english' });
    app.dispatch('play/save');
    app.dispatch('play/example', 'validate-invalid');
    app.dispatch('play/open', null, { target: { value: 'english' } });
    assert.strictEqual(app.getState().play.savedName, 'english', 'the record opened');
    assert.deepStrictEqual(messageCells(container), [GERMAN_REQUIRED]);
  });

  it('through an imported file', async () => {
    const { app, container } = german({ openFile: () => Promise.resolve({ name: 'f.json', text: JSON.stringify(ENGLISH_SESSION) }) });
    app.dispatch('play/import');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(messageCells(container), [GERMAN_REQUIRED]);
  });

  it('through a share link', () => {
    const { container, go } = german();
    go(`#/play?s=${encodeShare(ENGLISH_SESSION)}`);
    assert.deepStrictEqual(messageCells(container), [GERMAN_REQUIRED]);
  });

  it('an example made to show a language sets it, and it then stays', () => {
    const { app, container } = german();
    app.dispatch('play/example', 'validate-locale-fr');
    assert.strictEqual(app.getState().play.locale, 'fr');
    app.dispatch('play/example', 'validate-invalid');
    assert.ok(messageCells(container).includes('doit être >= 13'), messageCells(container).join(' | '));
  });

  it('a share link opened before any choice shows its own language, which then stays', () => {
    const { app, container } = mountSite({ hash: `#/play?s=${encodeShare({ ...ENGLISH_SESSION, config: { locale: 'fr' } })}` });
    assert.deepStrictEqual(messageCells(container), ["doit contenir la propriété obligatoire 'email'"]);
    app.dispatch('play/example', 'validate-invalid');
    assert.ok(messageCells(container).includes('doit être >= 13'), messageCells(container).join(' | '));
  });

  it('a share link carries the language on screen', () => {
    /** @type {string[]} */
    const shared = [];
    const { app } = german({ share: (/** @type {string} */ h) => { shared.push(h); return h; } });
    app.dispatch('play/example', 'validate-user');
    app.dispatch('play/share');
    assert.strictEqual(shared.length, 1, 'Share produced a link');
    const fresh = mountSite({ hash: shared[0] });
    fresh.app.dispatch('play/data', { key: 'data' }, { target: { value: '{"name":"Al"}' } });
    assert.deepStrictEqual(messageCells(fresh.container), [GERMAN_REQUIRED]);
  });
});

describe('website — Play shows the text a schema wrote, in every language', () => {
  const inline = JSON.stringify({ type: 'object', properties: { age: { type: 'integer', errorMessage: 'age must be a whole number' } } });
  const fallback = JSON.stringify({ type: 'object', properties: { age: { type: 'integer', errorMessage: { $msgid: 'app.age', message: 'age must be a whole number' } } } });
  for (const locale of LOCALES) {
    it(`${locale}: an inline errorMessage and a $msgid fallback stay as written`, () => {
      const { app, container } = mountSite();
      app.dispatch('play/example', 'validate-invalid');
      choose(container, locale);
      source(app, 'schema', inline);
      data(app, '{"age":"x"}');
      assert.deepStrictEqual(messageCells(container), ['age must be a whole number'], 'inline text');
      source(app, 'schema', fallback);
      assert.deepStrictEqual(messageCells(container), ['age must be a whole number'], 'the fallback of a msgid no catalog carries');
    });
  }
});

describe("website — Play's generated form speaks the chosen language", () => {
  const schema = JSON.stringify({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } }, any: {} } });
  /** The chrome a form shows: the array buttons' names and the JSON hint. @param {any} c */
  const chrome = (c) => {
    const names = new Set(findAll(playRoot(c), (n) => n.tagName === 'button' && n.getAttribute?.('aria-label') != null).map((n) => n.getAttribute('aria-label')));
    const hints = new Set(findAll(playRoot(c), (n) => n.tagName === 'textarea' && n.getAttribute?.('placeholder') != null).map((n) => n.getAttribute('placeholder')));
    return { names, hints };
  };
  for (const locale of LOCALES) {
    it(`${locale}: the add and remove buttons and the JSON hint come from the pack`, () => {
      const { app, container } = mountSite();
      app.dispatch('play/example', 'validate-invalid');
      choose(container, locale);
      source(app, 'schema', schema);
      data(app, '{"tags":["a"]}');
      openForm(container);
      const labels = formChromeLabels(locale === 'en' ? undefined : compileMessageCatalog(PACK[locale]));
      const { names, hints } = chrome(container);
      assert.ok(names.has(labels.addItem), `${locale} add: ${[...names].join(' | ')}`);
      assert.ok(names.has(labels.removeItem), `${locale} remove: ${[...names].join(' | ')}`);
      assert.ok(hints.has(labels.jsonPlaceholder), `${locale} hint: ${[...hints].join(' | ')}`);
    });
  }

  it('the form keeps the chosen language through another example', () => {
    const { app, container } = german();
    app.dispatch('play/example', 'validate-user');
    source(app, 'schema', schema);
    data(app, '{"tags":["a"]}');
    openForm(container);
    const labels = formChromeLabels(compileMessageCatalog(packs.de));
    assert.ok(chrome(container).names.has(labels.addItem), [...chrome(container).names].join(' | '));
    source(app, 'schema', JSON.stringify({ type: 'object', properties: { name: { type: 'string', minLength: 2 } } }));
    data(app, '{"name":"A"}');
    openForm(container);
    const alerts = findAll(playRoot(container), (n) => n.getAttribute?.('role') === 'alert').map(textOf);
    assert.deepStrictEqual(alerts, ['Muss mindestens 2 Zeichen enthalten (derzeit 1)']);
  });

  it('a language switch with the form open renames its chrome', () => {
    const { app, container } = mountSite();
    app.dispatch('play/example', 'validate-invalid');
    source(app, 'schema', schema);
    data(app, '{"tags":["a"]}');
    openForm(container);
    assert.ok(chrome(container).names.has('Add item'));
    choose(container, 'nl');
    const nl = formChromeLabels(compileMessageCatalog(packs.nl));
    assert.ok(chrome(container).names.has(nl.addItem), [...chrome(container).names].join(' | '));
    assert.ok(!chrome(container).names.has('Add item'));
  });
});
