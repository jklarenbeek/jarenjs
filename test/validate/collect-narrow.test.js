import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { basicOutput } from '@jarenjs/validate/output';
import { compileAsync } from '@jarenjs/validate/load';

// A collect-mode validator's `narrow(data)` answers its `{ valid, errors }`
// with the instance itself as `value` on the valid branch: one validation
// gives both the errors and the narrowed instance.

const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };

describe('narrow on a collect-mode validator', () => {
  const check = new JarenValidator({ collectErrors: true }).compile(schema);

  it('answers the instance itself on the valid branch', () => {
    const input = { name: 'Ada' };
    const answer = check.narrow(input);
    assert.deepEqual(answer, { valid: true, value: { name: 'Ada' }, errors: [] });
    assert.equal(answer.value, input);
  });

  it('answers what the call answers on the invalid branch, with no value', () => {
    for (const input of [{}, { name: 1 }, null, 'x']) {
      const answer = check.narrow(input);
      assert.deepEqual(answer, check(input));
      assert.equal(answer.valid, false);
      assert.equal('value' in answer, false);
    }
    assert.deepEqual(check.narrow({ name: 1 }).errors.map((e) => [e.keyword, e.instancePath]), [['type', '/name']]);
  });

  it('a falsy instance is carried as is', () => {
    const any = new JarenValidator({ collectErrors: true }).compile({});
    for (const input of [0, '', false, null]) assert.deepEqual(any.narrow(input), { valid: true, value: input, errors: [] });
  });

  it('leaves the call\'s own answer as it was', () => {
    assert.deepEqual(check({ name: 'Ada' }), { valid: true, errors: [] });
    assert.equal(Object.keys(check).includes('narrow'), false);
  });

  it('is on a collector compileAsync answers', async () => {
    const loaded = await compileAsync(new JarenValidator({ collectErrors: true }), schema, { loadSchema: async () => true });
    assert.deepEqual(loaded.narrow({ name: 'Ada' }), { valid: true, value: { name: 'Ada' }, errors: [] });
  });

  it('is on no boolean-mode or output-format validator', () => {
    assert.equal('narrow' in new JarenValidator().compile(schema), false);
    assert.equal('narrow' in new JarenValidator({ outputFormat: basicOutput }).compile(schema), false);
  });
});
