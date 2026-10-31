//@ts-check
/**
 * What a cleared form control writes, and the options `createFormActions`
 * reads. By default a cleared text or number control removes its member:
 * an empty control means absent, so `required` reports the member
 * missing. A host whose readers take the member as text (`data.dir.trim()`)
 * or as a nullable number had no way to keep it: `{ cleared: 'empty' }`
 * was accepted and ignored, as was any misspelt option, so the host got
 * the removal without a word and its reader met `undefined`.
 * `cleared: 'empty'` writes `''` from a cleared text control and `null`
 * from a cleared number control; an unknown option, a `cleared` other
 * than `'remove'` or `'empty'`, and options that are not an object are
 * refused with a `TypeError` naming them. Every option a caller passed
 * before answers as it did.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';

import { createApp, createFormView, createFormActions, formEventFields } from '@jarenjs/app';
import { buildFormModel, buildFormViewModel } from '@jarenjs/forms';
import { createStubHost, fire } from '../view/dom.stub.js';

/** The controls a host clears, over a headless app: text `/dir`, number `/age`, array element `/tags/0`.
 * @param {any} [options] - `createFormActions` options beside the data pointer */
function clearAll(options = {}) {
  /** @type {unknown[]} */
  const errors = [];
  const app = createApp({
    state: { data: { name: 'Joham', dir: '/srv/data', age: 44, tags: ['a', 'b'] } },
    view: [{ match: '$', body: ['main', {}] }],
    actions: createFormActions({ dataPointer: '/data', ...options }),
  }, { schedule: (/** @type {() => void} */ f) => f(), onError: (/** @type {unknown} */ e) => errors.push(e) });
  app.dispatch('form/input', { pointer: '/dir' }, { type: 'input', target: { value: '' } });
  app.dispatch('form/number', { pointer: '/age' }, { type: 'input', target: { value: '' } });
  app.dispatch('form/input', { pointer: '/tags/0', element: true }, { type: 'input', target: { value: '' } });
  return { data: app.getState().data, errors };
}

/** @param {() => unknown} run @param {RegExp} message */
function refuses(run, message) {
  assert.throws(run, (/** @type {any} */ err) => {
    assert.equal(err instanceof TypeError, true, `a TypeError, got ${err?.name}: ${err?.message}`);
    assert.match(err.message, message);
    return true;
  });
}

/** The data pointer an actions document writes under. @param {Record<string, any>} actions */
const pointerOf = (actions) => actions['form/input'].patch[0].path.$concat[0];

