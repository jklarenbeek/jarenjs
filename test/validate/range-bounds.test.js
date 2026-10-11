//@ts-check

/**
 * An inclusive bound and an exclusive bound on the same side both apply:
 * a numeric `exclusiveMinimum`/`exclusiveMaximum` is its own bound beside
 * `minimum`/`maximum`, and only the draft-04 boolean spelling modifies the
 * inclusive value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { JarenValidator, ValidatorOptions } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

const DRAFTS = Object.freeze({
  'draft-06': 'http://json-schema.org/draft-06/schema#',
  'draft-07': 'http://json-schema.org/draft-07/schema#',
  '2019-09': 'https://json-schema.org/draft/2019-09/schema',
  '2020-12': 'https://json-schema.org/draft/2020-12/schema',
});

/**
 * @param {object} schema
 * @param {string} [$schema]
 * @returns {(data: any) => boolean}
 */
function compile(schema, $schema) {
  const jaren = new JarenValidator();
  return /** @type {any} */ (jaren.compile($schema === undefined ? schema : { $schema, ...schema }));
}

/**
 * @param {object} schema
 * @returns {(data: any) => { valid: boolean, errors: any[] }}
 */
function compileCollecting(schema) {
  const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
  return /** @type {any} */ (jaren.compile(schema));
}

for (const [draft, $schema] of Object.entries(DRAFTS)) {
  describe(`${draft}: inclusive and numeric exclusive bounds apply independently`, () => {
    it('minimum 5 beside exclusiveMinimum 3 rejects 4 and accepts 5 and 6', () => {
      const validate = compile({ minimum: 5, exclusiveMinimum: 3 }, $schema);
      assert.strictEqual(validate(4), false);
      assert.strictEqual(validate(3), false);
      assert.strictEqual(validate(5), true);
      assert.strictEqual(validate(6), true);
    });

    it('minimum 3 beside exclusiveMinimum 5 rejects 5 and accepts 5.5', () => {
      const validate = compile({ minimum: 3, exclusiveMinimum: 5 }, $schema);
      assert.strictEqual(validate(4), false);
      assert.strictEqual(validate(5), false);
      assert.strictEqual(validate(5.5), true);
    });

    it('maximum 5 beside exclusiveMaximum 10 rejects 6 and accepts 5 and 4', () => {
      const validate = compile({ maximum: 5, exclusiveMaximum: 10 }, $schema);
      assert.strictEqual(validate(6), false);
      assert.strictEqual(validate(10), false);
      assert.strictEqual(validate(5), true);
      assert.strictEqual(validate(4), true);
    });

    it('maximum 10 beside exclusiveMaximum 5 rejects 5 and accepts 4.5', () => {
      const validate = compile({ maximum: 10, exclusiveMaximum: 5 }, $schema);
      assert.strictEqual(validate(7), false);
      assert.strictEqual(validate(5), false);
      assert.strictEqual(validate(4.5), true);
    });

    it('all four bounds together form one closed range', () => {
      const validate = compile({
        minimum: 2, exclusiveMinimum: 1, maximum: 8, exclusiveMaximum: 9,
      }, $schema);
      assert.strictEqual(validate(1.5), false);
      assert.strictEqual(validate(2), true);
      assert.strictEqual(validate(8), true);
      assert.strictEqual(validate(8.5), false);
    });
  });
}

describe('without a $schema, inclusive and numeric exclusive bounds apply independently', () => {
  it('minimum 5 beside exclusiveMinimum 3 rejects 4', () => {
    assert.strictEqual(compile({ minimum: 5, exclusiveMinimum: 3 })(4), false);
  });

  it('maximum 5 beside exclusiveMaximum 10 rejects 6', () => {
    assert.strictEqual(compile({ maximum: 5, exclusiveMaximum: 10 })(6), false);
  });
});

describe('the failing bound names its own keyword', () => {
  it('a value under minimum but over exclusiveMinimum reports minimum with limit 5', () => {
    const result = compileCollecting({ minimum: 5, exclusiveMinimum: 3 })(4);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(result.errors.map(e => [e.keyword, e.params.limit]), [['minimum', 5]]);
  });

  it('a value over maximum but under exclusiveMaximum reports maximum with limit 5', () => {
    const result = compileCollecting({ maximum: 5, exclusiveMaximum: 10 })(6);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(result.errors.map(e => [e.keyword, e.params.limit]), [['maximum', 5]]);
  });

  it('a value that breaks the exclusive bound reports exclusiveMinimum with limit 5', () => {
    const result = compileCollecting({ minimum: 3, exclusiveMinimum: 5 })(5);
    assert.deepStrictEqual(result.errors.map(e => [e.keyword, e.params.limit]), [['exclusiveMinimum', 5]]);
  });
});

