import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

it('retains supported assertions beside direct and chained modern references', () => {
  for (const $schema of ['https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema']) {
    for (const [sibling, invalid, valid] of [
      [{ dependentSchemas: { a: { required: ['b'] } } }, { a: 1 }, { a: 1, b: 2 }],
      [{ dependencies: { a: { required: ['b'] } } }, { a: 1 }, { a: 1, b: 2 }],
      [{ nullable: false }, null, 1],
      [{ $dynamicRef: '#/$defs/no' }, 0, undefined],
    ]) {
      for (const chained of [false, true]) {
        const hop = { $ref: '#/$defs/yes', ...sibling };
        const schema = { $schema, $defs: { yes: true, no: false, hop },
          ...(chained ? { $ref: '#/$defs/hop' } : hop) };
        const validate = new JarenValidator().compile(schema);
        assert.equal(validate(invalid), false, JSON.stringify({ $schema, sibling, chained }));
        if (valid !== undefined) assert.equal(validate(valid), true);
        const legacy = new JarenValidator().compile({ ...schema, $schema: 'http://json-schema.org/draft-07/schema#' });
        assert.equal(legacy(invalid), true, 'draft-07 keeps reference-only semantics');
      }
    }
  }
});
