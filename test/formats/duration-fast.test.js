//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator } from '@jarenjs/validate';
import { dateTimeFormats } from '@jarenjs/formats';

describe('duration format — skipErrors fast path', function () {
  it('asserts RFC 3339 durations through the allocation-free validator', function () {
    // skipErrors:true selects compileDurationFormat's validateDurationFast,
    // which returns a bare boolean and never builds an error object
    const validate = new JarenValidator({ skipErrors: true, formatAssertion: true })
      .addFormats(dateTimeFormats)
      .compile({ format: 'duration' });
    assert.equal(validate('P1D'), true);
    assert.equal(validate('PT1H30M'), true);
    assert.equal(validate('nope'), false);
    assert.equal(validate(42), true, 'the format applies to strings only; non-strings pass');
  });
});
