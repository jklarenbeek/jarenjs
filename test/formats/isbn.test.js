import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import { JarenValidator } from '@jarenjs/validate';
import { stringFormats, formatTesters } from '@jarenjs/formats';

// The isbn formats accept the number as people write it and refuse a
// number whose check digit fails.

describe('isbn10 and isbn13 formats', function () {
  const validator = new JarenValidator().addFormats(stringFormats);
  const isbn10 = validator.compile({ format: 'isbn10' });
  const isbn13 = validator.compile({ format: 'isbn13' });

  it('accepts a bare or grouped ISBN-10 with a correct check digit', function () {
    for (const text of ['0306406152', '0-306-40615-2', '0 306 40615 2', '080442957X', '0-8044-2957-X', 'ISBN 0306406152', 'ISBN-10: 0-306-40615-2']) {
      assert.isTrue(formatTesters.isbn10(text), text);
      assert.isTrue(isbn10(text), text);
    }
  });

  it('refuses an ISBN-10 with a wrong check digit or a malformed grouping', function () {
    for (const text of ['0306406153', 'ISBN 0306406153', '0-306 40615-2', '0-306-40615-', '12345678', '12345678901', '0306406152 ', '']) {
      assert.isFalse(formatTesters.isbn10(text), JSON.stringify(text));
      assert.isFalse(isbn10(text), JSON.stringify(text));
    }
  });

  it('accepts a bare or grouped ISBN-13 with a correct check digit', function () {
    for (const text of ['9780306406157', '978-0-306-40615-7', '978 0 306 40615 7', '9790306406156', '978-3-16-148410-0', 'ISBN 9780306406157', 'ISBN-13: 978-0-306-40615-7']) {
      assert.isTrue(formatTesters.isbn13(text), text);
      assert.isTrue(isbn13(text), text);
    }
  });

  it('refuses an ISBN-13 with a wrong check digit, a foreign prefix or a malformed grouping', function () {
    for (const text of ['9780306406158', 'ISBN 978-0-306-40615-8', '9770306406157', '978030640615', '97803064061570', '978-0306-40615-7', '978-0-306-40615-']) {
      assert.isFalse(formatTesters.isbn13(text), text);
      assert.isFalse(isbn13(text), text);
    }
  });

  it('accepts the placeholders the form layer shows', function () {
    assert.isTrue(formatTesters.isbn10('0-306-40615-2'));
    assert.isTrue(formatTesters.isbn13('978-3-16-148410-0'));
  });
});