describe('createFormActions — what a cleared control writes', function () {
  it("'empty' keeps a cleared text member as '' and a cleared number member as null", function () {
    const { data, errors } = clearAll({ cleared: 'empty' });
    assert.deepEqual(data, { name: 'Joham', dir: '', age: null, tags: ['', 'b'] });
    assert.deepEqual(errors, []);
    assert.equal(data.dir.trim(), '', 'a reader that takes the member as text reads it');
  });

  it('the default removes both members, and an array element keeps its slot', function () {
    for (const options of [{}, { cleared: 'remove' }, { cleared: undefined }, { cleared: null }]) {
      const { data, errors } = clearAll(options);
      assert.deepEqual(data, { name: 'Joham', tags: ['', 'b'] }, JSON.stringify(options));
      assert.deepEqual(errors, []);
    }
  });

  it("'empty' drops only the op that settles a cleared text or number write", function () {
    const shapes = [{}, { dataPointer: '/calc/fin', actions: { input: 'calc-form/input', number: 'calc-form/number' } }];
    for (const shape of shapes) {
      const removing = createFormActions(shape);
      assert.deepEqual(createFormActions({ ...shape, cleared: 'remove' }), removing);
      const expected = structuredClone(removing);
      const input = shape.actions?.input ?? 'form/input';
      const number = shape.actions?.number ?? 'form/number';
      assert.deepEqual(expected[input].patch[1].op, { $if: [{ $or: ['$event.value', '$payload.element'] }, 'test', 'remove'] });
      assert.deepEqual(expected[number].$return.patch[1].op, { $if: [{ $or: ['$event.value', '$payload.element'] }, 'test', 'remove'] });
      expected[input].patch.splice(1);
      expected[number].$return.patch.splice(1);
      assert.deepEqual(createFormActions({ ...shape, cleared: 'empty' }), expected, JSON.stringify(shape));
    }
  });

  it("'empty' still reads the text a number input hands over, and writes a value typed into an absent member", function () {
    const app = createApp({
      state: { data: {} },
      view: [{ match: '$', body: ['main', {}] }],
      actions: createFormActions({ cleared: 'empty' }),
    }, { schedule: (/** @type {() => void} */ f) => f() });
    app.dispatch('form/number', { pointer: '/age' }, { type: 'input', target: { value: '-.5' } });
    assert.deepEqual(app.getState().data, { age: -0.5 });
    app.dispatch('form/input', { pointer: '/dir' }, { type: 'input', target: { value: '' } });
    assert.deepEqual(app.getState().data, { age: -0.5, dir: '' }, 'a cleared absent member is created empty, as a typed one is');
  });

  it("'empty' is read from any options object, as every other member is", function () {
    for (const options of [vm.runInNewContext('({ cleared: "empty" })'), Object.create({ cleared: 'empty' })]) {
      assert.equal(createFormActions(options)['form/input'].patch.length, 1);
    }
  });
});

describe('the standard form controls under both modes', function () {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer' },
      newsletter: { type: 'boolean' },
      level: { enum: [1, 2, null] },
      meta: {},
      tags: { type: 'array', items: { type: 'string' } },
    },
  };
  /** @param {'remove' | 'empty' | undefined} cleared */
  function mount(cleared) {
    const model = buildFormModel(schema);
    const { document, container } = createStubHost();
    const app = createApp({
      state: { data: { name: 'Ada', age: 36, newsletter: true, level: 2, meta: { a: 1 }, tags: ['x', 'y'] } },
      view: [...createFormView(), { match: '$', body: ['main', {}, { $apply: '$.form' }] }],
      actions: createFormActions({ dataPointer: '/data', cleared }),
    }, {
      node: container,
      document,
      schedule: (/** @type {() => void} */ f) => f(),
      eventFields: { ...formEventFields() },
      viewModel: (/** @type {any} */ state) => ({ form: buildFormViewModel(model, state.data) }),
    });
    /** @param {any} node @param {(n: any) => boolean} pred @returns {any} */
    const find = (node, pred) => {
      if (pred(node)) return node;
      for (const child of node.childNodes ?? []) {
        const hit = find(child, pred);
        if (hit !== undefined) return hit;
      }
      return undefined;
    };
    /** @param {string} pointer @param {string} tag */
    const control = (pointer, tag) => find(find(container, (n) => n.attributes?.get('data-pointer') === pointer), (n) => n.tagName === tag);
    fire(control('/name', 'input'), 'input', { target: { value: '' } });
    fire(control('/age', 'input'), 'input', { target: { value: '' } });
    fire(control('/newsletter', 'input'), 'change', { target: { checked: false } });
    fire(control('/level', 'select'), 'change', { target: { value: '' } });
    fire(control('/meta', 'textarea'), 'change', { target: { value: '' } });
    fire(control('/tags/0', 'input'), 'input', { target: { value: '' } });
    return app.getState().data;
  }

  it("under 'empty' every cleared control keeps its member", function () {
    assert.deepEqual(mount('empty'), { name: '', age: null, newsletter: false, level: null, meta: null, tags: ['', 'y'] });
  });

  it('by default only the text and number members go; the checkbox, select, json editor and element write as before', function () {
    for (const cleared of [undefined, /** @type {const} */ ('remove')]) {
      assert.deepEqual(mount(cleared), { newsletter: false, level: null, meta: null, tags: ['', 'y'] }, String(cleared));
    }
  });
});

