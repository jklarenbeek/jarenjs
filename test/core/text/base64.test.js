import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isValidBase64,
} from '@jarenjs/core/text/base64';

describe('isValidBase64', () => {
  it('should return true for valid base64 strings', () => {
    assert.isTrue(isValidBase64(''));
    assert.isTrue(isValidBase64('Zg=='));
    assert.isTrue(isValidBase64('Zm8='));
    assert.isTrue(isValidBase64('Zm9v'));
    assert.isTrue(isValidBase64('SGVsbG8gV29ybGQ='));
  });

  it('should return false for invalid base64 strings', () => {
    assert.isFalse(isValidBase64('Zg'));
    assert.isFalse(isValidBase64('Zm9v!'));
  });
});

