//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

describe('the data keyword and an uncompilable reference', () => {
  /** @param {any} schema */
  const compile = (schema) => new JarenValidator().compile(schema);
  /** @param {string} ref */
  const withData = (ref) => ({ type: 'number', data: { minimum: ref } });
  /** @param {string} ref */
  const withDollarData = (ref) => ({ type: 'number', minimum: { $data: ref } });

  it('is refused when the schema is compiled, like $data', () => {
    for (const ref of ['bogus', '0x', '-1/a', '/a~2b', 'abc-not-a-pointer']) {
      assert.throws(() => compile(withData(ref)), { name: 'JSONPointerSyntaxError' }, `data ${ref}`);
      assert.throws(() => compile(withDollarData(ref)), { name: 'JSONPointerSyntaxError' }, `$data ${ref}`);
    }
  });

  it('names the reference it refused, in each member of the data object', () => {
    assert.throws(
      () => compile({ type: 'string', data: { minLength: '/ok', maxLength: 'bogus' } }),
      { name: 'JSONPointerSyntaxError', message: /'bogus'/ },
    );
  });

  it('keeps every reference that compiles, with the answers it gave', () => {
    const schema = {
      type: 'object',
      properties: { threshold: { type: 'number' }, value: { type: 'number', data: { minimum: '/threshold' } } },
    };
    const validate = compile(schema);
    assert.equal(validate({ threshold: 100, value: 5 }), false);
    assert.equal(validate({ threshold: 1, value: 5 }), true);
    for (const ref of ['', '/x', '1/x', '0', '1#', '/a~1b']) {
      assert.equal(typeof compile(withData(ref)), 'function', `data ${JSON.stringify(ref)}`);
    }
  });

  it('asserts nothing, still, where a compiled reference finds no value', () => {
    const validate = compile({
      type: 'object',
      properties: { value: { type: 'number', data: { minimum: '/missing' } } },
    });
    assert.equal(validate({ value: 5 }), true);
  });
});
