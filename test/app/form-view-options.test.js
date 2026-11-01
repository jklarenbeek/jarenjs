//@ts-check
/**
 * The options `createFormView` reads are checked as `createFormActions`
 * checks them, against the one set of members both factories document.
 * A misspelt member was dropped in silence (`createFormView({
 * clasPrefix: 'acme' })` rendered `class="jaren-form"`), a string, a
 * number, an array or a function was read as no options (a root passed
 * bare rendered the form under `$.form`), and `null` crashed with an
 * uncoded TypeError. Each is now refused with a TypeError naming it;
 * every member either factory documents is accepted, so one object
 * serves both, and `cleared`, which only the actions read, is left to
 * them.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';

import { createFormView, createFormActions } from '@jarenjs/app';

/** @param {() => unknown} run @param {RegExp} message */
function refuses(run, message) {
  assert.throws(run, (/** @type {any} */ err) => {
    assert.equal(err instanceof TypeError, true, `a TypeError, got ${err?.name}: ${err?.message}`);
    assert.match(err.message, message);
    return true;
  });
}

/** The class prefix a rule set renders its form section with. @param {any[]} rules */
const prefixOf = (rules) => rules[0].body[1].class;

describe('createFormView — a checked option set', function () {
  it('refuses an unknown option, naming the one it meant', function () {
    refuses(() => createFormView(/** @type {any} */ ({ clasPrefix: 'acme' })),
      /^createFormView: unknown option 'clasPrefix' — did you mean 'classPrefix'\?$/);
    refuses(() => createFormView(/** @type {any} */ ({ root: '$.form', requiredMaker: '!' })),
      /^createFormView: unknown option 'requiredMaker' — did you mean 'requiredMarker'\?$/);
    refuses(() => createFormView(/** @type {any} */ ({ theme: 'dark' })),
      /^createFormView: unknown option 'theme'; the options are root, classPrefix, actions, addLabel, removeLabel, requiredMarker, labels, dataPointer, cleared$/);
  });

  it('refuses options that are not an object, which read as no options or crashed', function () {
    for (const [value, given] of /** @type {[unknown, string][]} */ ([
      [null, 'null'], ['$.myform', '"\\$\\.myform"'], [5, '5'], [['$.form'], 'an array'], [() => ({}), 'a function'],
    ])) {
      refuses(() => createFormView(/** @type {any} */ (value)), new RegExp(`^createFormView: options must be an object, got ${given}$`));
    }
  });

  it('accepts every member either factory documents, so one object serves both', function () {
    const view = {
      root: '$.profile', classPrefix: 'acme-form', addLabel: 'Add', removeLabel: 'Remove', requiredMarker: '!',
      labels: { addItem: 'Add item' }, actions: { input: 'profile/input' },
    };
    const shared = { ...view, dataPointer: '/profile', cleared: /** @type {const} */ ('empty') };
    assert.deepEqual(createFormView(shared), createFormView(view), 'the actions-only members change no rule');
    assert.equal(prefixOf(createFormView(shared)), 'acme-form');
    assert.equal(createFormActions(shared)['profile/input'].patch.length, 1, 'and the actions read the same object');
  });

  it("leaves 'cleared' to the actions: the view never reads it", function () {
    for (const cleared of ['remove', 'empty', 'bogus', 'Empty', false]) {
      assert.deepEqual(createFormView(/** @type {any} */ ({ cleared })), createFormView(), String(cleared));
    }
    refuses(() => createFormActions(/** @type {any} */ ({ cleared: 'bogus' })), /^createFormActions: options\.cleared must be 'remove' or 'empty', got "bogus"$/);
  });

  it("renders every caller's options as before", function () {
    // the shapes the suite passes: a root and renamed actions (the calc
    // component, the flow inspector, the site's play form), the chrome
    // labels and marker, and nothing
    const actions = { input: 'calc-form/input', check: 'calc-form/check', number: 'calc-form/number', add: 'calc-form/add', remove: 'calc-form/remove' };
    const rooted = createFormView({ root: '$.ui.calculator.financial.form', actions });
    assert.equal(rooted[0].match, '$.ui.calculator.financial.form');
    assert.match(JSON.stringify(rooted), /"action":"calc-form\/number"/);
    const labelled = createFormView({ labels: { addItem: 'Toevoegen', removeItem: 'Verwijderen' }, requiredMarker: '†' });
    assert.match(JSON.stringify(labelled), /"\$const":"Toevoegen"/);
    assert.match(JSON.stringify(labelled), /"\$const":" †"/);
    assert.deepEqual(createFormView(undefined), createFormView());
    assert.deepEqual(createFormView({}), createFormView());
    assert.deepEqual(createFormView({ root: undefined, classPrefix: undefined, actions: undefined, labels: undefined }), createFormView(),
      'a member that is undefined is absent');
    assert.equal(prefixOf(createFormView()), 'jaren-form');
  });

  it('reads an options object that is not a literal as before: its own and inherited members', function () {
    class ViewOptions { constructor() { this.classPrefix = 'instance'; } }
    const cases = [
      [Object.create({ classPrefix: 'inherited' }), 'inherited'],
      [new ViewOptions(), 'instance'],
      [vm.runInNewContext('({ classPrefix: "realm" })'), 'realm'],
      [Object.assign(Object.create(null), { classPrefix: 'bare' }), 'bare'],
    ];
    for (const [options, prefix] of cases) assert.equal(prefixOf(createFormView(options)), prefix);
  });
});
