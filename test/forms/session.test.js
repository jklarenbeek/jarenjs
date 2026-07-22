//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  buildFormModel,
  buildFormViewModel,
  compileFormRules,
} from '@jarenjs/forms';

const schema = {
  type: 'object',
  title: 'Customer',
  properties: {
    name: { type: 'string', minLength: 2 },
    email: { type: 'string' },
    lines: { type: 'array', default: [], items: { type: 'number' } },
  },
  required: ['name'],
};

function tree(data, options) {
  const model = buildFormModel(schema);
  return buildFormViewModel(model, data, options);
}

function child(node, key) {
  return node.children.find((c) => c.key === key);
}

describe('the form session contract (B4)', function () {
  it('without a session the tree is byte-identical to the sessionless shape', function () {
    const plain = tree({ name: 'Jo' });
    assert.ok(!('session' in plain));
    assert.ok(!('dirty' in child(plain, 'name')));
    assert.ok(!('id' in child(plain, 'name')));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(plain)),
      JSON.parse(JSON.stringify(tree({ name: 'Jo' }))));
  });

  it('dirty is a JSON deep-compare against the session initial, per node', function () {
    const initial = { name: 'Jo', email: 'a@b.c', lines: [1, 2] };
    const root = tree({ name: 'Johanna', email: 'a@b.c', lines: [1, 2] },
      { session: { initial } });
    assert.strictEqual(child(root, 'name').dirty, true);
    assert.strictEqual(child(root, 'email').dirty, false);
    assert.strictEqual(child(root, 'lines').dirty, false);
    assert.deepStrictEqual(root.session.dirtyPaths, ['/name']);
    assert.strictEqual(root.session.dirty, true);
  });

  it('array edits mark the container and the changed element', function () {
    const initial = { name: 'Jo', lines: [1, 2] };
    const root = tree({ name: 'Jo', lines: [1, 5] }, { session: { initial } });
    const lines = child(root, 'lines');
    assert.strictEqual(lines.dirty, true, 'the container differs');
    assert.strictEqual(lines.items[0].dirty, false);
    assert.strictEqual(lines.items[1].dirty, true);
    assert.deepStrictEqual(root.session.dirtyPaths, ['/lines/1']);
  });

  it('touched pointers fold onto their nodes (array or record form)', function () {
    const rootA = tree({ name: 'Jo' },
      { session: { touched: ['/name'] } });
    assert.strictEqual(child(rootA, 'name').touched, true);
    assert.strictEqual(child(rootA, 'email').touched, false);

    const rootB = tree({ name: 'Jo' },
      { session: { touched: { '/email': true, '/name': false } } });
    assert.strictEqual(child(rootB, 'email').touched, true);
    assert.strictEqual(child(rootB, 'name').touched, false);
  });

  it('server errors stay distinct from client errors and both drive describedBy', function () {
    const root = tree({ name: 'J' }, {
      validateFields: true,
      session: {
        serverErrors: { '/email': ['Dit e-mailadres is al in gebruik.'] },
      },
    });
    const name = child(root, 'name');
    assert.ok(name.errors.length > 0, 'minLength is a client error');
    assert.deepStrictEqual(name.serverErrors, []);
    const email = child(root, 'email');
    assert.deepStrictEqual(email.errors, []);
    assert.deepStrictEqual(email.serverErrors, ['Dit e-mailadres is al in gebruik.']);
    assert.strictEqual(email.describedBy, `${email.id}-error`);
    assert.strictEqual(child(root, 'lines').describedBy, null);
    assert.strictEqual(root.session.errorCount, name.errors.length);
    assert.strictEqual(root.session.serverErrorCount, 1);
  });

  it('accepts the array form of serverErrors', function () {
    const root = tree({ name: 'Jo' }, {
      session: {
        serverErrors: [
          { pointer: '/email', message: 'eerste' },
          { pointer: '/email', message: 'tweede' },
        ],
      },
    });
    assert.deepStrictEqual(child(root, 'email').serverErrors, ['eerste', 'tweede']);
  });

  it('ids are stable, prefixed and unique per pointer', function () {
    const root = tree({ name: 'Jo', lines: [1] },
      { session: { idPrefix: 'customer' } });
    assert.strictEqual(root.id, 'customer--root');
    assert.strictEqual(child(root, 'name').id, 'customer--f-name');
    assert.strictEqual(child(root, 'lines').items[0].id, 'customer--f-lines-0');
    const again = tree({ name: 'Jo', lines: [1] },
      { session: { idPrefix: 'customer' } });
    assert.strictEqual(child(again, 'name').id, 'customer--f-name', 'stable across builds');
  });

  it('echoes submit identity in the root summary', function () {
    const root = tree({ name: 'Jo' }, {
      session: { submitted: true, submitStatus: 'pending', requestId: 'req-7' },
    });
    assert.strictEqual(root.session.submitted, true);
    assert.strictEqual(root.session.submitStatus, 'pending');
    assert.strictEqual(root.session.requestId, 'req-7');
  });

  it('a removed array tail is dirty in the root summary', function () {
    const initial = { name: 'Jo', lines: [1, 2] };
    const root = tree({ name: 'Jo', lines: [1] }, { session: { initial } });
    assert.strictEqual(child(root, 'lines').dirty, true);
    assert.deepStrictEqual(root.session.dirtyPaths, ['/lines/1'],
      'the removed slot contributes its pointer even though it is not rendered');
    assert.strictEqual(root.session.dirty, true);
  });

  it('a hidden-only change still dirties the root summary', function () {
    const hiddenSchema = {
      type: 'object',
      properties: {
        company: { type: 'boolean' },
        vatId: { type: 'string', 'x-form': { visible: { $eq: ['$.company', true] } } },
      },
    };
    const model = buildFormModel(hiddenSchema);
    const rules = compileFormRules(model);
    const initial = { company: false, vatId: 'NL01' };
    const root = buildFormViewModel(model, { company: false, vatId: 'NL02' },
      { rules, session: { initial } });
    assert.strictEqual(root.children.some((c) => c.key === 'vatId'), false,
      'the field is excluded from the render tree');
    assert.deepStrictEqual(root.session.dirtyPaths, ['/vatId'],
      'the retained hidden value still guards navigation');
    assert.strictEqual(root.session.dirty, true);
  });

  it('missing versus explicit null is a membership change', function () {
    const withNull = tree({ name: 'Jo', email: null },
      { session: { initial: { name: 'Jo' } } });
    assert.strictEqual(child(withNull, 'email').dirty, true);
    assert.deepStrictEqual(withNull.session.dirtyPaths, ['/email']);

    const removed = tree({ name: 'Jo' },
      { session: { initial: { name: 'Jo', email: null } } });
    assert.strictEqual(child(removed, 'email').dirty, true);
    assert.deepStrictEqual(removed.session.dirtyPaths, ['/email']);

    const same = tree({ name: 'Jo', email: null },
      { session: { initial: { name: 'Jo', email: null } } });
    assert.strictEqual(child(same, 'email').dirty, false);
    assert.deepStrictEqual(same.session.dirtyPaths, []);
  });

  it('ids are injective: separator lookalikes cannot collide', function () {
    const idSchema = {
      type: 'object',
      properties: {
        'a-b': { type: 'string' },
        'a_b': { type: 'string' },
        'a/b': { type: 'string' },
        'a': {
          type: 'object',
          properties: { b: { type: 'string' } },
        },
        'ä': { type: 'string' },
        '': { type: 'string' },
      },
    };
    const model = buildFormModel(idSchema);
    const root = buildFormViewModel(model, {}, { session: {} });
    const ids = [];
    (function walk(node) {
      ids.push(node.id);
      for (const c of node.children ?? []) walk(c);
      for (const c of node.items ?? []) walk(c);
    })(root);
    assert.strictEqual(new Set(ids).size, ids.length,
      `every id is unique: ${ids.join(', ')}`);
    const byKey = (key) => root.children.find((c) => c.key === key);
    assert.strictEqual(byKey('a-b').id, 'form--f-a_45_b');
    assert.strictEqual(byKey('a').children[0].id, 'form--f-a-b');
  });

  it('the whole session tree stays plain JSON', function () {
    const root = tree({ name: 'Johanna', lines: [1] }, {
      validateFields: true,
      session: {
        initial: { name: 'Jo', lines: [1] },
        touched: ['/name'],
        serverErrors: { '/name': 'server zegt nee' },
        submitted: true,
        submitStatus: 'error',
        requestId: 3,
      },
    });
    // addValue: undefined members drop in serialization by the existing
    // contract; the session additions themselves must all be plain JSON
    const once = JSON.parse(JSON.stringify(root));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(once)), once);
    assert.deepStrictEqual(once.session, root.session);
    assert.strictEqual(once.children[0].dirty, true);
  });
});
