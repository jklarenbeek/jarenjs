//@ts-check

/**
 * The 'errorMessage' keyword.
 *
 * 'errorMessage' overrides text, never structure (D-M6): it changes what
 * message/msgid say on the errors it matches, registered at schema compile
 * time and resolved only at report time - zero validation-time work.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JarenValidator, ValidatorOptions, localizeErrors, compileMessageCatalog } from '@jarenjs/validate';

function compileCollecting(schema, options = {}) {
  const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true, ...options }));
  return jaren.compile(schema);
}

describe("The 'errorMessage' keyword", () => {
  describe('string form', () => {
    it('replaces the message of every failure at the node', () => {
      const validate = compileCollecting({
        type: 'object',
        properties: {
          age: { type: 'integer', minimum: 18, errorMessage: 'Age must be a whole number of at least 18' },
        },
      });

      for (const data of [{ age: 'x' }, { age: 3.5 }, { age: 12 }]) {
        const result = validate(data);
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.errors[0].message, 'Age must be a whole number of at least 18');
      }
    });

    it('covers the whole subtree (a oneOf string replaces the branch noise)', () => {
      const validate = compileCollecting({
        type: 'object',
        properties: {
          id: {
            oneOf: [{ type: 'string', minLength: 8 }, { type: 'integer' }],
            errorMessage: 'id must be a long string or an integer',
          },
        },
      });

      const result = validate({ id: true });
      assert.strictEqual(result.valid, false);
      for (const error of result.errors) {
        assert.strictEqual(error.message, 'id must be a long string or an integer');
      }
      // structure untouched: the branch errors are still there
      assert.ok(result.errors.some(e => e.keyword === 'oneOf'));
      assert.ok(result.errors.some(e => e.keyword === 'type'));
    });

    it('interpolates {params} of the failed keyword', () => {
      const validate = compileCollecting({
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 5, errorMessage: 'needs {limit} characters minimum' },
        },
      });

      const result = validate({ name: 'ab' });
      assert.strictEqual(result.errors[0].message, 'needs 5 characters minimum');
    });
  });

  describe('map form', () => {
    it('per-keyword entries override only their keyword, at this node only', () => {
      const validate = compileCollecting({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 5,
            errorMessage: { minLength: 'Name is too short' },
          },
        },
      });

      const short = validate({ name: 'ab' });
      assert.strictEqual(short.errors.find(e => e.keyword === 'minLength').message, 'Name is too short');

      const wrong = validate({ name: 42 });
      // 'type' has no entry: default English text
      assert.strictEqual(wrong.errors.find(e => e.keyword === 'type').message, 'must be a string');
    });

    it("'_' is the node-level catch-all, beaten by keyword entries", () => {
      const validate = compileCollecting({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 5,
            errorMessage: { minLength: 'Too short', _: 'Name is invalid' },
          },
        },
      });

      assert.strictEqual(validate({ name: 'ab' }).errors[0].message, 'Too short');
      assert.strictEqual(validate({ name: 42 }).errors[0].message, 'Name is invalid');
    });

    it('required accepts a per-missing-property map', () => {
      const validate = compileCollecting({
        type: 'object',
        required: ['vatId', 'name'],
        errorMessage: {
          required: { vatId: 'A VAT id is required for business accounts' },
        },
      });

      const vat = validate({ name: 'x' }).errors.find(e => e.params.missingProperty === 'vatId');
      assert.strictEqual(vat.message, 'A VAT id is required for business accounts');
      // no per-property match, no '_': default text
      const name = validate({ vatId: 'x' }).errors.find(e => e.params.missingProperty === 'name');
      assert.strictEqual(name.message, "must have required property 'name'");
    });

    it('$query accepts default and per-code entries', () => {
      const validate = compileCollecting({
        type: 'object',
        properties: {
          num: {
            $query: { $gt: [{ $add: ['$', 1] }, 0] },
            errorMessage: {
              $query: {
                default: 'the assertion is not satisfied',
                JQ2001: 'the assertion could not be computed',
              },
            },
          },
          total: {
            $query: { $gt: ['$', 0] },
            errorMessage: { $query: { default: 'total must be positive' } },
          },
        },
      });

      const ebvFalse = validate({ total: -5 });
      assert.strictEqual(ebvFalse.errors[0].message, 'total must be positive');

      const runtime = validate({ num: 'not-a-number' });
      const error = runtime.errors.find(e => e.keyword === '$query');
      assert.strictEqual(error.params.code, 'JQ2001');
      assert.strictEqual(error.message, 'the assertion could not be computed');
    });
  });

  describe('precedence', () => {
    it('nearest node wins over an ancestor (segment-aware prefix)', () => {
      const validate = compileCollecting({
        type: 'object',
        errorMessage: 'outer message',
        properties: {
          foo: {
            type: 'object',
            properties: {
              bar: { type: 'string', errorMessage: 'inner message' },
            },
          },
          other: { type: 'string' },
        },
      });

      const inner = validate({ foo: { bar: 42 } });
      assert.strictEqual(inner.errors.find(e => e.keyword === 'type').message, 'inner message');

      const outer = validate({ other: 42 });
      assert.strictEqual(outer.errors.find(e => e.keyword === 'type').message, 'outer message');
    });

    it("'/foo' does not match '/foobar' (segment-aware)", () => {
      const validate = compileCollecting({
        type: 'object',
        properties: {
          foo: { type: 'object', properties: { x: { type: 'string' } }, errorMessage: 'foo subtree' },
          foobar: { type: 'object', properties: { x: { type: 'string' } } },
        },
      });

      const result = validate({ foobar: { x: 1 } });
      const error = result.errors.find(e => e.keyword === 'type');
      assert.strictEqual(error.message, 'must be a string');
    });
  });

  describe('$msgid indirection', () => {
    it('resolves through the built-in English catalog and sets msgid', () => {
      const validate = compileCollecting({
        type: 'object',
        properties: {
          // point one keyword at another catalog entry
          count: { type: 'integer', errorMessage: { type: { $msgid: 'multipleOf', params: { multipleOf: 5 } } } },
        },
      });

      const result = validate({ count: 'x' });
      const error = result.errors[0];
      assert.strictEqual(error.msgid, 'multipleOf');
      assert.strictEqual(error.message, 'must be multiple of 5');
      // spec params merged over the error's params
      assert.strictEqual(error.params.multipleOf, 5);
    });

    it('unknown $msgid falls back to the inline message, localizable later', () => {
      const validate = compileCollecting({
        type: 'object',
        properties: {
          total: { type: 'number', errorMessage: { type: { $msgid: 'checkout.total-invalid', message: 'Total must be a number' } } },
        },
      });

      const result = validate({ total: 'x' });
      const error = result.errors[0];
      assert.strictEqual(error.msgid, 'checkout.total-invalid');
      assert.strictEqual(error.message, 'Total must be a number');

      // a catalog carrying the key re-renders it...
      const nl = compileMessageCatalog({ 'checkout.total-invalid': 'Totaal moet een getal zijn' });
      localizeErrors(result.errors, nl);
      assert.strictEqual(error.message, 'Totaal moet een getal zijn');
    });

    it('inline text without $msgid survives localizeErrors (the caveat)', () => {
      const validate = compileCollecting({
        type: 'object',
        properties: {
          name: { type: 'string', errorMessage: 'Author text, single language' },
        },
      });

      const result = validate({ name: 42 });
      const nl = compileMessageCatalog({ type: 'moet van het juiste type zijn' });
      localizeErrors(result.errors, nl);
      assert.strictEqual(result.errors[0].message, 'Author text, single language');
    });
  });

  describe('messages: false', () => {
    it('skips rendering entirely; params and msgid still set', () => {
      const validate = compileCollecting({
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 5, errorMessage: { minLength: 'Too short' } },
        },
      }, { messages: false });

      const result = validate({ name: 'ab' });
      const error = result.errors[0];
      assert.strictEqual(error.message, '');
      assert.strictEqual(error.params.limit, 5);
      assert.strictEqual(error.msgid, 'minLength');
    });

    it("marks the schema's own text, so localizeErrors writes the author's words", () => {
      const catalog = compileMessageCatalog({ type: 'moet van het juiste type zijn' });
      const validate = compileCollecting({
        type: 'object',
        properties: {
          a: { type: 'number', errorMessage: 'Author text' },
          b: { type: 'number', errorMessage: { $msgid: 'checkout.b', message: 'Fallback text' } },
          c: { type: 'number' },
        },
      }, { messages: false });
      const errors = validate({ a: 'x', b: 'x', c: 'x' }).errors;
      assert.deepStrictEqual(errors.map((e) => e.message), ['', '', ''], 'conversion still renders nothing');
      assert.deepStrictEqual(errors.map((e) => e.toJSON().inlineMessage), [true, 'fallback', undefined]);
      localizeErrors(errors, catalog);
      assert.deepStrictEqual(errors.map((e) => e.message), ['Author text', 'Fallback text', 'moet van het juiste type zijn']);
      // a catalog that carries the fallback's msgid renders it, as with messages on
      const again = validate({ b: 'x' }).errors;
      localizeErrors(again, compileMessageCatalog({ 'checkout.b': 'B moet een getal zijn' }));
      assert.strictEqual(again[0].message, 'B moet een getal zijn');
    });

    it('a copy made before localizing never had the text, so it speaks its keyword', () => {
      const validate = compileCollecting({
        type: 'object',
        properties: {
          a: { type: 'number', errorMessage: 'Author text' },
          b: { type: 'number', errorMessage: { $msgid: 'checkout.b', message: 'Fallback text' } },
        },
      }, { messages: false });
      const copies = JSON.parse(JSON.stringify(validate({ a: 'x', b: 'x' }).errors));
      localizeErrors(copies, compileMessageCatalog({ type: 'moet van het juiste type zijn' }));
      assert.deepStrictEqual(copies.map((/** @type {any} */ e) => [e.inlineMessage, e.message]),
        [[true, 'moet van het juiste type zijn'], ['fallback', 'moet van het juiste type zijn']]);
      // a catalog carrying the fallback's msgid still renders it on a copy
      const again = JSON.parse(JSON.stringify(validate({ b: 'x' }).errors));
      localizeErrors(again, compileMessageCatalog({ 'checkout.b': 'B moet een getal zijn' }));
      assert.strictEqual(again[0].message, 'B moet een getal zijn');
    });
  });

  describe('compile-time validation', () => {
    it('rejects a malformed MessageSpec with the schema path', () => {
      assert.throws(
        () => compileCollecting({ type: 'string', errorMessage: 42 }),
        /invalid 'errorMessage'/);
      assert.throws(
        () => compileCollecting({ type: 'string', errorMessage: { type: { $msgid: 7 } } }),
        /'\$msgid' must be a string/);
      assert.throws(
        () => compileCollecting({ type: 'string', errorMessage: { type: { $msgid: 'x', params: [] } } }),
        /'params' must be an object/);
      assert.throws(
        () => compileCollecting({ type: 'string', errorMessage: { type: { $msgid: 'x', bogus: 1 } } }),
        /unknown MessageSpec member 'bogus'/);
    });
  });

  describe('zero validation-time cost', () => {
    it('does not knock a type-only node off the fast path', () => {
      // boolean mode: fast-path compilers name their closures; probe the shape
      const jaren = new JarenValidator();
      const plain = jaren.compile({ type: 'string' });
      const annotated = jaren.compile({ type: 'string', errorMessage: 'nope' });
      assert.strictEqual(typeof plain, 'function');
      assert.strictEqual(plain('x'), true);
      assert.strictEqual(annotated('x'), true);
      assert.strictEqual(annotated(42), false);
    });

    it('boolean mode stays boolean with errorMessage present', () => {
      const jaren = new JarenValidator();
      const validate = jaren.compile({
        type: 'object',
        properties: { a: { type: 'string', errorMessage: 'nope' } },
      });
      assert.strictEqual(validate({ a: 1 }), false);
      assert.strictEqual(validate({ a: 'x' }), true);
    });
  });
});

