// `contentMediaType: 'application/json'` decodes the string by the encoding
// `contentEncoding` names when the validator knows it (base64), and reads an
// encoding it does not know as `contentEncoding` alone reads it: not checked.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

const D19 = 'https://json-schema.org/draft/2019-09/schema';
const answers = (schema, instances, options = {}) => {
  const validate = new JarenValidator(options).compile(schema);
  return instances.map((instance) => validate(instance));
};
// '{"a":1}' in base64 and in base32 (RFC 4648)
const BASE64_JSON = 'eyJhIjoxfQ==';
const BASE32_JSON = 'PMRGC5BCHI2H2===';
const BASE64_NOT_JSON = 'bm9wZQ==';

describe('an encoding the validator does not know is not decoded as base64', () => {
  it('a base32 JSON document passes, as base32 alone does', () => {
    const schema = { contentEncoding: 'base32', contentMediaType: 'application/json' };
    assert.deepEqual(answers(schema, [BASE32_JSON, 'not base32 !', 42]), [true, true, true]);
    assert.deepEqual(answers({ contentEncoding: 'base32' }, [BASE32_JSON, 'not base32 !']), [true, true]);
  });

  it('an encoding name is matched as written: BASE64 is not base64', () => {
    const schema = { contentEncoding: 'BASE64', contentMediaType: 'application/json' };
    assert.deepEqual(answers(schema, [BASE64_JSON, 'invalid?!']), [true, true]);
    assert.deepEqual(answers({ contentEncoding: 'BASE64' }, ['invalid?!']), [true]);
  });

  it('collected errors carry no media-type failure for an unknown encoding', () => {
    const validate = new JarenValidator({ collectErrors: true })
      .compile({ contentEncoding: 'base32', contentMediaType: 'application/json' });
    assert.deepEqual(validate(BASE32_JSON), { valid: true, errors: [] });
  });
});

describe('every content case that answered right answers the same', () => {
  it('JSON with no encoding is parse-checked', () => {
    assert.deepEqual(answers({ contentMediaType: 'application/json' }, ['{"a":1}', '{', 42]), [true, false, true]);
  });

  it('base64 JSON is decoded, then parse-checked', () => {
    const schema = { contentEncoding: 'base64', contentMediaType: 'application/json' };
    assert.deepEqual(answers(schema, [BASE64_JSON, BASE64_NOT_JSON, 'invalid?!', 42]), [true, false, false, true]);
  });

  it('base64 alone checks the encoding', () => {
    assert.deepEqual(answers({ contentEncoding: 'base64' }, [BASE64_JSON, BASE64_NOT_JSON, 'invalid?!', 42]), [true, true, false, true]);
  });

  it('an unknown media type beside base64 checks the encoding only', () => {
    const schema = { contentEncoding: 'base64', contentMediaType: 'text/html' };
    assert.deepEqual(answers(schema, [BASE64_NOT_JSON, 'invalid?!']), [true, false]);
  });

  it('an unknown media type alone passes', () => {
    assert.deepEqual(answers({ contentMediaType: 'text/html' }, ['<p', 42]), [true, true]);
  });

  it('a failed base64 JSON check still names the media type and the encoding', () => {
    const validate = new JarenValidator({ collectErrors: true })
      .compile({ contentEncoding: 'base64', contentMediaType: 'application/json' });
    const { valid, errors } = validate(BASE64_NOT_JSON);
    assert.equal(valid, false);
    assert.deepEqual(errors.map((e) => [e.keyword, e.params]),
      [['contentMediaType', { mediaType: 'application/json', encoding: 'base64' }]]);
    assert.equal(errors[0].message, 'must be "application/json" content encoded as "base64"');
  });

  it('content keywords annotate from 2019-09 on and when contentValidation is off', () => {
    const schema = { contentEncoding: 'base64', contentMediaType: 'application/json' };
    assert.deepEqual(answers({ $schema: D19, ...schema }, ['invalid?!', BASE64_NOT_JSON]), [true, true]);
    assert.deepEqual(answers(schema, ['invalid?!', BASE64_NOT_JSON], { contentValidation: false }), [true, true]);
    assert.deepEqual(answers({ $schema: D19, contentEncoding: 'base32', contentMediaType: 'application/json' }, ['not base32 !']), [true]);
  });

  it('contentValidation asserts under 2019-09 too', () => {
    const schema = { $schema: D19, contentEncoding: 'base64', contentMediaType: 'application/json' };
    assert.deepEqual(answers(schema, [BASE64_JSON, BASE64_NOT_JSON, 'invalid?!'], { contentValidation: true }), [true, false, false]);
  });
});
