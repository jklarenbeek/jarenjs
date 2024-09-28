import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';


import {
  JarenValidator,
} from '@jarenjs/validate';

// https://json-schema.org/understanding-json-schema/reference/string.html
const compiler = new JarenValidator()

describe('Schema String Type', function () {

  describe('#stringBasic()', function () {
    it('should validate type: \'string\'', function () {
      const validate = compiler.compile({ type: 'string' });

      assert.isFalse(validate(null), 'not validates null');
      assert.isTrue(validate('Déjà vu'), 'validates a string with accents');
      assert.isTrue(validate(''), 'validates an empty string');
      assert.isFalse(validate(42), 'not validates a number');
    });

    it('should validate type: \'string\', minLength: 2, maxLength: 3,', function () {
      const validate = compiler.compile({
        type: 'string',
        minLength: 2,
        maxLength: 3,
      });

      assert.isFalse(validate('A'), 'A string is too small');
      assert.isTrue(validate('AB'), 'AB string has valid length');
      assert.isTrue(validate('ABC'), 'ABC string has valid length');
      assert.isFalse(validate('ABCD'), 'ABCD is to long');
    });

    it('should throw an error on invalid pattern', function () {
      assert.throws(() => compiler.compile({
        type: 'string',
        pattern: 1234,
      }));
    });

    it('should validate type: \'string\', pattern: \'^.*$\'', function () {
      const validate = compiler.compile({
        type: 'string',
        pattern: '^(\\([0-9]{3}\\))?[0-9]{3}-[0-9]{4}$',
      });

      assert.isTrue(validate('555-1212'), '555-1212 is a local phonenumber');
      assert.isTrue(validate('(888)555-1212'), 'is valid phonenumber with area code');
      assert.isFalse(validate('(888)555-1212 ext. 532'), 'is not valid phonenumber with extension');
      assert.isFalse(validate('(800)FLOWERS'), 'is not valid phonenumber by letters');
    });

    it('should validate type: \'string\', pattern: \'/^.*$/i\'', function () {
      const validate = compiler.compile({
        type: 'string',
        pattern: '/^(\\([0-9]{3}\\))?[0-9]{3}-[0-9]{4}$/',
      });

      assert.isTrue(validate('555-1212'), '555-1212 is a local phonenumber');
      assert.isTrue(validate('(888)555-1212'), 'is valid phonenumber with area code');
      assert.isFalse(validate('(888)555-1212 ext. 532'), 'is not valid phonenumber with extension');
      assert.isFalse(validate('(800)FLOWERS'), 'is not valid phonenumber by letters');
    });

    it('should validate type: \'string\', pattern: /^.*$/i', function () {
      const validate = compiler.compile({
        type: 'string',
        pattern: /^(\([0-9]{3}\))?[0-9]{3}-[0-9]{4}$/,
      });

      assert.isTrue(validate('555-1212'), '555-1212 is a local phonenumber');
      assert.isTrue(validate('(888)555-1212'), 'is valid phonenumber with area code');
      assert.isFalse(validate('(888)555-1212 ext. 532'), 'is not valid phonenumber with extension');
      assert.isFalse(validate('(800)FLOWERS'), 'is not valid phonenumber by letters');

    });

  });

});