describe('localizeErrors and the text a schema wrote', () => {
  const catalog = compileMessageCatalog({ type: 'moet van het juiste type zijn', $query: 'voldoet niet aan de query' });
  const fallbackSchema = {
    type: 'object',
    properties: { total: { type: 'number', errorMessage: { type: { $msgid: 'checkout.total-invalid', message: 'Total must be a number' } } } },
  };

  it("keeps a $msgid spec's inline text when no catalog carries its msgid", () => {
    const result = compileCollecting(fallbackSchema)({ total: 'x' });
    localizeErrors(result.errors, catalog);
    assert.strictEqual(result.errors[0].message, 'Total must be a number');
  });

  it('renders that msgid once a catalog carries it, and the catalog text then stays', () => {
    const result = compileCollecting(fallbackSchema)({ total: 'x' });
    localizeErrors(result.errors, compileMessageCatalog({ 'checkout.total-invalid': 'Totaal moet een getal zijn' }));
    assert.strictEqual(result.errors[0].message, 'Totaal moet een getal zijn');
    // the inline text is not kept beside it: a second catalog without the key leaves the last render
    localizeErrors(result.errors, catalog);
    assert.strictEqual(result.errors[0].message, 'Totaal moet een getal zijn');
  });

  it('a $msgid spec without inline text still speaks the keyword in the catalog', () => {
    const result = compileCollecting({ type: 'number', errorMessage: { type: { $msgid: 'checkout.total-invalid' } } })('x');
    assert.strictEqual(result.errors[0].message, 'must be a number');
    localizeErrors(result.errors, catalog);
    assert.strictEqual(result.errors[0].message, 'moet van het juiste type zijn');
  });

  it('a msgid no catalog carries and no schema wrote still falls back to the keyword', () => {
    // a query code no English entry names, the way an uncovered JQ code reads
    const errors = [{ keyword: '$query', instancePath: '', schemaPath: '', params: { code: 'JQ2099' }, msgid: 'JQ2099', message: '' }];
    localizeErrors(/** @type {any} */ (errors), catalog);
    assert.strictEqual(errors[0].message, 'voldoet niet aan de query');
  });

  it('a plain keyword error localizes', () => {
    const result = compileCollecting({ type: 'number' })('x');
    localizeErrors(result.errors, catalog);
    assert.strictEqual(result.errors[0].message, 'moet van het juiste type zijn');
  });

  it('toJSON names the inline status, and only when the schema wrote the text', () => {
    const inline = compileCollecting({ type: 'number', errorMessage: 'Author text' })('x').errors[0];
    const fallback = compileCollecting(fallbackSchema)({ total: 'x' }).errors[0];
    const plain = compileCollecting({ type: 'number' })('x').errors[0];
    assert.strictEqual(inline.toJSON().inlineMessage, true);
    assert.strictEqual(fallback.toJSON().inlineMessage, 'fallback');
    assert.deepStrictEqual(Object.keys(plain.toJSON()), ['keyword', 'instancePath', 'schemaPath', 'params', 'msgid', 'message']);
    // the instance keeps the status out of a spread and out of its own keys
    assert.ok(!Object.keys(inline).includes('inlineMessage'));
  });

  it('a copy that crossed JSON localizes as the error itself does', () => {
    const errors = [
      compileCollecting({ type: 'number', errorMessage: 'Author text' })('x').errors[0],
      compileCollecting(fallbackSchema)({ total: 'x' }).errors[0],
      compileCollecting({ type: 'number' })('x').errors[0],
    ];
    const copies = JSON.parse(JSON.stringify(errors));
    localizeErrors(copies, catalog);
    assert.deepStrictEqual(copies.map((/** @type {any} */ e) => e.message),
      ['Author text', 'Total must be a number', 'moet van het juiste type zijn']);
  });
});
