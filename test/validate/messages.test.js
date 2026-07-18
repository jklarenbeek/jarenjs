//@ts-check

/**
 * TODO_17 work item 3: the messages module public API.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  JarenValidator,
  ValidatorOptions,
  ValidationError,
  messagesEn,
  compileMessageTemplate,
  compileMessageCatalog,
  renderErrorMessage,
  localizeErrors,
} from '@jarenjs/validate';

describe('compileMessageTemplate', () => {
  it('substitutes named params', () => {
    const render = compileMessageTemplate('must be {comparison} {limit}');
    assert.strictEqual(render({ comparison: '>=', limit: 10 }), 'must be >= 10');
  });

  it('leaves an unknown placeholder literally', () => {
    const render = compileMessageTemplate('needs {limit} and {missing}');
    assert.strictEqual(render({ limit: 3 }), 'needs 3 and {missing}');
  });

  it('escapes a literal brace with {{', () => {
    const render = compileMessageTemplate('a {{literal} and {limit}');
    assert.strictEqual(render({ limit: 1 }), 'a {literal} and 1');
  });

  it('renders primitives with String, objects with JSON.stringify', () => {
    const render = compileMessageTemplate('value: {value}');
    assert.strictEqual(render({ value: 'text' }), 'value: text');
    assert.strictEqual(render({ value: 5 }), 'value: 5');
    assert.strictEqual(render({ value: null }), 'value: null');
    assert.strictEqual(render({ value: { a: 1 } }), 'value: {"a":1}');
    assert.strictEqual(render({ value: [1, 2] }), 'value: [1,2]');
  });

  it('tolerates an unterminated placeholder', () => {
    const render = compileMessageTemplate('broken {limit');
    assert.strictEqual(render({ limit: 3 }), 'broken {limit');
  });

  it('compiles a literal-only template to a constant closure', () => {
    const render = compileMessageTemplate('no params here');
    assert.strictEqual(render({}), 'no params here');
    assert.strictEqual(render(undefined), 'no params here');
  });
});

describe('compileMessageCatalog', () => {
  it('compiles template strings, keeps closures, freezes the result', () => {
    const catalog = compileMessageCatalog({
      simple: 'limit is {limit}',
      fancy: (p) => `got ${p.limit * 2}`,
    });
    assert.strictEqual(catalog.simple({ limit: 4 }), 'limit is 4');
    assert.strictEqual(catalog.fancy({ limit: 4 }), 'got 8');
    assert.ok(Object.isFrozen(catalog));
  });
});

describe('renderErrorMessage', () => {
  it('renders from msgid through the given catalog, English fallback', () => {
    const error = new ValidationError({
      keyword: 'minLength', instancePath: '', schemaPath: '', params: { limit: 2 },
    });
    assert.strictEqual(renderErrorMessage(error), 'must NOT have fewer than 2 characters');

    const nl = compileMessageCatalog({ minLength: 'ten minste {limit} tekens' });
    assert.strictEqual(renderErrorMessage(error, nl), 'ten minste 2 tekens');
  });

  it('falls back from a JQ msgid to the $query keyword entry', () => {
    const error = new ValidationError({
      keyword: '$query', msgid: 'JQ2099',
      instancePath: '', schemaPath: '',
      params: { code: 'JQ2099', docPath: '/x' },
    });
    assert.strictEqual(renderErrorMessage(error), "'$query' assertion raised JQ2099 at '/x'");
  });

  it('renders the generic fallback for an unknown keyword', () => {
    const error = new ValidationError({
      keyword: 'no-such-keyword', instancePath: '', schemaPath: '', params: {},
    });
    assert.strictEqual(renderErrorMessage(error), "validation failed for keyword 'no-such-keyword'");
  });
});

describe('localizeErrors', () => {
  it('re-renders a whole collect-mode result post hoc', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validate = jaren.compile({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 3 },
        age: { type: 'integer', minimum: 18 },
      },
    });

    const result = validate({ name: 'ab', age: 3 });
    assert.strictEqual(result.valid, false);

    const nl = compileMessageCatalog({
      minLength: 'mag niet minder dan {limit} tekens bevatten',
      minimum: 'moet {comparison} {limit} zijn',
    });
    localizeErrors(result.errors, nl);

    const minLength = result.errors.find(e => e.keyword === 'minLength');
    const minimum = result.errors.find(e => e.keyword === 'minimum');
    assert.strictEqual(minLength.message, 'mag niet minder dan 3 tekens bevatten');
    assert.strictEqual(minimum.message, 'moet >= 18 zijn');
  });

  it('keeps English for keys the catalog does not cover', () => {
    const errors = [new ValidationError({
      keyword: 'maxItems', instancePath: '', schemaPath: '', params: { limit: 2 },
    })];
    localizeErrors(errors, compileMessageCatalog({}));
    assert.strictEqual(errors[0].message, 'must NOT have more than 2 items');
  });

  it('returns the same array', () => {
    const errors = [];
    assert.strictEqual(localizeErrors(errors, compileMessageCatalog({})), errors);
  });
});

describe('messagesEn', () => {
  it('covers every key of the historical message chain', () => {
    const expected = [
      'type', 'required',
      'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
      'minLength', 'maxLength', 'pattern',
      'additionalProperties', 'minProperties', 'maxProperties',
      'minItems', 'maxItems', 'uniqueItems', 'contains', 'items',
      'allOf', 'anyOf', 'oneOf', 'not', 'format',
      'if', 'then', 'else', 'false schema', '$query',
      'JQ2001', 'JQ2003',
    ];
    for (const key of expected) {
      assert.ok(key in messagesEn, `messagesEn is missing '${key}'`);
    }
  });

  it('renders the historical strings byte-identically', () => {
    const en = compileMessageCatalog(messagesEn);
    assert.strictEqual(en.type({ type: 'integer' }), 'must be an integer');
    assert.strictEqual(en.type({ type: 'string' }), 'must be a string');
    assert.strictEqual(en.type({ types: ['string', 'number'] }), 'must be one of the following types: string, number');
    assert.strictEqual(en.required({ missingProperty: 'x' }), "must have required property 'x'");
    assert.strictEqual(en.required({}), 'must have required properties');
    assert.strictEqual(en.additionalProperties({ additionalProperty: 'x' }), "must NOT have additional property 'x'");
    assert.strictEqual(en.additionalProperties({}), 'must NOT have additional properties');
    assert.strictEqual(en.$query({}), "must satisfy the '$query' assertion");
    assert.strictEqual(en.$query({ code: 'JQ2003', docPath: '/a' }), "'$query' assertion raised JQ2003 at '/a'");
    assert.strictEqual(en.JQ2003({ code: 'JQ2003', docPath: '/a' }), "'$query' assertion raised JQ2003 at '/a'");
  });
});

describe('ValidationError', () => {
  it('serializes msgid via toJSON', () => {
    const error = new ValidationError({
      keyword: 'minLength', instancePath: '/a', schemaPath: '#/a',
      params: { limit: 1 }, msgid: 'custom.key', message: 'text',
    });
    assert.deepStrictEqual(error.toJSON(), {
      keyword: 'minLength',
      instancePath: '/a',
      schemaPath: '#/a',
      params: { limit: 1 },
      msgid: 'custom.key',
      message: 'text',
    });
  });

  it('defaults msgid to the keyword', () => {
    const error = new ValidationError({ keyword: 'pattern', instancePath: '', schemaPath: '', params: {} });
    assert.strictEqual(error.msgid, 'pattern');
  });
});