describe('createFormActions — a checked option set', function () {
  it('refuses a cleared mode other than the two, naming the value', function () {
    refuses(() => createFormActions({ cleared: /** @type {any} */ ('empty ') }),
      /^createFormActions: options\.cleared must be 'remove' or 'empty', got "empty "$/);
    refuses(() => createFormActions({ cleared: /** @type {any} */ ('Empty') }), /got "Empty"$/);
    refuses(() => createFormActions({ cleared: /** @type {any} */ (false) }), /options\.cleared must be 'remove' or 'empty', got false$/);
    refuses(() => createFormActions({ cleared: /** @type {any} */ (true) }), /got true$/);
    refuses(() => createFormActions({ cleared: /** @type {any} */ (['empty']) }), /got an array$/);
  });

  it('refuses an unknown option, naming the one it meant', function () {
    refuses(() => createFormActions(/** @type {any} */ ({ dataPointer: '/data', clearedd: 'empty' })),
      /^createFormActions: unknown option 'clearedd' — did you mean 'cleared'\?$/);
    refuses(() => createFormActions(/** @type {any} */ ({ datapointer: '/calc' })), /unknown option 'datapointer' — did you mean 'dataPointer'\?$/);
    refuses(() => createFormActions(/** @type {any} */ ({ onEmpty: 'keep' })),
      /^createFormActions: unknown option 'onEmpty'; the options are root, classPrefix, actions, addLabel, removeLabel, requiredMarker, labels, dataPointer, cleared$/);
  });

  it('refuses options that are not an object, which read as no options or crashed', function () {
    for (const [value, given] of /** @type {[unknown, string][]} */ ([
      [null, 'null'], ['/calc/fin', '"/calc/fin"'], [5, '5'], [['/data'], 'an array'], [() => ({}), 'a function'],
    ])) {
      refuses(() => createFormActions(/** @type {any} */ (value)), new RegExp(`^createFormActions: options must be an object, got ${given.replace(/[/]/g, '\\/')}$`));
    }
  });

  it('accepts every option it documents, so one object serves both factories, and reads them as before', function () {
    const shared = {
      root: '$.form', classPrefix: 'acme-form', addLabel: 'Add', removeLabel: 'Remove', requiredMarker: '!',
      labels: { addItem: 'Add item' }, dataPointer: '/profile', actions: { input: 'profile/input' },
    };
    assert.ok(Array.isArray(createFormView(shared)));
    assert.deepEqual(createFormActions(shared), createFormActions({ dataPointer: '/profile', actions: { input: 'profile/input' } }));
    assert.equal(pointerOf(createFormActions()), '/data');
    assert.equal(pointerOf(createFormActions(undefined)), '/data');
    assert.equal(pointerOf(createFormActions({ dataPointer: undefined, actions: undefined, cleared: undefined })), '/data');
    const calc = createFormActions({ dataPointer: '/calc/fin', actions: { input: 'calc-form/input', check: 'calc-form/check' } });
    assert.deepEqual(Object.keys(calc), ['calc-form/input', 'calc-form/check', 'form/number', 'form/json', 'form/add', 'form/remove']);
    assert.equal(calc['calc-form/input'].patch[0].path.$concat[0], '/calc/fin');
  });

  it('reads an options object that is not a literal as before: its own and inherited members', function () {
    class FormOptions { constructor() { this.dataPointer = '/instance'; } }
    const cases = [
      [Object.create({ dataPointer: '/inherited' }), '/inherited'],
      [new FormOptions(), '/instance'],
      [vm.runInNewContext('({ dataPointer: "/realm", cleared: "empty" })'), '/realm'],
      [Object.assign(Object.create(null), { dataPointer: '/bare' }), '/bare'],
    ];
    for (const [options, pointer] of cases) assert.equal(pointerOf(createFormActions(options)), pointer);
  });
});
