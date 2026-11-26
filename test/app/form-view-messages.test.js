//@ts-check
/**
 * @file The form view's own chrome words — the array add/remove buttons'
 * accessible names and the JSON editor's hint — have one English home,
 * `@jarenjs/core/message`, which `@jarenjs/forms`' catalog and
 * `formChromeLabels` read too, and `createFormView({ messages })` reads
 * them from the reader's compiled locale pack. A host that passed neither
 * `labels` nor `labelsPath` showed English whatever its language; an
 * English host's rule set is unchanged.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createFormView } from '@jarenjs/app';
import { formChromeLabels as formsChromeLabels, formsMessagesEn } from '@jarenjs/forms';
import { formChromeLabels, formChromeMessagesEn, compileMessageCatalog } from '@jarenjs/core/message';
import { nl, de } from '@jarenjs/locales';

/** The chrome a rule set writes: every `aria-label`, `title`, `placeholder` and `aria-description` value. @param {unknown} rules */
function chromeOf(rules) {
  /** @type {Set<string>} */
  const found = new Set();
  JSON.stringify(rules, (key, value) => {
    if (['aria-label', 'title', 'placeholder', 'aria-description'].includes(key) && value && typeof value.$const === 'string') found.add(value.$const);
    return value;
  });
  return [...found].sort();
}

describe('createFormView — the chrome words from a catalog', () => {
  it('speaks the reader\'s pack when given one, a label still winning', () => {
    assert.deepEqual(chromeOf(createFormView({ messages: compileMessageCatalog(nl) })),
      ['Item toevoegen', 'Item verwijderen', 'Voer een JSON-waarde in']);
    assert.deepEqual(chromeOf(createFormView({ messages: compileMessageCatalog(de), labels: { addItem: 'Zeile' } })),
      [formChromeLabels(compileMessageCatalog(de)).jsonPlaceholder, formChromeLabels(compileMessageCatalog(de)).removeItem, 'Zeile'].sort());
    // a pack without the ids falls back to English per id
    assert.deepEqual(chromeOf(createFormView({ messages: compileMessageCatalog({ 'form/addItem': 'Ajouter' }) })),
      ['Ajouter', 'Enter a JSON value', 'Remove item']);
  });

  it('renders an English host\'s rule set as before', () => {
    const english = JSON.stringify(createFormView());
    assert.equal(JSON.stringify(createFormView({ messages: undefined })), english);
    assert.equal(JSON.stringify(createFormView({ messages: null })), english);
    assert.equal(JSON.stringify(createFormView({ messages: compileMessageCatalog({}) })), english);
    assert.deepEqual(chromeOf(createFormView()), ['Add item', 'Enter a JSON value', 'Remove item']);
  });

  it('reads the pack at a labels path\'s fallback', () => {
    const rules = JSON.stringify(createFormView({ labelsPath: '$.chrome', messages: compileMessageCatalog(nl) }));
    assert.ok(rules.includes('{"$default":["$root.chrome.addItem",{"$const":"Item toevoegen"}]}'));
  });

  it('refuses a catalog that is no object, and a pack not yet compiled', () => {
    for (const bad of ['nl', 5, [], true]) {
      assert.throws(() => createFormView(/** @type {any} */ ({ messages: bad })),
        (/** @type {any} */ error) => error instanceof TypeError && /^createFormView: options\.messages must be a compiled message catalog, got /.test(error.message));
    }
    // a raw pack holds template strings: it answered the host's unnamed TypeError at the first word
    assert.throws(() => createFormView(/** @type {any} */ ({ messages: nl })), (/** @type {any} */ error) => error instanceof TypeError
      && /^createFormView: options\.messages must be a compiled message catalog \(compileMessageCatalog\), got .* at 'form\/addItem'$/.test(error.message));
  });

  it('keeps the words in one home: the forms catalog and formChromeLabels are core\'s', () => {
    assert.equal(formsChromeLabels, formChromeLabels);
    for (const [id, english] of Object.entries(formChromeMessagesEn)) assert.equal(formsMessagesEn[id], english);
    assert.deepEqual(formChromeLabels(), { addItem: 'Add item', removeItem: 'Remove item', jsonPlaceholder: 'Enter a JSON value' });
    assert.deepEqual(formChromeLabels(compileMessageCatalog(nl)), { addItem: 'Item toevoegen', removeItem: 'Item verwijderen', jsonPlaceholder: 'Voer een JSON-waarde in' });
  });
});
