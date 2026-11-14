//@ts-check
/**
 * @file The rule editor speaks the reader's language. A pseudo-locale
 * (every rules message id rendered as `⟦id⟧`) mounts the editor and walks
 * it through a preview with diagnostics, an absent value and a second
 * page, a refused and a failed command and a failed preview: no text node
 * or accessible name of its chrome may show the English catalog's text,
 * and every id must be reached. Without a catalog every word is the
 * English it was.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileMessageCatalog } from '@jarenjs/core/message';
import { createRuleEditor, rulesMessagesEn, rulesText } from '@jarenjs/rules';
import { mountRuleEditor } from '@jarenjs/rules/component';
import { collectionHost } from '../collection/dom-host.js';

const IDS = Object.keys(rulesMessagesEn);
const reached = new Set();
const PSEUDO = compileMessageCatalog(Object.fromEntries(IDS.map((id) => [id, () => { reached.add(id); return `⟦${id}⟧`; }])));

const plan = {
  id: 'plan', omittedErrors: 3,
  errors: [{ rowId: 'row-1', targetId: 'a', code: 'E1', message: 'service text', docPath: '/x' }],
  changes: Array.from({ length: 12 }, (_, i) => ({ id: `change-${i}`, entityId: `row-${i}`, field: '/count',
    before: i === 0 ? { present: false } : { present: true, value: 1 }, proposed: 2 })),
};
const schema = { type: 'object', properties: { count: { type: 'number', title: 'Count' } } };
const text = JSON.stringify({ targets: [{ id: 'a', field: '/count' }] });

/** Every chrome string of a stub subtree: text nodes and accessible names,
 * less the content the host or the service wrote (`pre`, `option`, the
 * diagnostics and the change rows, whose own text is data). */
function chrome(/** @type {any} */ node, /** @type {string[]} */ out = []) {
  if (node.nodeType === 3) { out.push(node.nodeValue); return out; }
  const label = node.getAttribute?.('aria-label');
  if (typeof label === 'string') out.push(label);
  if (['pre', 'option', 'li', 'PRE', 'OPTION', 'LI'].includes(node.tagName)) return out;
  for (const child of node.childNodes ?? []) chrome(child, out);
  return out;
}
/** Every text of a stub subtree. */
const all = (/** @type {any} */ node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(all).join('');

/** Mount, preview, page, commit (refused, then failed), and fail a preview. */
async function walk(/** @type {any} */ messages) {
  const env = collectionHost();
  const views = [];
  let outcome = 'refused';
  const mounted = mountRuleEditor(env.host, { text, schema, pageSize: 10, messages, preview: () => plan,
    command: async () => { if (outcome === 'failed') throw new Error('down'); return { state: outcome }; } });
  views.push(chrome(env.host));
  const previewing = mounted.controller.preview();
  views.push(chrome(env.host));
  await previewing;
  views.push(chrome(env.host), env.host.querySelectorAll('li').slice(1, 3).map(all));
  mounted.controller.select('change-1');
  await mounted.controller.commit(); views.push(chrome(env.host));
  outcome = 'failed'; await mounted.controller.commit(); views.push(chrome(env.host));
  outcome = 'committed'; await mounted.controller.commit(); views.push(chrome(env.host));
  mounted.dispose();
  const broken = createRuleEditor({ text, messages, preview: () => { throw new Error('parse'); } });
  await broken.preview();
  const opaque = createRuleEditor({ text, messages, preview: () => { throw { get message() { throw new Error('hidden'); } }; } });
  await opaque.preview();
  views.push([broken.state().message, opaque.state().message]);
  return views.flat().filter((s) => s.trim() !== '');
}

describe('rules messages', () => {
  it('shows no English under a pseudo-locale, and reaches every id', async () => {
    const shown = await walk(PSEUDO);
    const english = Object.values(rulesMessagesEn).map((entry) => String(entry).split('{')[0].trim()).filter((s) => s !== '');
    for (const s of shown) {
      // the review line names a row and its values: only its own words are chrome
      const words = s.replace(/row-\d+ \/count: (?:1|⟦[^⟧]+⟧) → 2/, '');
      assert.ok(words.trim() === '' || words.includes('⟦') || /^[\d\s·:()→]+$/.test(words), `unmarked chrome "${s}"`);
      for (const word of english) assert.ok(!s.includes(word), `English "${word}" in "${s}"`);
    }
    assert.deepEqual(IDS.filter((id) => !reached.has(id)), []);
  });

  it('keeps the English without a catalog', async () => {
    const shown = await walk(undefined);
    for (const expected of ['Rule editor', 'Target ', 'Rule target', 'Writable field ', 'Writable field', 'Target enabled', 'Enabled',
      'Rule document', 'Available schema fields', 'Preview rules', 'Commit selected (0)', 'Evaluating preview…',
      '12 proposed changes · 0 selected', 'Preview diagnostics', 'Proposed changes', 'row-0 /count: (absent) → 2', 'Preview pages',
      'Previous', 'Page 1 of 2', 'Next', 'Command refused. Preview current data again.', 'Command failed. Preview current data again.',
      'Selected changes committed.', 'Preview failed: parse', 'Preview failed: Check the rule document.']) {
      assert.ok(shown.includes(expected), `"${expected}" is shown`);
    }
    const env = collectionHost();
    const mounted = mountRuleEditor(env.host, { text, schema, pageSize: 10, preview: () => plan });
    await mounted.controller.preview();
    assert.ok(all(env.host).includes('3 further diagnostics omitted by the configured limit.'));
    mounted.dispose();
  });

  it('falls back to English per id, for a missing, throwing or non-string entry', () => {
    assert.equal(rulesText(compileMessageCatalog({ 'rules/preview': () => { throw new Error('x'); } }))('rules/preview'), 'Preview rules');
    assert.equal(rulesText(/** @type {any} */ ({ 'rules/page/next': () => 2 }))('rules/page/next'), 'Next');
    assert.equal(rulesText()('rules/unknown'), 'rules/unknown');
  });

  it('uses every id of its catalog in the source', () => {
    const source = ['index.js', 'component/index.js']
      .map((file) => readFileSync(new URL(`../../components/rules/src/${file}`, import.meta.url), 'utf8')).join('\n');
    for (const id of IDS) assert.ok(source.includes(`'${id}'`), `${id} is used`);
  });
});
