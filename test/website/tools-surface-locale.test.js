//@ts-check
/**
 * Under every language but English, no word of a tool's catalog is left in
 * English on the tools' surfaces — the Project IDE and Studio, the Flow
 * Studio and the calculator: every text node, accessible name, title and
 * placeholder is checked against the English values of the components'
 * catalogs and the site's. An entry a pack keeps identical to the English
 * (a loanword) is exempt and counted. English prose blocks (`lang="en"`)
 * are English by design.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { LOCALE_NAMES } from '@jarenjs/locales/names';
import * as packs from '@jarenjs/locales';
import { studioMessagesEn } from '@jarenjs/studio';
import { mermaidMessagesEn } from '@jarenjs/mermaid';
import { calcMessagesEn } from '@jarenjs/calc';
import { rulesMessagesEn } from '@jarenjs/rules';
import { collectionMessagesEn } from '@jarenjs/collection';
import { chartsMessagesEn } from '@jarenjs/charts';
import { viewMessagesEn } from '@jarenjs/view';
import { formsMessagesEn } from '@jarenjs/forms';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { siteMessagesEn } from '../../packages/website/src/messages.js';
import { loadSitePack } from '../../packages/website/src/boundaries/lang.js';
import { catalogFor } from '../../packages/website/src/boundaries/validator.js';
import { createStubHost } from '../view/dom.stub.js';

/** Words that are names in every language. */
const PROPER_NOUNS = new Set(['Jaren', 'GitHub', 'npm', 'JSON', 'JSON Schema', 'JSLT', 'JTLT', 'CSV', 'Mermaid', 'SQLite']);

/** The pages of the tools, each read after it settles. */
const PAGES = ['#/project', '#/flow', '#/calculator'];

/** @param {string} hash */
function mountSite(hash) {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  const app = createSiteApp({
    node: container, document, schedule: (f) => f(), debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
    navigate: (h) => routeCb(parseHash(h)),
    storage: { read: () => null, write: () => {} },
    onError: () => {},
  });
  return { app, container };
}

/** Every string a person meets on a node tree, outside English prose. @param {any} node @param {string[]} out */
function shown(node, out = []) {
  if (node.nodeValue != null) { if (node.nodeValue.trim() !== '') out.push(node.nodeValue.trim()); return out; }
  if (node.getAttribute?.('lang') === 'en') return out;
  // the site header and its nav are the shell, not a tool; a file's kind
  // ('query', 'schema') is the type name its file carries (`npv.query`): code
  if (node.tagName === 'header') return out;
  const cls = (node.getAttribute?.('class') ?? '').split(' ');
  if (cls.includes('js-badge') || cls.includes('js-addfile')) return out;
  for (const name of ['aria-label', 'title', 'placeholder', 'aria-description']) {
    const value = node.getAttribute?.(name);
    if (typeof value === 'string' && value.trim() !== '') out.push(value.trim());
  }
  for (const child of node.childNodes ?? []) shown(child, out);
  return out;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("website — the tools show no English word of their catalogs under another language", () => {
  for (const { code, pack: name } of LOCALE_NAMES) {
    it(`${code}: the IDE, the Flow Studio and the calculator`, async () => {
      const pack = /** @type {any} */ (packs)[name];
      const sitePack = await loadSitePack(code);
      /** @type {Map<string, string>} */
      const english = new Map();
      let identical = 0;
      const catalogs = [studioMessagesEn, mermaidMessagesEn, calcMessagesEn, rulesMessagesEn, collectionMessagesEn,
        chartsMessagesEn, viewMessagesEn, formsMessagesEn];
      for (const [catalog, translated] of /** @type {any[]} */ ([...catalogs.map((c) => [c, pack]), [siteMessagesEn, sitePack]])) {
        for (const [id, value] of Object.entries(catalog)) {
          if (typeof value !== 'string' || /\{/.test(value) || PROPER_NOUNS.has(value) || value.length < 2) continue;
          if (translated?.[id] === value) { identical++; continue; }
          english.set(value, id);
        }
      }
      // a word the pack itself writes for another id is that language's word,
      // not English left behind (a loanword shared by two catalogs)
      const translated = new Set([pack, sitePack].flatMap((p) => Object.values(p ?? {}).filter((v) => typeof v === 'string')));
      /** @type {string[]} */
      const left = [];
      let read = 0;
      for (const page of PAGES) {
        const { app, container } = mountSite(page);
        app.dispatch('site/lang', code);
        for (let i = 0; i < 200 && catalogFor(code) === undefined; i++) await settle();
        await settle(); await settle();
        const words = shown(container);
        read += words.length;
        for (const text of words) if (english.has(text) && !translated.has(text)) left.push(`${page}: "${text}" (${english.get(text)})`);
      }
      assert.deepStrictEqual([...new Set(left)], [], `${code} leaves English on screen`);
      assert.ok(read > 100, `read ${read} strings`);
      // loanwords a language's UI keeps: few, never most
      // counted as a share of the entries checked: few, never most (Dutch
      // shares the most: Document, Plan, Route, Variant, Diagram, Test)
      assert.ok(identical <= 0.15 * (identical + english.size), `${code} keeps ${identical} of ${identical + english.size} entries identical to the English`);
    });
  }
});
