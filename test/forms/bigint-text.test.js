//@ts-check
/**
 * @file The form view model writes a bigint, and reads it back.
 *
 * `buildFormViewModel` wrote a `json` control's text and a select option's
 * `key` with `JSON.stringify`, which refuses a bigint: a form over data
 * that holds one threw `TypeError: Do not know how to serialize a BigInt`
 * (a `json` control holding `5n` or `[5n]`, an `enum` with a bigint
 * option), where the field check judges a bigint. A bigint is now written
 * as JavaScript writes one, its digits and `n`, and `parseJsonText` and
 * `parseFieldInput` read that text back to the same value.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFormModel, buildFormViewModel, parseFieldInput, parseJsonText, validateAllFields } from '@jarenjs/forms';

describe('a bigint in the text a control shows', () => {
  it('writes a json control\'s bigint as its digits and n, at any depth', () => {
    const untyped = buildFormModel({});
    assert.equal(buildFormViewModel(untyped, 5n).json, '5n');
    assert.equal(buildFormViewModel(untyped, -(2n ** 64n)).json, '-18446744073709551616n');
    assert.equal(buildFormViewModel(untyped, [5n]).json, '[\n  5n\n]');
    assert.equal(buildFormViewModel(untyped, { a: 5n, b: [1, { c: 6n }], d: '5n' }).json,
      '{\n  "a": 5n,\n  "b": [\n    1,\n    {\n      "c": 6n\n    }\n  ],\n  "d": "5n"\n}');
    // a value JSON can carry is written as before
    assert.equal(buildFormViewModel(untyped, { a: [1, 'x', null] }).json, JSON.stringify({ a: [1, 'x', null] }, null, 2));
    assert.equal(buildFormViewModel(untyped, null).json, '');
  });

  it('tells a bigint from the text that spells one, whatever the value holds', () => {
    const untyped = buildFormModel({});
    for (const value of [
      { '#bigint#5': 5n, text: '#bigint#5', more: '"#bigint#7"' },
      ['#bigint#', '#bigint##', 9n, '9n', '#bigint#9'],
      { n: 1n, quoted: '"1n"' },
    ]) {
      const { json } = buildFormViewModel(untyped, value);
      assert.deepEqual(parseJsonText(json), value);
    }
  });

  it('still refuses a value that holds itself', () => {
    /** @type {any[]} */
    const loop = [5n];
    loop.push(loop);
    assert.throws(() => buildFormViewModel(buildFormModel({}), loop), TypeError);
  });

  it('offers a bigint option under a key of its own, selected for that value', () => {
    const model = buildFormModel({ enum: [5, 5n, 'a', null] });
    const options = (/** @type {unknown} */ value) => buildFormViewModel(model, value).options.map((option) => [option.key, option.selected]);
    assert.deepEqual(options(5n), [['5', false], ['5n', true], ['"a"', false], ['null', false]]);
    assert.deepEqual(options(5), [['5', true], ['5n', false], ['"a"', false], ['null', false]]);
    const node = buildFormViewModel(model, 5n);
    assert.equal(node.options[1].value, 5n);
    assert.equal(node.options[1].label, '5');
    assert.deepEqual(validateAllFields(model, 5n), {});
    assert.deepEqual(Object.keys(validateAllFields(model, 6n)), ['']);
  });

  it('builds the tree with a session and validation over data that holds a bigint', () => {
    const model = buildFormModel({ type: 'object', properties: { id: { type: 'bigint' }, any: {}, pick: { enum: [1n, 2n] } } });
    const tree = buildFormViewModel(model, { id: 5n, any: [5n], pick: 2n }, { validateFields: true, session: { initial: { id: 5n, any: [4n], pick: 2n } } });
    assert.deepEqual(tree.children.map((node) => [node.control, node.json ?? null, node.dirty, node.errors]), [
      ['json', '5n', false, []], ['json', '[\n  5n\n]', true, []], ['select', null, false, []]]);
    assert.deepEqual(tree.session.dirtyPaths, ['/any/0']);
  });
});

describe('the text of a control read back', () => {
  it('reads JSON, and an integer followed by n as a bigint', () => {
    /** @type {[string, unknown][]} */
    const table = [
      ['5n', 5n], ['-5n', -5n], ['0n', 0n], [' 12n\n', 12n], ['9007199254740993n', 9007199254740993n],
      ['[5n, {"a": -6n}]', [5n, { a: -6n }]], ['{"a":"5n","b":5}', { a: '5n', b: 5 }],
      ['[1, 5n, 2.5, -3n, 1e2]', [1, 5n, 2.5, -3n, 100]], ['{"a": 1, "b": 2n, "c": "3"}', { a: 1, b: 2n, c: '3' }],
      ['5', 5], ['"5n"', '5n'], ['null', null], ['true', true], ['[1, 2.5, "x"]', [1, 2.5, 'x']], ['{"n": 1e3}', { n: 1000 }],
    ];
    for (const [text, value] of table) assert.deepEqual(parseJsonText(text), value, text);
    assert.equal(typeof parseJsonText('5n'), 'bigint');
    assert.equal(typeof parseJsonText('5'), 'number');
  });

  it('keeps a string a string, however the text spells it', () => {
    // a string whose text spells, with an escape, the mark a bigint is read behind
    const escaped = `${String.fromCharCode(92)}u0023bigint#5`;
    assert.deepEqual(parseJsonText(`{"a": "${escaped}", "b": 5n}`), { a: '#bigint#5', b: 5n });
    assert.deepEqual(parseJsonText('["#bigint#5", "#bigint##6", 7n]'), ['#bigint#5', '#bigint##6', 7n]);
    assert.deepEqual(parseJsonText('{"5n": 5n, "n": "5n"}'), { '5n': 5n, n: '5n' });
  });

  it('answers undefined for text that is neither', () => {
    for (const text of ['', ' ', 'abc', '[1, 2', '12.5n', '1e3n', '00n', '01n', '5nn', '5n6', '{5n: 1}', '{"a": 5n', '- 5n', '5 n', 'n', '[5n,]', 'x5n', '"a" 5n'])
      assert.equal(parseJsonText(text), undefined, JSON.stringify(text));
    for (const value of [5, 5n, null, undefined, {}, ['5n']]) assert.equal(parseJsonText(value), undefined);
  });

  it('hands an enum option back by its text or by its key, a bigint as the bigint', () => {
    const field = buildFormModel({ enum: [5, 5n, 'a', '1', 1, null, [1]] });
    /** @type {[string, unknown][]} */
    const table = [['5', 5], ['5n', 5n], ['a', 'a'], ['"a"', 'a'], ['1', 1], ['"1"', '1'], ['null', null], ['[1]', [1]], ['nope', 'nope']];
    for (const [raw, value] of table) assert.deepEqual(parseFieldInput(field, raw), value, raw);
    // a field of bigints alone: the digits name the option; an option's text names it where no key does
    assert.equal(parseFieldInput(buildFormModel({ enum: [5n, 6n] }), '6'), 6n);
    assert.equal(parseFieldInput(buildFormModel({ enum: ['1', 'b'] }), '1'), '1');
    assert.equal(parseFieldInput(buildFormModel({ enum: [true, 'x'] }), 'x'), 'x');
    // every key the view model gives is read back to its option
    for (const option of buildFormViewModel(field, 5n).options) assert.deepEqual(parseFieldInput(field, option.key), option.value, option.key);
  });
});
