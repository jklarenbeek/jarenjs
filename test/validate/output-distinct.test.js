//@ts-check
/**
 * @file The output formats that write each distinct error once
 * (`distinctBasicOutput`, `distinctDetailedOutput`, `distinctListOutput`):
 * an error with the same absolute schema location, instance location and
 * text as one written before it, raised from errors of the same keywords
 * and params, is left out, so each stands at the first path that reached
 * it; a passing document's output is the default format's.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator, compileMessageCatalog, localizeErrors } from '@jarenjs/validate';
import { nl } from '@jarenjs/locales';
import {
  basicOutput, detailedOutput, listOutput, distinctBasicOutput, distinctDetailedOutput, distinctListOutput,
} from '@jarenjs/validate/output';

const S = 'https://json-schema.org/draft/2020-12/schema';
/** @type {Record<string, [any, any]>} Each format, the default then the distinct one */
const PAIRS = { basic: [basicOutput, distinctBasicOutput], detailed: [detailedOutput, distinctDetailedOutput], list: [listOutput, distinctListOutput] };

/**
 * @param {any} format @param {any} schema @param {unknown} data @param {object} [options]
 * @returns {any}
 */
const output = (format, schema, data, options = {}) =>
  new JarenValidator(/** @type {any} */ ({ outputFormat: format, ...options })).compile(schema)(data);

/** A 2020-12 unit as [keywordLocation, instanceLocation, error]. @param {any} unit */
const row = (unit) => [unit.keywordLocation, unit.instanceLocation, unit.error];
/** A `list` unit as [evaluationPath, instanceLocation, errors]. @param {any} unit */
const listRow = (unit) => [unit.evaluationPath, unit.instanceLocation, unit.errors];
/** A `detailed` tree as nested rows. @param {any} unit @returns {any[]} */
const tree = (unit) => [...row(unit), (unit.errors ?? []).map(tree)];
/** The units of a document that carry an error. @param {any} document @returns {number} */
const carried = (document) => (document.error !== undefined ? 1 : 0) + (document.errors ?? []).reduce((/** @type {number} */ sum, /** @type {any} */ unit) => sum + carried(unit), 0);

/** Three branches of one definition enter it again on the same member. */
const nested = {
  $schema: S, $id: 'https://example.com/n', type: 'array', items: { $ref: '#/$defs/node' },
  $defs: { node: { anyOf: [{ type: 'integer' }, { type: 'array', items: { $ref: '#/$defs/node' } }, { type: 'array', items: { $ref: '#/$defs/node' }, minItems: 1 }] } },
};
/** @param {number} depth @returns {unknown} 'x' nested in `depth` arrays */
const nestedIn = (depth) => {
  /** @type {unknown} */
  let value = 'x';
  for (let i = 0; i < depth; i++) value = [value];
  return value;
};

