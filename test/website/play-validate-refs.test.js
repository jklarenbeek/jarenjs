//@ts-check
/**
 * @file The play `validate` engine's referenced schemas through every path
 * that compiles the main schema on the site: the run, the generated form and
 * the view model that feeds it share ONE compile, register the same
 * documents, and report a bad document as a schema error — never a throw.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { EXAMPLES } from '@jarenjs/play';
import { runValidation, formViewFor, referencedSchemas } from '../../packages/website/src/boundaries/validator.js';
import { PLAY_START, loadExample, runPlay } from '../../packages/website/src/boundaries/play.js';
import { viewModel } from '../../packages/website/src/app/viewmodel.js';

const ex = EXAMPLES.find((e) => e.id === 'validate-ref-by-id');
const schemaText = ex.source.schema;
const schemas = JSON.parse(ex.source.schemas);
const data = JSON.parse(ex.datasets[0].data.data);

/** Count the compiles `body` causes (every path compiles through JarenValidator). */
function compiles(body) {
  const original = JarenValidator.prototype.compile;
  let count = 0;
  JarenValidator.prototype.compile = function counted(...args) { count++; return original.apply(this, args); };
  try { body(); } finally { JarenValidator.prototype.compile = original; }
  return count;
}

/** The least app state the view model reads on the play page. */
const stateWith = (play) => ({ route: { page: 'play', params: {} }, navOpen: false, readme: { open: false }, site: { data: {} }, play });

/** The field labels of a form render tree, in document order. */
const labels = (tree) => (JSON.stringify(tree).match(/"label":"[^"]*"/g) ?? []).map((m) => JSON.parse(`{${m}}`).label);

describe('play validate: referenced schemas on the site', () => {
  it('the generated form and the run share one compile, and the form shows the referenced fields', () => {
    // a schema text no earlier test compiled, so the first call is cold
    const text = schemaText.replace('"Order"', '"Order form"');
    const n = compiles(() => {
      assert.strictEqual(runValidation(text, data, schemas).valid, true);
      const form = formViewFor(text, data, schemas);
      assert.ok(form !== null);
      assert.deepStrictEqual(labels(form), ['Order form', 'Address', 'Street', 'City', 'Address', 'Street', 'City'],
        'billing and shipping each carry the Address document\'s fields');
      assert.strictEqual(runValidation(text, data, schemas).valid, true);
      formViewFor(text, data, schemas);
    });
    // main schema + one eager check per referenced document, once
    assert.strictEqual(n, 1 + schemas.length, 'nothing recompiled after the first call');
  });

  it('a changed referenced list is a new compile; the same list is not', () => {
    const text = schemaText.replace('"Order"', '"Order again"');
    const edited = [{ ...schemas[0], title: 'Edited address' }];
    const n = compiles(() => {
      runValidation(text, data, schemas); runValidation(text, data, schemas);
      runValidation(text, data, edited); runValidation(text, data, edited);
    });
    assert.strictEqual(n, 2 * (1 + schemas.length));
  });

  it('the view model hands the session\'s referenced-schemas pane to the form', () => {
    const loaded = loadExample('validate-ref-by-id');
    const play = { ...PLAY_START, ...loaded, dataView: 'form', dataValue: data };
    const ui = viewModel(stateWith(play)).ui;
    assert.deepStrictEqual(labels(ui.play.dataForm), ['Order', 'Address', 'Street', 'City', 'Address', 'Street', 'City']);
    // an unreadable pane is the run's error to report; the form falls back to none
    const broken = viewModel(stateWith({ ...play, source: { ...play.source, schemas: '[' } })).ui;
    assert.deepStrictEqual(labels(broken.play.dataForm), ['Order', 'Billing', 'Shipping'], 'no list: the references stay unresolved');
  });

  it('the form reads the pane leniently: only objects with a non-empty string $id, else none', () => {
    assert.deepStrictEqual(referencedSchemas('[{"$id":"a"},3,null,[],{"x":1},{"$id":""},{"$id":7},{"$id":"b","type":"string"}]'),
      [{ $id: 'a' }, { $id: 'b', type: 'string' }]);
    for (const pane of [undefined, '', '  ', '[', '{}', '"a"', 'null']) assert.deepStrictEqual(referencedSchemas(pane), [], String(pane));
  });

  it('a referenced document that cannot compile is a schema error naming the pane, not a throw', () => {
    const main = '{"$ref":"https://example.com/a.json"}';
    const bad = { $id: 'https://example.com/a.json', type: 'nonsense' };
    const reported = runValidation(main, {}, [bad]);
    assert.strictEqual(reported.valid, null);
    assert.match(reported.schemaError, /^schemas\[0\] \(https:\/\/example\.com\/a\.json\): .*'nonsense'/);
    assert.strictEqual(reported.schemaPane, 'schemas');
    // reported even when nothing references it
    assert.match(runValidation('{"type":"object"}', {}, [bad]).schemaError, /^schemas\[0\]/);
    // a document whose own reference does not resolve is reported the same way
    const dangling = { $id: 'https://example.com/b.json', properties: { x: { $ref: 'https://example.com/missing.json' } } };
    const lazy = runValidation('{"$ref":"https://example.com/b.json"}', { x: 1 }, [dangling]);
    assert.strictEqual(lazy.valid, null);
    assert.match(lazy.schemaError, /^schemas\[0\] \(https:\/\/example\.com\/b\.json\): Can not resolve schema/);

    // through the engine: SCHEMA, located at the schemas pane
    const slice = { engine: 'validate', source: { schema: main, schemas: JSON.stringify([bad]) }, data: { data: '{}' }, config: {} };
    const result = runPlay(slice);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'SCHEMA');
    assert.strictEqual(result.error.pane, 'schemas');
  });
});
