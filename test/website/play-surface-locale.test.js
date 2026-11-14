//@ts-check
/**
 * Under every language but English, no word of Play's chrome or of the
 * site's own catalog is left in English on the Play surface: every text
 * node, accessible name, title and placeholder of one example per engine
 * is checked against the English values. An entry a pack keeps identical
 * to the English (a word the language borrows, "JSON" in a label) is
 * exempt, and the exemptions are counted so they stay few.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { LOCALE_NAMES } from '@jarenjs/locales/names';
import * as packs from '@jarenjs/locales';
import { playMessagesEn } from '@jarenjs/play';
import { formsMessagesEn } from '@jarenjs/forms';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { siteMessagesEn } from '../../packages/website/src/messages.js';
import { loadSitePack } from '../../packages/website/src/boundaries/lang.js';
import { playComponent } from '../../packages/website/src/boundaries/play.js';
import { createStubHost } from '../view/dom.stub.js';

/** Words that are names in every language: the engines and the suite. */
const PROPER_NOUNS = new Set(['Jaren', 'GitHub', 'npm', 'JSON', 'JSONPath', 'JSON Pointer', 'JSON Patch', 'JSON Schema',
  '$query', 'JSLT', 'JTLT', 'XQuery', 'LINQ', 'JOSL', 'JSONX', 'CSV', 'MDX', 'Mermaid', 'Contract', 'Emit']);

/** One example per engine: the surface each engine shows (none that names a language, which would switch it). */
const ONE_PER_ENGINE = [...new Map(playComponent.examples.filter((e) => e.config?.locale === undefined).map((e) => [e.engine, e.id])).values()];

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

/** Every string a person meets on a node tree. @param {any} node @param {string[]} out */
function shown(node, out = []) {
  if (node.nodeValue != null) { if (node.nodeValue.trim() !== '') out.push(node.nodeValue.trim()); return out; }
  // a block the page marks as English prose is English by design, and an
  // example's name in the rail is example content (presets stay English)
  if (node.getAttribute?.('lang') === 'en' || (node.getAttribute?.('class') ?? '').split(' ').includes('jplay-ex')) return out;
  for (const name of ['aria-label', 'title', 'placeholder', 'aria-description']) {
    const value = node.getAttribute?.(name);
    if (typeof value === 'string' && value.trim() !== '') out.push(value.trim());
  }
  for (const child of node.childNodes ?? []) shown(child, out);
  return out;
}

/** @param {any} c */
const playRoot = (c) => {
  /** @param {any} n @returns {any} */
  const find = (n) => (n.getAttribute?.('class') === 'jplay' ? n : (n.childNodes ?? []).map(find).find(Boolean));
  return find(c);
};

describe('website — Play shows no English word of its catalogs under another language', () => {
  for (const { code, pack: name } of LOCALE_NAMES) {
    it(`${code}: one example per engine`, async () => {
      const pack = /** @type {any} */ (packs)[name];
      const sitePack = await loadSitePack(code);
      /** @type {Map<string, string>} English value -> its id, for the entries the pack translates */
      const english = new Map();
      let identical = 0;
      const catalogs = [[playMessagesEn, pack], [siteMessagesEn, sitePack], [formsMessagesEn, pack]];
      for (const [catalog, translated] of /** @type {any[]} */ (catalogs)) {
        for (const [id, value] of Object.entries(catalog)) {
          if (typeof value !== 'string' || /\{/.test(value) || PROPER_NOUNS.has(value)) continue;
          if (translated?.[id] === value) { identical++; continue; }
          english.set(value, id);
        }
      }
      const { app, container } = mountSite();
      app.dispatch('site/lang', code);
      await new Promise((resolve) => setTimeout(resolve, 0));
      /** @type {string[]} */
      const left = [];
      for (const id of ONE_PER_ENGINE) {
        app.dispatch('play/example', id);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.strictEqual(app.getState().lang, code, `${id} keeps the language`);
        for (const text of shown(playRoot(container))) if (english.has(text)) left.push(`${id}: "${text}" (${english.get(text)})`);
      }
      assert.deepStrictEqual([...new Set(left)], [], `${code} leaves English on screen`);
      // loanwords a language's UI keeps (Dutch 'Schema', French 'Document'): few, never most
      assert.ok(identical <= 30, `${code} keeps ${identical} entries identical to the English`);
    });
  }
});