describe('an output format that writes each distinct error once', () => {
  it('writes a kept definition\'s errors at the first path that reached them', () => {
    const at = 'https://example.com/n#/$defs/node';
    const basic = output(distinctBasicOutput, nested, [['x']]);
    assert.equal(basic.valid, false);
    assert.deepEqual(basic.errors.map(row), [
      ['/items/$ref/anyOf', '/0', 'must match a subschema in anyOf'],
      ['/items/$ref/anyOf/0/type', '/0', 'must be an integer'],
      ['/items/$ref/anyOf/1/items/$ref/anyOf', '/0/0', 'must match a subschema in anyOf'],
      ['/items/$ref/anyOf/1/items/$ref/anyOf/0/type', '/0/0', 'must be an integer'],
      ['/items/$ref/anyOf/1/items/$ref/anyOf/1/type', '/0/0', 'must be an array'],
      ['/items/$ref/anyOf/1/items/$ref/anyOf/2/type', '/0/0', 'must be an array'],
    ]);
    assert.deepEqual(basic.errors.map((/** @type {any} */ unit) => unit.absoluteKeywordLocation),
      [`${at}/anyOf`, `${at}/anyOf/0/type`, `${at}/anyOf`, `${at}/anyOf/0/type`, `${at}/anyOf/1/type`, `${at}/anyOf/2/type`]);
    // the default writes the second branch's four again, under /items/$ref/anyOf/2
    assert.equal(output(basicOutput, nested, [['x']]).errors.length, 10);
    assert.deepEqual(output(distinctListOutput, nested, [['x']]).details.map(listRow), [
      ['/items/$ref', '/0', { anyOf: 'must match a subschema in anyOf' }],
      ['/items/$ref/anyOf/0', '/0', { type: 'must be an integer' }],
      ['/items/$ref/anyOf/1/items/$ref', '/0/0', { anyOf: 'must match a subschema in anyOf' }],
      ['/items/$ref/anyOf/1/items/$ref/anyOf/0', '/0/0', { type: 'must be an integer' }],
      ['/items/$ref/anyOf/1/items/$ref/anyOf/1', '/0/0', { type: 'must be an array' }],
      ['/items/$ref/anyOf/1/items/$ref/anyOf/2', '/0/0', { type: 'must be an array' }],
    ]);
    assert.deepEqual(tree(output(distinctDetailedOutput, nested, [['x']])),
      ['/items/$ref/anyOf', '/0', 'must match a subschema in anyOf', [
        ['/items/$ref/anyOf/0/type', '/0', 'must be an integer', []],
        ['/items/$ref/anyOf/1/items/$ref/anyOf', '/0/0', 'must match a subschema in anyOf', [
          ['/items/$ref/anyOf/1/items/$ref/anyOf/0/type', '/0/0', 'must be an integer', []],
          ['/items/$ref/anyOf/1/items/$ref/anyOf/1/type', '/0/0', 'must be an array', []],
          ['/items/$ref/anyOf/1/items/$ref/anyOf/2/type', '/0/0', 'must be an array', []],
        ]],
      ]]);
  });

  it('grows with the nesting, where the default grows with the paths through it', () => {
    /** @type {Record<string, number[]>} */
    const counts = {};
    for (const [name, [plain, distinct]] of Object.entries(PAIRS)) {
      const count = (/** @type {any} */ format, /** @type {number} */ depth) => {
        const document = output(format, nested, nestedIn(depth));
        return name === 'detailed' ? carried(document) : (document.errors ?? document.details).length;
      };
      counts[name] = [2, 4, 8].flatMap((depth) => [count(plain, depth), count(distinct, depth)]);
    }
    assert.deepEqual(counts, { basic: [10, 6, 46, 10, 766, 18], detailed: [10, 6, 46, 10, 766, 18], list: [10, 6, 46, 10, 766, 18] });
  });

  it('expands a failed unit a kept answer gave to two paths once', () => {
    /** @type {Record<string, number[]>} */
    const expanded = {};
    for (const [name, pair] of Object.entries(PAIRS)) {
      expanded[name] = [];
      for (const inner of pair) {
        for (const depth of [4, 8]) {
          const counts = { expanded: 0 };
          /** @type {WeakMap<object, any>} One proxy per record: a record given to two paths is one record */
          const proxies = new WeakMap();
          /** @type {(record: any) => any} */
          const track = (record) => {
            let proxy = proxies.get(record);
            if (proxy === undefined) {
              proxy = new Proxy(record, {
                get(target, key) {
                  if (key !== 'children') return target[key];
                  counts.expanded++;
                  return target.children.map(track);
                },
              });
              proxies.set(record, proxy);
            }
            return proxy;
          };
          const format = {
            name: inner.name,
            validator: inner.validator,
            recorder: (/** @type {Map<string, unknown>} */ schemas) => {
              const recorder = inner.recorder(schemas);
              const { run } = recorder;
              recorder.run = (/** @type {() => unknown} */ validate) => {
                const recorded = run(validate);
                return { ...recorded, root: track(recorded.root) };
              };
              return recorder;
            },
          };
          output(format, nested, nestedIn(depth));
          expanded[name].push(counts.expanded);
        }
      }
    }
    // default then distinct, at depths 4 and 8: the default reads each path's records
    assert.deepEqual(expanded, { basic: [76, 1276, 37, 65], detailed: [76, 1276, 37, 65], list: [76, 1276, 37, 65] });
  });

  it('leaves out an error a definition walked again raised, and the branch unit that held it', () => {
    // unevaluatedProperties walks each branch in full: no answer is kept
    const schema = {
      $schema: S, $id: 'https://example.com/u', type: 'object',
      anyOf: [{ properties: { a: { $ref: '#/$defs/n' } } }, { properties: { a: { $ref: '#/$defs/n' } }, required: ['b'] }],
      unevaluatedProperties: false, $defs: { n: { type: 'number', minimum: 10 } },
    };
    assert.deepEqual(output(basicOutput, schema, { a: 1 }).errors.map(row), [
      ['', '', 'A subschema had errors.'],
      ['/anyOf', '', 'must match a subschema in anyOf'],
      ['/anyOf/0/properties/a/$ref/minimum', '/a', 'must be >= 10'],
      ['/anyOf/1', '', 'A subschema had errors.'],
      ['/anyOf/1/properties/a/$ref/minimum', '/a', 'must be >= 10'],
      ['/anyOf/1/required', '', 'must have required property \'b\''],
      ['/unevaluatedProperties', '/a', 'unevaluated property \'a\' fails the \'unevaluatedProperties\' schema'],
    ]);
    assert.deepEqual(output(distinctBasicOutput, schema, { a: 1 }).errors.map(row), [
      ['', '', 'A subschema had errors.'],
      ['/anyOf', '', 'must match a subschema in anyOf'],
      ['/anyOf/0/properties/a/$ref/minimum', '/a', 'must be >= 10'],
      ['/anyOf/1/required', '', 'must have required property \'b\''],
      ['/unevaluatedProperties', '/a', 'unevaluated property \'a\' fails the \'unevaluatedProperties\' schema'],
    ]);
    const list = output(distinctListOutput, schema, { a: 1 }).details;
    assert.deepEqual(list.map(listRow), [
      ['', '', { anyOf: 'must match a subschema in anyOf' }],
      ['/unevaluatedProperties', '/a', { '': 'unevaluated property \'a\' fails the \'unevaluatedProperties\' schema' }],
      ['/anyOf/0/properties/a/$ref', '/a', { minimum: 'must be >= 10' }],
      ['/anyOf/1', '', { required: 'must have required property \'b\'' }],
    ]);
    assert.deepEqual(list[3].droppedAnnotations, { properties: ['a'] });
  });

  it('keeps what a dynamic reference resolved to on each path', () => {
    const schema = {
      $schema: S, $id: 'https://example.com/d', anyOf: [{ $ref: 'strings' }, { $ref: 'numbers' }],
      $defs: {
        list: { $id: 'list', type: 'array', items: { $dynamicRef: '#item' }, $defs: { item: { $dynamicAnchor: 'item' } } },
        strings: { $id: 'strings', $ref: 'list', $defs: { item: { $dynamicAnchor: 'item', type: 'string' } } },
        numbers: { $id: 'numbers', $ref: 'list', $defs: { item: { $dynamicAnchor: 'item', type: 'number' } } },
      },
    };
    const units = output(distinctBasicOutput, schema, [true, true]).errors;
    assert.deepEqual(units.map((/** @type {any} */ unit) => [unit.absoluteKeywordLocation ?? unit.keywordLocation, unit.instanceLocation, unit.error]), [
      ['/anyOf', '', 'must match a subschema in anyOf'],
      ['https://example.com/list#/items', '', 'A subschema had errors.'],
      ['https://example.com/strings#/$defs/item/type', '/0', 'must be a string'],
      ['https://example.com/strings#/$defs/item/type', '/1', 'must be a string'],
      ['https://example.com/numbers#/$defs/item/type', '/0', 'must be a number'],
      ['https://example.com/numbers#/$defs/item/type', '/1', 'must be a number'],
    ]);
    // the default lists the second path's branch unit at list#/items again
    assert.equal(output(basicOutput, schema, [true, true]).errors.length, 7);
  });

  it('tells two errors of one keyword apart by their params when the texts are both empty', () => {
    const schema = { $schema: S, $id: 'https://example.com/r', anyOf: [{ $ref: '#/$defs/r' }, { $ref: '#/$defs/r' }], $defs: { r: { required: ['x', 'y'] } } };
    assert.deepEqual(output(distinctBasicOutput, schema, {}, { messages: false }).errors.map(row), [
      ['/anyOf', '', ''],
      ['/anyOf/0/$ref', '', ''],
      ['/anyOf/0/$ref/required', '', ''],
      ['/anyOf/0/$ref/required', '', ''],
    ]);
    assert.equal(output(basicOutput, schema, {}, { messages: false }).errors.length, 7);
    assert.deepEqual(output(distinctListOutput, schema, {}, { messages: false }).details.map(listRow), [
      ['', '', { anyOf: '' }],
      ['/anyOf/0/$ref', '', { required: '' }],
    ]);
  });

  it('writes one unit for the same error raised twice at one keyword', () => {
    const schema = { $schema: S, allOf: [false, false] };
    assert.deepEqual(output(basicOutput, schema, 'a').errors.map(row), [
      ['', '', 'A subschema had errors.'], ['/allOf', '', 'must match all of the subschemas'], ['/allOf', '', 'must match all of the subschemas'],
    ]);
    assert.deepEqual(output(distinctBasicOutput, schema, 'a').errors.map(row), [['/allOf', '', 'must match all of the subschemas']]);
    assert.deepEqual(row(output(distinctDetailedOutput, schema, 'a')), ['/allOf', '', 'must match all of the subschemas']);
  });

  it('answers a passing document as the default format does, annotations and all', () => {
    const annotated = {
      $schema: S, $id: 'https://example.com/a', type: 'object',
      anyOf: [{ properties: { a: { $ref: '#/$defs/t' } } }, { properties: { a: { $ref: '#/$defs/t' } } }],
      $defs: { t: { title: 'T', type: 'integer' } },
    };
    for (const [name, [plain, distinct]] of Object.entries(PAIRS)) {
      for (const [schema, data] of /** @type {[any, unknown][]} */ ([[nested, [[1]]], [annotated, { a: 1 }]]))
        assert.deepEqual(output(distinct, schema, data), output(plain, schema, data), name);
    }
    // the title the two paths annotate is listed under each
    assert.equal(output(distinctBasicOutput, annotated, { a: 1 }).annotations.filter((/** @type {any} */ unit) => unit.annotation === 'T').length, 2);
  });

  it('is rendered again by localizeErrors, in any catalog and back', () => {
    for (const [name, [, distinct]] of Object.entries(PAIRS)) {
      const document = output(distinct, nested, [['x']]);
      const english = JSON.stringify(document);
      localizeErrors(document, compileMessageCatalog(nl));
      assert.notEqual(JSON.stringify(document), english, name);
      assert.doesNotMatch(JSON.stringify(document), /must be an integer/, name);
      localizeErrors(document, compileMessageCatalog({}));
      assert.equal(JSON.stringify(document), english, name);
    }
  });

  it('is a format of @jarenjs/validate/output, under its specification\'s name', () => {
    assert.deepEqual([distinctBasicOutput, distinctDetailedOutput, distinctListOutput].map((format) => [format.name, Object.isFrozen(format)]),
      [['basic', true], ['detailed', true], ['list', true]]);
  });
});
