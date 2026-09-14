/** Owner protocol tests; keyboard/inert semantics are verified in actual browsers. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDialog, DIALOG_CODES } from '@jarenjs/view/helpers/dialog';
import { createDialogWidget } from '@jarenjs/app/dialog';
import { createStubHost, fire } from '../view/dom.stub.js';

function nativeFacade() {
  const { document: doc, container: host } = createStubHost();
  const create = doc.createElement.bind(doc);
  const walk = node => [node, ...(node.childNodes ?? []).flatMap(walk)];
  doc.defaultView = { getComputedStyle: () => ({ visibility: 'visible' }) };
  const decorate = node => {
    node.contains = other => walk(node).includes(other);
    node.getClientRects = () => [{}];
    node.matches = selector => selector === ':disabled' && node.disabled === true;
    node.closest = selector => {
      for (let current = node; current; current = current.parentNode)
        if (selector === 'dialog' ? current.nodeName === 'DIALOG' : current.getAttribute?.('inert') !== null) return current;
      return null;
    };
    node.querySelectorAll = () => walk(node).filter(n => n.nodeType === 1 && n !== node && n.tabIndex >= 0);
    Object.defineProperties(node, {
      isConnected: { get: () => !!doc.body?.contains(node) },
      tabIndex: { get: () => node.getAttribute('tabindex') !== null ? Number(node.getAttribute('tabindex'))
        : ['BUTTON', 'INPUT'].includes(node.nodeName) ? 0 : -1 },
    });
    if (node.nodeName === 'DIALOG') {
      node.open = false;
      node.showModal = () => { node.open = true; };
      node.close = () => { node.open = false; fire(node, 'close', { target: node }); };
    }
    return node;
  };
  doc.createElement = tag => decorate(create(tag));
  doc.body = doc.createElement('body'); decorate(host); doc.body.appendChild(host);
  doc.getElementById = id => walk(doc.body).find(node => node.getAttribute?.('id') === id) ?? null;
  const opener = doc.createElement('button'); doc.body.appendChild(opener); opener.focus();
  return { doc, host, opener, walk };
}
const props = { id: 'settings', title: 'Settings', open: true, initialFocusRef: 'first',
  content: [['input', { 'data-ref': 'first' }], ['button', {}, 'Second']] };
const key = (target, shiftKey = false) => ({ target, key: 'Tab', shiftKey, prevented: false,
  preventDefault() { this.prevented = true; } });

describe('dialog lifecycle and app binding', () => {
  it('classifies unavailable hosts and malformed properties before acquiring ownership', () => {
    assert.deepEqual(Object.keys(DIALOG_CODES), ['JV1001', 'JV1002']);
    assert.throws(() => createDialog(null, props), { code: 'JV1001' });
    const { host, doc } = nativeFacade();
    for (const invalid of [null, { ...props, id: 'bad id' }, { ...props, title: '' }, { ...props, open: 1 },
      { ...props, closeLabel: null }, { ...props, initialFocusRef: 2 }, { ...props, fallbackFocusRef: '' }])
      assert.throws(() => createDialog(host, invalid), { code: 'JV1001' });
    const create = doc.createElement;
    doc.createElement = tag => { const node = create(tag); if (tag === 'dialog') node.showModal = undefined; return node; };
    assert.throws(() => createDialog(host, props), { code: 'JV1002' });
    assert.equal(host.childNodes.length, 0);
  });

  it('owns one set of listeners, emits close intents and releases the subtree exactly once', () => {
    const { host, doc, opener } = nativeFacade(); const intents = [];
    const owner = createDialog(host, props, { onClose: reason => intents.push(reason) });
    const dialog = host.childNodes[0], content = dialog.childNodes[1], close = dialog.childNodes[2];
    assert.equal(doc.activeElement, content.childNodes[0]);
    const backward = key(doc.activeElement, true); fire(dialog, 'keydown', backward);
    assert.equal(doc.activeElement, close);
    fire(dialog, 'keydown', key(close)); assert.equal(doc.activeElement, content.childNodes[0]);
    fire(dialog, 'keydown', { ...key(close), key: 'Enter' });
    for (let i = 0; i < 5; i++) owner.update({ ...props });
    fire(close, 'click', { target: close });
    fire(dialog, 'cancel', { preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(intents, ['button', 'escape']); assert.equal(dialog.open, true, 'close is controlled by props');
    owner.update({ ...props, open: false });
    assert.equal(doc.activeElement, opener); assert.equal(content.childNodes.length, 0);
    owner.update(props); dialog.close(); assert.deepEqual(intents, ['button', 'escape', 'native']);
    owner.update(props); owner.dispose(); owner.dispose(); owner.update(props);
    assert.equal(host.childNodes.length, 0);
    assert.equal([...dialog.listeners.values()].reduce((n, list) => n + list.size, 0), 0);
    assert.equal([...close.listeners.values()].reduce((n, list) => n + list.size, 0), 0);
  });

  it('uses a fallback after opener removal and cleans up failed nested mounts or duplicate ids', () => {
    const { host, doc, opener } = nativeFacade();
    const fallback = doc.createElement('button'); fallback.setAttribute('data-ref', 'next'); doc.body.appendChild(fallback);
    const owner = createDialog(host, { ...props, fallbackFocusRef: 'next' });
    doc.body.removeChild(opener); owner.dispose(); assert.equal(doc.activeElement, fallback);
    const collision = doc.createElement('div'); collision.setAttribute('id', 'settings'); doc.body.appendChild(collision);
    assert.throws(() => createDialog(host, props), { code: 'JV1001' }); assert.equal(host.childNodes.length, 0);
    doc.body.removeChild(collision);
    assert.throws(() => createDialog(host, props, { get widgets() { throw new Error('registry access'); } }), /registry access/);
    assert.equal(host.childNodes.length, 0);
    assert.throws(() => createDialog(host, { ...props, content: ['jaren-widget', { name: 'bad' }] }, {
      widgets: { bad: { mount() { throw new Error('nested mount'); } } },
    }), /nested mount/);
    assert.equal(host.childNodes.length, 0);
    const cleanup = createDialog(host, { ...props, content: ['jaren-widget', { name: 'bad' }] }, {
      widgets: { bad: { mount: () => null, unmount() { throw new Error('nested cleanup'); } } },
    });
    assert.throws(() => cleanup.dispose(), /nested cleanup/);
    assert.equal(host.childNodes.length, 0); cleanup.dispose();
  });

  it('the app widget shares emit bindings and view ownership through update and unmount', () => {
    const { host } = nativeFacade(), emitted = [];
    const widget = createDialogWidget();
    assert.throws(() => widget.mount(host, props, () => {}), { code: 'JA2022' });
    const handle = widget.mount(host, { ...props, close: 'close' }, binding => emitted.push(binding));
    widget.update(handle, { ...props, close: { action: 'finish', with: 7 } });
    fire(host.childNodes[0].childNodes[2], 'click', {});
    assert.deepEqual(emitted, [{ action: 'finish', with: 7 }]);
    assert.throws(() => widget.update(handle, { ...props, close: false }), { code: 'JA2022' });
    widget.unmount(handle); widget.unmount(handle); assert.equal(host.childNodes.length, 0);
  });
});
