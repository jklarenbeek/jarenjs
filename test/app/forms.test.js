//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp, createFormView, createFormActions } from '@jarenjs/app';
import { renderToString } from '@jarenjs/view';
import {
  buildFormModel,
  compileFormRules,
  createInitialData,
  buildFormViewModel,
} from '@jarenjs/forms';
import { createStubHost, fire } from '../view/dom.stub.js';

const schema = {
  type: 'object',
  title: 'Profile',
  properties: {
    name: { type: 'string', minLength: 2 },
    age: { type: 'integer', minimum: 13 },
    newsletter: { type: 'boolean' },
    plan: { enum: ['free', 'pro'] },
    company: { type: 'string' },
    vatId: {
      type: 'string',
      'x-form': { visible: { $ne: ['$.company', ''] } },
    },
    tags: { type: 'array', default: [], items: { type: 'string' } },
  },
  required: ['name'],
};

/** Depth-first search through the stub tree. */
function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.childNodes ?? []) {
    const hit = find(c, pred);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function fieldControl(container, pointer, tag = 'input') {
  const wrapper = find(container, (n) => n.attributes?.get('data-pointer') === pointer);
  return wrapper === undefined ? undefined : find(wrapper, (n) => n.tagName === tag);
}

/** A complete form app over the stub DOM: the whole suite in one loop. */
function mountForm(options = {}) {
  const model = buildFormModel(schema);
  const rules = compileFormRules(model);
  const appDoc = {
    state: { data: createInitialData(model) },
    view: [
      ...createFormView(),
      { match: '$', body: ['main', {}, { $apply: '$.form' }] },
    ],
    actions: createFormActions({ dataPointer: '/data' }),
  };
  const { document, container } = createStubHost();
  const app = createApp(appDoc, {
    node: container,
    document,
    schedule: (f) => f(),
    viewModel: (state) => ({
      form: buildFormViewModel(model, state.data, {
        rules,
        validateFields: options.validateFields === true,
      }),
    }),
  });
  return { app, container, model, rules };
}

describe('the standard forms stylesheet', function () {
  it('renders every control family from the schema alone', function () {
    const { container } = mountForm();
    assert.strictEqual(fieldControl(container, '/name').attributes.get('type'), 'text');
    assert.strictEqual(fieldControl(container, '/age').attributes.get('type'), 'number');
    assert.strictEqual(fieldControl(container, '/newsletter').attributes.get('type'), 'checkbox');
    assert.notStrictEqual(fieldControl(container, '/plan', 'select'), undefined);
    const options = fieldControl(container, '/plan', 'select').childNodes;
    assert.strictEqual(options.length, 2);
    assert.strictEqual(options[0].childNodes[0].nodeValue, 'free');
  });

  it('typing writes through the standard input action', function () {
    const { app, container } = mountForm();
    fire(fieldControl(container, '/name'), 'input', { target: { value: 'Joham' } });
    assert.strictEqual(app.getState().data.name, 'Joham');
    assert.strictEqual(fieldControl(container, '/name').attributes.get('value') ?? 'Joham', 'Joham');
  });

  it('number inputs coerce, clearing writes null', function () {
    const { app, container } = mountForm();
    fire(fieldControl(container, '/age'), 'input', { target: { value: '44' } });
    assert.strictEqual(app.getState().data.age, 44);
    fire(fieldControl(container, '/age'), 'input', { target: { value: '' } });
    assert.strictEqual(app.getState().data.age, null);
  });

  it('checkboxes write through the check action', function () {
    const { app, container } = mountForm();
    fire(fieldControl(container, '/newsletter'), 'change', { target: { checked: true } });
    assert.strictEqual(app.getState().data.newsletter, true);
  });

  it('selects write the chosen value', function () {
    const { app, container } = mountForm();
    fire(fieldControl(container, '/plan', 'select'), 'change', { target: { value: 'pro' } });
    assert.strictEqual(app.getState().data.plan, 'pro');
  });

  it('x-form visibility reacts per keystroke', function () {
    const { container } = mountForm();
    assert.strictEqual(fieldControl(container, '/vatId'), undefined, 'hidden while no company');
    fire(fieldControl(container, '/company'), 'input', { target: { value: 'ACME' } });
    assert.notStrictEqual(fieldControl(container, '/vatId'), undefined, 'appears with a company');
  });

  it('array add and remove buttons drive the data', function () {
    const { app, container } = mountForm();
    const arrayFieldset = find(container, (n) => n.attributes?.get('class') === 'jaren-form-array');
    const addButton = find(arrayFieldset, (n) => n.attributes?.get('class') === 'jaren-form-add');
    fire(addButton, 'click');
    fire(addButton, 'click');
    assert.deepStrictEqual(app.getState().data.tags, ['', '']);

    fire(fieldControl(container, '/tags/1'), 'input', { target: { value: 'json' } });
    assert.deepStrictEqual(app.getState().data.tags, ['', 'json']);

    const item0 = find(container, (n) => n.attributes?.get('data-pointer') === '/tags/0');
    const removeButton = find(item0, (n) => n.attributes?.get('class') === 'jaren-form-remove');
    fire(removeButton, 'click');
    assert.deepStrictEqual(app.getState().data.tags, ['json']);
  });

  it('renders field errors when the view model validates', function () {
    const { container } = mountForm({ validateFields: true });
    fire(fieldControl(container, '/name'), 'input', { target: { value: 'J' } });
    const wrapper = find(container, (n) => n.attributes?.get('data-pointer') === '/name');
    const error = find(wrapper, (n) => n.attributes?.get('class') === 'jaren-form-error');
    assert.notStrictEqual(error, undefined);

    fire(fieldControl(container, '/name'), 'input', { target: { value: 'Jo' } });
    const gone = find(
      find(container, (n) => n.attributes?.get('data-pointer') === '/name'),
      (n) => n.attributes?.get('class') === 'jaren-form-error');
    assert.strictEqual(gone, undefined);
  });

  it('the same document server-renders through renderToString', function () {
    const model = buildFormModel(schema);
    const html = renderToString(
      createApp({
        state: { data: { name: 'Jo', tags: ['a'] } },
        view: [
          ...createFormView(),
          { match: '$', body: ['main', {}, { $apply: '$.form' }] },
        ],
      }, {
        schedule: (f) => f(),
        viewModel: (state) => ({ form: buildFormViewModel(model, state.data) }),
      }).getVnode());
    assert.match(html, /<section class="jaren-form">/);
    assert.match(html, /<h3 class="jaren-form-title">Profile<\/h3>/);
    assert.match(html, /value="Jo"/);
    assert.match(html, /data-pointer="\/tags\/0"/);
  });
});
