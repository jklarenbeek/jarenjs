//@ts-check
/**
 * @file Closure probes for the renderer lifecycle and form-session
 * authority edges: poison recovery must be independent of vnode
 * reference identity (structural sharing/memoization must not leave a
 * poisoned widget inert), a `destroy()` requested inside a widget hook
 * stops the active pass before later siblings update, root and member
 * form ids are disjoint, the dirty diff treats hostile-but-legal JSON
 * member names as own keys, and a root-level visibility rule is
 * rejected rather than silently voiding the session summary.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDomRenderer } from '@jarenjs/view';
import {
  buildFormModel,
  buildFormViewModel,
  compileFormRules,
} from '@jarenjs/forms';
import { createStubHost, serialize } from '../view/dom.stub.js';

const widget = (key, props) => [
  'jaren-widget', { name: 'probe', key, props },
];

describe('VIEW-FORMAT §7.3 closure', function () {
  it('replaces a poisoned widget even when its vnode reference is reused', function () {
    const { document, container } = createStubHost();
    const log = [];
    const render = createDomRenderer(container, {
      document,
      widgets: {
        probe: {
          mount(node, props) {
            log.push(['mount', props.n]);
            return { n: props.n };
          },
          update(handle, props) {
            log.push(['update', props.n]);
            if (props.n === 1) throw new Error('update boom');
            handle.n = props.n;
          },
          unmount(handle) {
            log.push(['unmount', handle.n]);
          },
        },
      },
    });

    render(['div', { id: 'initial' }, widget('a', { n: 0 })]);
    const failedChild = widget('a', { n: 1 });
    assert.throws(
      () => render(['div', { id: 'failed' }, failedChild]),
      /update boom/,
    );

    // A new parent with an EXACT reference to the failed child models
    // JSLT memo/structural sharing after an unrelated state change.
    render(['div', { id: 'retry' }, failedChild]);

    assert.deepStrictEqual(log, [
      ['mount', 0],
      ['update', 1],
      ['unmount', 0],
      ['mount', 1],
    ]);
    render.destroy();
  });

  it('stops sibling updates when destroy is requested inside update', function () {
    const { document, container } = createStubHost();
    const log = [];
    let render;
    render = createDomRenderer(container, {
      document,
      widgets: {
        probe: {
          mount(node, props) {
            return { id: props.id };
          },
          update(handle, props) {
            log.push(['update', props.id]);
            if (props.id === 'a') render.destroy();
          },
          unmount(handle) {
            log.push(['unmount', handle.id]);
          },
        },
      },
    });
    const tree = (n) => ['div', {},
      widget('a', { id: 'a', n }),
      widget('b', { id: 'b', n }),
    ];

    render(tree(0));
    render(tree(1));

    assert.deepStrictEqual(log, [
      ['update', 'a'],
      ['unmount', 'a'],
      ['unmount', 'b'],
    ]);
    assert.strictEqual(serialize(container), '<div></div>');
    render(tree(2));
    assert.strictEqual(log.filter(([op]) => op === 'update').length, 1);
  });
});

describe('form session authority and id closure', function () {
  it('keeps the root id disjoint from the /root field id', function () {
    const model = buildFormModel({
      type: 'object',
      properties: { root: { type: 'string' } },
    });
    const tree = buildFormViewModel(model, { root: 'x' }, { session: {} });
    assert.notStrictEqual(tree.id, tree.children[0].id);
  });

  it('diffs hostile-but-legal JSON member names as own keys', function () {
    for (const key of ['constructor', 'toString', '__proto__']) {
      const model = buildFormModel({
        type: 'object',
        properties: { [key]: { type: ['string', 'null'] } },
      });
      const current = JSON.parse(`{"${key}":null}`);
      const tree = buildFormViewModel(model, current, {
        session: { initial: {} },
      });
      assert.strictEqual(tree.children[0].dirty, true, key);
      assert.strictEqual(tree.session.dirty, true, key);
      assert.deepStrictEqual(tree.session.dirtyPaths, [`/${key}`], key);
    }
  });

  it('rejects root visibility or preserves an authoritative summary', function () {
    const model = buildFormModel({
      type: 'object',
      'x-form': { visible: false },
      properties: { value: { type: 'string' } },
    });
    let tree;
    let rejected = false;
    try {
      // the chosen contract rejects at rule-compile time: a rule that
      // can hide the whole form (nulling the tree AND the summary) is
      // a modeling error — whole-form visibility is the host's job
      const rules = compileFormRules(model);
      tree = buildFormViewModel(model, { value: 'new' }, {
        rules,
        session: { initial: { value: 'old' } },
      });
    }
    catch (error) {
      rejected = error instanceof TypeError;
    }
    assert.ok(
      rejected || (tree !== null && tree.session?.dirty === true),
      'root visibility must be rejected or retain a dirty session envelope',
    );
  });
});
