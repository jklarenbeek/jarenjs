//@ts-check

/**
 * TODO_17 work item 1: the handler-contract invariant.
 *
 * Every error handler call site passes the instance data path as the
 * first meta argument (normal handlers: addError(data, dataPath, ...),
 * keyed handlers: addKeyedError(dataKey, data, dataPath, ...)), so the
 * public error's instancePath is a straight rest[0] read. This suite
 * locks in the instancePath matrix for the keywords the audit touched.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JarenValidator, ValidatorOptions } from '@jarenjs/validate';

function compileCollecting(schema, schemas = undefined) {
  const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
  return jaren.compile(schema, schemas);
}

describe('Error meta: instancePath matrix', () => {
  it('required: error sits on the owning object', () => {
    const validate = compileCollecting({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: { street: { type: 'string' } },
          required: ['street'],
        },
      },
      required: ['name'],
    });

    const rootResult = validate({ address: { street: 'main' } });
    assert.strictEqual(rootResult.valid, false);
    const rootError = rootResult.errors.find(e => e.keyword === 'required' && e.params.missingProperty === 'name');
    assert.ok(rootError, 'missing root required error');
    assert.strictEqual(rootError.instancePath, '');

    const nestedResult = validate({ name: 'x', address: {} });
    assert.strictEqual(nestedResult.valid, false);
    const nestedError = nestedResult.errors.find(e => e.keyword === 'required' && e.params.missingProperty === 'street');
    assert.ok(nestedError, 'missing nested required error');
    assert.strictEqual(nestedError.instancePath, '/address');
  });

  it('required-only fast path: instancePath present', () => {
    const validate = compileCollecting({ required: ['a'] });
    const result = validate({});
    assert.strictEqual(result.valid, false);
    const error = result.errors.find(e => e.keyword === 'required');
    assert.strictEqual(error.instancePath, '');
    assert.strictEqual(error.params.missingProperty, 'a');
  });

  it('additionalProperties: error sits on the offending member', () => {
    const validate = compileCollecting({
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { known: {} }, additionalProperties: false },
      },
      additionalProperties: { type: 'object' },
    });

    const result = validate({ nested: { known: 1, extra: 2 } });
    assert.strictEqual(result.valid, false);
    const error = result.errors.find(e => e.keyword === 'additionalProperties');
    assert.ok(error, 'missing additionalProperties error');
    assert.strictEqual(error.params.additionalProperty, 'extra');
    assert.strictEqual(error.instancePath, '/nested/extra');
  });

  it('propertyNames: error carries the object path', () => {
    const validate = compileCollecting({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          propertyNames: { maxLength: 3 },
        },
      },
    });

    const result = validate({ nested: { toolong: 1 } });
    assert.strictEqual(result.valid, false);
    const error = result.errors.find(e => e.keyword === 'maxLength');
    assert.ok(error, 'missing propertyNames maxLength error');
    assert.strictEqual(error.instancePath, '/nested');
  });

  it('patternProperties: member failures carry the member path', () => {
    const validate = compileCollecting({
      type: 'object',
      patternProperties: {
        '^num': { type: 'number' },
      },
    });

    const result = validate({ numX: 'not a number' });
    assert.strictEqual(result.valid, false);
    const error = result.errors.find(e => e.keyword === 'type');
    assert.ok(error, 'missing type error');
    assert.strictEqual(error.instancePath, '/numX');
  });

  it('type: nested object and array item paths', () => {
    const validate = compileCollecting({
      type: 'object',
      properties: {
        level1: {
          type: 'object',
          properties: {
            list: {
              type: 'array',
              // more than one keyword: takes the full compilation path so
              // the item failure reports its own path (the type-only item
              // fast path aggregates into a single 'items' error instead)
              items: { type: 'number', minimum: 0 },
            },
          },
        },
      },
    });

    const result = validate({ level1: { list: [1, 'two'] } });
    assert.strictEqual(result.valid, false);
    const error = result.errors.find(e => e.keyword === 'type');
    assert.ok(error, 'missing item type error');
    assert.strictEqual(error.instancePath, '/level1/list/1');
  });

  it('minLength: error carries the member path', () => {
    const validate = compileCollecting({
      type: 'object',
      properties: { name: { type: 'string', minLength: 3 } },
    });

    const result = validate({ name: 'ab' });
    assert.strictEqual(result.valid, false);
    const error = result.errors.find(e => e.keyword === 'minLength');
    assert.ok(error, 'missing minLength error');
    assert.strictEqual(error.instancePath, '/name');
    assert.strictEqual(error.params.limit, 3);
  });

  it('dependentRequired: keyed error with triggering property and path', () => {
    const validate = compileCollecting({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        billing: {
          type: 'object',
          dependentRequired: { creditCard: ['billingAddress'] },
        },
      },
    });

    const result = validate({ billing: { creditCard: '1234' } });
    assert.strictEqual(result.valid, false);
    const error = result.errors.find(e => e.keyword === 'dependentRequired');
    assert.ok(error, 'missing dependentRequired error');
    assert.ok(error.instancePath.startsWith('/billing'), `instancePath '${error.instancePath}' should sit under /billing`);
  });

  it('$query: EBV-false failure carries path, no code params', () => {
    const validate = compileCollecting({
      type: 'object',
      properties: {
        total: { $query: { $gt: ['$', 0] } },
      },
    });

    const result = validate({ total: -1 });
    assert.strictEqual(result.valid, false);
    const error = result.errors.find(e => e.keyword === '$query');
    assert.ok(error, 'missing $query error');
    assert.strictEqual(error.instancePath, '/total');
    assert.strictEqual(error.params.code, undefined);
    assert.strictEqual(error.msgid, '$query');
  });

  it('$query: runtime failure carries the JQ code and docPath', () => {
    const validate = compileCollecting({
      type: 'object',
      properties: {
        // arithmetic on a string raises a JQ2xxx runtime error
        num: { $query: { $gt: [{ $add: ['$', 1] }, 0] } },
      },
    });

    const result = validate({ num: 'not-a-number' });
    assert.strictEqual(result.valid, false);
    const error = result.errors.find(e => e.keyword === '$query');
    assert.ok(error, 'missing $query error');
    assert.strictEqual(error.instancePath, '/num');
    assert.ok(typeof error.params.code === 'string' && error.params.code.startsWith('JQ2'),
      `expected a JQ2xxx code, got ${error.params.code}`);
    assert.ok(typeof error.params.docPath === 'string');
    assert.strictEqual(error.msgid, error.params.code);
    assert.ok(error.message.includes(error.params.code));
  });

  it('$data required: keyed error carries missingProperty', () => {
    const validate = compileCollecting({
      type: 'object',
      properties: {
        sub: {
          type: 'object',
          required: { $data: '1/requires' },
        },
      },
    });

    const result = validate({ requires: ['vatId'], sub: {} });
    assert.strictEqual(result.valid, false);
    const error = result.errors.find(e => e.keyword === 'required');
    assert.ok(error, 'missing $data required error');
    assert.strictEqual(error.params.missingProperty, 'vatId');
    assert.strictEqual(error.instancePath, '/sub');
  });

  it('$data minimum: error carries the member path', () => {
    const validate = compileCollecting({
      type: 'object',
      properties: {
        larger: { type: 'number', minimum: { $data: '1/smaller' } },
        smaller: { type: 'number' },
      },
    });

    const result = validate({ smaller: 10, larger: 5 });
    assert.strictEqual(result.valid, false);
    const error = result.errors.find(e => e.keyword === 'minimum');
    assert.ok(error, 'missing $data minimum error');
    assert.strictEqual(error.instancePath, '/larger');
  });

  it('every collected error exposes msgid', () => {
    const validate = compileCollecting({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { const: 42 },
      },
    });

    const result = validate({ a: 1, b: 43 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length >= 2);
    for (const error of result.errors) {
      assert.strictEqual(typeof error.msgid, 'string');
      assert.ok(error.msgid.length > 0);
    }
    const constError = result.errors.find(e => e.keyword === 'const');
    assert.strictEqual(constError.msgid, 'const');
    // keywords without a catalog entry keep the generic message
    assert.strictEqual(constError.message, "validation failed for keyword 'const'");
  });
});