describe('draft-04 boolean exclusivity modifies the inclusive bound', () => {
  it('exclusiveMinimum true makes minimum 5 exclusive', () => {
    const validate = compile({ minimum: 5, exclusiveMinimum: true });
    assert.strictEqual(validate(5), false);
    assert.strictEqual(validate(5.1), true);
  });

  it('exclusiveMaximum true makes maximum 5 exclusive', () => {
    const validate = compile({ maximum: 5, exclusiveMaximum: true });
    assert.strictEqual(validate(5), false);
    assert.strictEqual(validate(4.9), true);
  });

  it('exclusiveMinimum false keeps minimum 5 inclusive and still rejects 1', () => {
    const validate = compile({ minimum: 5, exclusiveMinimum: false });
    assert.strictEqual(validate(5), true);
    assert.strictEqual(validate(1), false);
    assert.strictEqual(validate(0), false);
  });

  it('exclusiveMaximum false keeps maximum 5 inclusive and still accepts 5 and 4', () => {
    const validate = compile({ maximum: 5, exclusiveMaximum: false });
    assert.strictEqual(validate(5), true);
    assert.strictEqual(validate(4), true);
    assert.strictEqual(validate(6), false);
  });

  it('a boolean exclusivity with no inclusive bound asserts nothing', () => {
    assert.strictEqual(compile({ exclusiveMinimum: true })(5), true);
    assert.strictEqual(compile({ exclusiveMaximum: true })(5), true);
  });
});

describe('bigint bounds apply independently', () => {
  it('minimum 5n beside exclusiveMinimum 3n rejects 4n', () => {
    const validate = compile({ minimum: 5n, exclusiveMinimum: 3n });
    assert.strictEqual(validate(4n), false);
    assert.strictEqual(validate(5n), true);
  });

  it('maximum 5n beside exclusiveMaximum 10n rejects 6n', () => {
    const validate = compile({ maximum: 5n, exclusiveMaximum: 10n });
    assert.strictEqual(validate(6n), false);
    assert.strictEqual(validate(5n), true);
  });

  it('exclusiveMinimum 5n beside minimum 3n rejects 5n', () => {
    const validate = compile({ minimum: 3n, exclusiveMinimum: 5n });
    assert.strictEqual(validate(4n), false);
    assert.strictEqual(validate(5n), false);
    assert.strictEqual(validate(6n), true);
  });

  it('exclusiveMaximum 5n beside maximum 10n rejects 5n', () => {
    const validate = compile({ maximum: 10n, exclusiveMaximum: 5n });
    assert.strictEqual(validate(7n), false);
    assert.strictEqual(validate(5n), false);
    assert.strictEqual(validate(4n), true);
  });

  it('draft-04 booleans: true makes it exclusive, false keeps it inclusive', () => {
    assert.strictEqual(compile({ minimum: 5n, exclusiveMinimum: true })(5n), false);
    assert.strictEqual(compile({ maximum: 5n, exclusiveMaximum: false })(5n), true);
    assert.strictEqual(compile({ minimum: 5n, exclusiveMinimum: false })(1n), false);
  });
});

describe('format bounds apply independently', () => {
  const jaren = new JarenValidator();
  jaren.addFormats(formats.dateTimeFormats);

  it('formatMinimum beside formatExclusiveMinimum rejects a value under the inclusive bound', () => {
    const validate = jaren.compile({
      format: 'date',
      formatMinimum: '2020-01-05',
      formatExclusiveMinimum: '2020-01-03',
    });
    assert.strictEqual(validate('2020-01-04'), false);
    assert.strictEqual(validate('2020-01-05'), true);
    assert.strictEqual(validate('2020-01-06'), true);
  });

  it('formatMaximum beside formatExclusiveMaximum rejects a value over the inclusive bound', () => {
    const validate = jaren.compile({
      format: 'date',
      formatMaximum: '2020-01-05',
      formatExclusiveMaximum: '2020-01-10',
    });
    assert.strictEqual(validate('2020-01-06'), false);
    assert.strictEqual(validate('2020-01-05'), true);
    assert.strictEqual(validate('2020-01-04'), true);
  });

  it('formatExclusiveMaximum beside formatMaximum still rejects its own boundary', () => {
    const validate = jaren.compile({
      format: 'date',
      formatMaximum: '2020-01-10',
      formatExclusiveMaximum: '2020-01-05',
    });
    assert.strictEqual(validate('2020-01-05'), false);
    assert.strictEqual(validate('2020-01-06'), false);
    assert.strictEqual(validate('2020-01-04'), true);
  });

  it('formatExclusiveMinimum beside formatMinimum still rejects its own boundary', () => {
    const validate = jaren.compile({
      format: 'date',
      formatMinimum: '2020-01-03',
      formatExclusiveMinimum: '2020-01-05',
    });
    assert.strictEqual(validate('2020-01-05'), false);
    assert.strictEqual(validate('2020-01-06'), true);
  });
});
