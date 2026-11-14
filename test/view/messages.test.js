//@ts-check
/**
 * @file The view package speaks the reader's language: the dialog's close
 * button renders its default text through the host's compiled catalog
 * (`DialogOptions.messages`), an explicit `closeLabel` still wins, and
 * without a catalog the text is the English it was.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileMessageCatalog } from '@jarenjs/core/message';
import { viewMessagesEn, viewText } from '@jarenjs/view';
import { createDialog } from '@jarenjs/view/helpers/dialog';
import { createStubHost } from './dom.stub.js';

const IDS = Object.keys(viewMessagesEn);
const PSEUDO = compileMessageCatalog(Object.fromEntries(IDS.map((id) => [id, `⟦${id}⟧`])));

/** A connected stub host whose `<dialog>` can open modally. */
function host() {
  const { document: doc, container } = createStubHost();
  const create = doc.createElement.bind(doc);
  const walk = (/** @type {any} */ node) => [node, ...(node.childNodes ?? []).flatMap(walk)];
  const decorate = (/** @type {any} */ node) => {
    node.contains = (/** @type {any} */ other) => walk(node).includes(other);
    Object.defineProperty(node, 'isConnected', { get: () => !!doc.body?.contains(node) });
    if (node.nodeName === 'DIALOG') { node.open = false; node.showModal = () => { node.open = true; }; node.close = () => { node.open = false; }; }
    return node;
  };
  doc.createElement = (/** @type {string} */ tag) => decorate(create(tag));
  doc.body = doc.createElement('body'); decorate(container); doc.body.appendChild(container);
  doc.getElementById = (/** @type {string} */ id) => walk(doc.body).find((node) => node.getAttribute?.('id') === id) ?? null;
  return container;
}
const props = { id: 'settings', title: 'Settings', open: false };
const closeText = (/** @type {any} */ el) => el.childNodes[0].childNodes[2].childNodes[0].nodeValue;

describe('view messages', () => {
  it('renders the close button through the catalog; closeLabel wins; English without one', () => {
    const pseudo = host();
    createDialog(pseudo, props, { messages: PSEUDO });
    assert.equal(closeText(pseudo), '⟦view/dialog/close⟧');
    assert.ok(!Object.values(viewMessagesEn).includes(closeText(pseudo)));
    const explicit = host();
    createDialog(explicit, { ...props, closeLabel: 'Done' }, { messages: PSEUDO });
    assert.equal(closeText(explicit), 'Done');
    const english = host();
    createDialog(english, props);
    assert.equal(closeText(english), 'Close');
  });

  it('falls back to English per id, for a missing, throwing or non-string entry', () => {
    const t = viewText(compileMessageCatalog({ 'view/dialog/close': () => { throw new Error('x'); } }));
    assert.equal(t('view/dialog/close'), 'Close');
    assert.equal(viewText(/** @type {any} */ ({ 'view/dialog/close': () => 7 }))('view/dialog/close'), 'Close');
    assert.equal(viewText({})('view/dialog/close'), 'Close');
    assert.equal(viewText()('view/unknown'), 'view/unknown');
  });

  it('uses every id of its catalog in the source', () => {
    const source = readFileSync(new URL('../../packages/view/src/helpers/dialog.js', import.meta.url), 'utf8');
    for (const id of IDS) assert.ok(source.includes(`'${id}'`), `${id} is used`);
  });
});
