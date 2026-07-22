//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  buildFormModel,
  buildFormViewModel,
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
    assert.strictEqual(child(root, 'name').id, 'customer--name');
    assert.strictEqual(child(root, 'lines').items[0].id, 'customer--lines-0');
    const again = tree({ name: 'Jo', lines: [1] },
      { session: { idPrefix: 'customer' } });
    assert.strictEqual(child(again, 'name').id, 'customer--name', 'stable across builds');
  });

  it('echoes submit identity in the root summary', function () {
    const root = tree({ name: 'Jo' }, {
      session: { submitted: true, submitStatus: 'pending', requestId: 'req-7' },
    });
    assert.strictEqual(root.session.submitted, true);
    assert.strictEqual(root.session.submitStatus, 'pending');
    assert.strictEqual(root.session.requestId, 'req-7');
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
