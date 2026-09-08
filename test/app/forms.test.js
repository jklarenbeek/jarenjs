//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp, createFormView, createFormActions, formEventFields } from '@jarenjs/app';
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
    level: { enum: [1, 2, null] },
    meta: {},  // no determinable type -> the structured `json` control
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
  const model = buildFormModel(options.schema ?? schema);
  const rules = compileFormRules(model);
  const appDoc = {
    state: { data: createInitialData(model) },
    view: [
      ...createFormView({ labels: options.labels }),
      { match: '$', body: ['main', {}, { $apply: '$.form' }] },
    ],
    actions: createFormActions({ dataPointer: '/data' }),
  };
  const { document, container } = createStubHost();
  const app = createApp(appDoc, {
    node: container,
    document,
    schedule: (f) => f(),
    // the select and json controls decode their JSON text here
    eventFields: { ...formEventFields() },
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

  it('ignores a format\'s preview hint: a geojson field is the textarea it always was', function () {
    // the hint is data for a host WITH a map renderer; this stylesheet
    // has none, so the member changes nothing it draws — no map, no
    // extra control, no attribute carrying the hint
    const { container } = mountForm({
      schema: {
        type: 'object',
        properties: { where: { type: 'string', format: 'geojson' } },
      },
    });
    const control = fieldControl(container, '/where', 'textarea');
    assert.notStrictEqual(control, undefined, 'the geojson control is a textarea');
    assert.strictEqual(control.attributes.get('placeholder'), '{"type":"Point","coordinates":[4.9,52.4]}');
    assert.strictEqual(find(container, (n) => n.tagName === 'svg'), undefined, 'nothing drawn');
    const wrapper = find(container, (n) => n.attributes?.get('data-pointer') === '/where');
    const controls = [];
    (function walk(n) { if (n.tagName) controls.push(n.tagName); for (const c of n.childNodes ?? []) walk(c); })(wrapper);
    assert.deepStrictEqual(controls.filter((t) => t === 'textarea' || t === 'input' || t === 'svg'), ['textarea'],
      'exactly one control, and it is the textarea');
  });

  it('typing writes through the standard input action', function () {
    const { app, container } = mountForm();
    fire(fieldControl(container, '/name'), 'input', { target: { value: 'Joham' } });
    assert.strictEqual(app.getState().data.name, 'Joham');
    assert.strictEqual(fieldControl(container, '/name').attributes.get('value') ?? 'Joham', 'Joham');
  });

  it('group enablement disables nested controls and array buttons, and clears when enabled', function () {
    const enabled = { $not: '$.locked' };
    const { app, container } = mountForm({ schema: {
      type: 'object',
      properties: {
        locked: { type: 'boolean', default: true },
        group: {
          type: 'object', 'x-form': { enabled },
          properties: { name: { type: 'string', default: 'Jo' } },
        },
        tags: { type: 'array', default: ['a'], items: { type: 'string' }, 'x-form': { enabled } },
      },
    } });
    const group = find(container, (n) => n.attributes?.get('data-pointer') === '/group');
    const tags = find(container, (n) => n.attributes?.get('data-pointer') === '/tags');
    const add = find(tags, (n) => n.attributes?.get('class') === 'jaren-form-add');
    assert.strictEqual(group.tagName, 'fieldset');
    assert.strictEqual(tags.tagName, 'fieldset');
    for (const control of [group, tags, add]) assert.strictEqual(control.attributes.has('disabled'), true);

    fire(fieldControl(container, '/locked'), 'change', { target: { checked: false } });
    for (const control of [group, tags, add]) assert.strictEqual(control.attributes.has('disabled'), false);
    assert.deepStrictEqual(app.getState().data, { locked: false, group: { name: 'Jo' }, tags: ['a'] });
    fire(fieldControl(container, '/locked'), 'change', { target: { checked: true } });
    for (const control of [group, tags, add]) assert.strictEqual(control.attributes.has('disabled'), true);
    app.destroy();
  });

  it('readOnly disables controls without a native readonly mode and preserves text readonly', function () {
    const { app, container } = mountForm({ schema: {
      type: 'object',
      properties: {
        accepted: { type: 'boolean', default: true, readOnly: true },
        plan: { enum: ['free', 'pro'], default: 'free', readOnly: true },
        name: { type: 'string', default: 'Jo', readOnly: true },
        group: { type: 'object', readOnly: true, properties: { name: { type: 'string', default: 'Jo' } } },
        tags: { type: 'array', default: ['a'], items: { type: 'string' }, readOnly: true },
        editable: { type: 'boolean', default: false },
      },
    } });
    assert.strictEqual(fieldControl(container, '/accepted').attributes.has('disabled'), true);
    assert.strictEqual(fieldControl(container, '/plan', 'select').attributes.has('disabled'), true);
    assert.strictEqual(fieldControl(container, '/name').attributes.has('readonly'), true);
    assert.strictEqual(fieldControl(container, '/name').attributes.has('disabled'), false);
    assert.strictEqual(fieldControl(container, '/editable').attributes.has('disabled'), false);
    for (const pointer of ['/group', '/tags']) {
      const group = find(container, (n) => n.attributes?.get('data-pointer') === pointer);
      assert.strictEqual(group.attributes.has('disabled'), true);
    }
    const html = renderToString(app.getVnode());
    assert.match(html, /<input type="checkbox" checked disabled>/);
    assert.match(html, /<select disabled>/);
    assert.match(html, /<fieldset class="jaren-form-array" data-pointer="\/tags" disabled>/);
    app.destroy();
  });

  it('disabled and readOnly array items cannot be removed through an enabled button', function () {
    for (const annotation of [{ readOnly: true }, { 'x-form': { enabled: false } }, {}]) {
      const { app, container } = mountForm({ schema: {
        type: 'object',
        properties: { tags: { type: 'array', default: ['a'], items: { type: 'string', ...annotation } } },
      } });
      const item = find(container, (n) => n.attributes?.get('data-pointer') === '/tags/0');
      const remove = find(item, (n) => n.attributes?.get('class') === 'jaren-form-remove');
      assert.strictEqual(remove.attributes.has('disabled'), Object.keys(annotation).length > 0);
      app.destroy();
    }
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
    // the DOM carries the option's `key` — the value as JSON text
    fire(fieldControl(container, '/plan', 'select'), 'change', { target: { value: '"pro"' } });
    assert.strictEqual(app.getState().data.plan, 'pro');
  });

  it('selects keep non-string enum values typed', function () {
    const { app, container } = mountForm();
    const select = fieldControl(container, '/level', 'select');
    assert.strictEqual(select.childNodes[1].attributes.get('value'), '2',
      'the option carries JSON text, not a display string');
    fire(select, 'change', { target: { value: '2' } });
    assert.strictEqual(app.getState().data.level, 2, 'a number enum stays a number');
    fire(select, 'change', { target: { value: 'null' } });
    assert.strictEqual(app.getState().data.level, null);
  });

  it('the json control edits a structured value as text', function () {
    const { app, container } = mountForm();
    const editor = fieldControl(container, '/meta', 'textarea');
    assert.notStrictEqual(editor, undefined, 'json fields render an editor, not a placeholder');
    fire(editor, 'change', { target: { value: '{"a":[1,2]}' } });
    assert.deepStrictEqual(app.getState().data.meta, { a: [1, 2] });
    // the rendered text is the value, indented
    assert.strictEqual(fieldControl(container, '/meta', 'textarea').childNodes[0].nodeValue,
      '{\n  "a": [\n    1,\n    2\n  ]\n}');
  });

  it('unparsable json text writes null rather than failing the dispatch', function () {
    const { app, container } = mountForm();
    fire(fieldControl(container, '/meta', 'textarea'), 'change', { target: { value: '{oops' } });
    assert.strictEqual(app.getState().data.meta, null);
  });

  it('the array buttons carry accessible names', function () {
    const { container } = mountForm();
    const addButton = find(container, (n) => n.attributes?.get('class') === 'jaren-form-add');
    assert.strictEqual(addButton.attributes.get('aria-label'), 'Add item');
    const localized = mountForm({ labels: { addItem: 'Regel toevoegen' } });
    const dutchButton = find(localized.container,
      (n) => n.attributes?.get('class') === 'jaren-form-add');
    assert.strictEqual(dutchButton.attributes.get('aria-label'), 'Regel toevoegen');
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
