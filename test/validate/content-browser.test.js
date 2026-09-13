import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

it('validates base64 UTF-8 JSON without the Node Buffer global', () => {
  const schema = { contentEncoding: 'base64', contentMediaType: 'application/json' };
  const validate = new JarenValidator({ contentValidation: true }).compile(schema);
  const annotation = new JarenValidator({ contentValidation: false }).compile(schema);
  const unicode = Buffer.from('{"message":"café 世界 👋"}').toString('base64');
  const bom = Buffer.from('\ufeff{"a":1}').toString('base64');
  const original = globalThis.Buffer;
  try {
    delete globalThis.Buffer;
    assert.equal(validate('eyJhIjoxfQ=='), true);
    assert.equal(validate(unicode), true);
    assert.equal(validate('bm9wZQ=='), false);
    assert.equal(validate('invalid?!'), false);
    assert.equal(validate(bom), false, 'retain the UTF-8 BOM instead of silently stripping it');
    assert.equal(validate(42), true);
    assert.equal(annotation('invalid?!'), true);
  }
  finally { globalThis.Buffer = original; }
});
