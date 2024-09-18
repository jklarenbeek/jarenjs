import { describe, it } from 'node:test';
import * as assert from '@jaren/tools/assert';


import {
  compileSchemaValidator,
} from '@jaren/validate';

// https://json-schema.org/understanding-json-schema/reference/string.html

describe('Schema String Type', function () {

  describe('#stringBasic()', function () {
    it('should validate type: \'string\'', function () {
      const root = compileSchemaValidator({ type: 'string' });

      assert.isFalse(root.validate(null), 'not validates null');
      assert.isTrue(root.validate('Déjà vu'), 'validates a string with accents');
      assert.isTrue(root.validate(''), 'validates an empty string');
      assert.isFalse(root.validate(42), 'not validates a number');
    });

    it('should validate type: \'string\', minLength: 2, maxLength: 3,', function () {
      const root = compileSchemaValidator({
        type: 'string',
        minLength: 2,
        maxLength: 3,
      });

      assert.isFalse(root.validate('A'), 'A string is too small');
      assert.isTrue(root.validate('AB'), 'AB string has valid length');
      assert.isTrue(root.validate('ABC'), 'ABC string has valid length');
      assert.isFalse(root.validate('ABCD'), 'ABCD is to long');
    });

    it('should throw an error on invalid pattern', function () {
      assert.throws(() => compileSchemaValidator({
        type: 'string',
        pattern: 1234,
      }));
    });

    it('should validate type: \'string\', pattern: \'^.*$\'', function () {
      const root = compileSchemaValidator({
        type: 'string',
        pattern: '^(\\([0-9]{3}\\))?[0-9]{3}-[0-9]{4}$',
      });

      assert.isTrue(root.validate('555-1212'), '555-1212 is a local phonenumber');
      assert.isTrue(root.validate('(888)555-1212'), 'is valid phonenumber with area code');
      assert.isFalse(root.validate('(888)555-1212 ext. 532'), 'is not valid phonenumber with extension');
      assert.isFalse(root.validate('(800)FLOWERS'), 'is not valid phonenumber by letters');
    });

    it('should validate type: \'string\', pattern: \'/^.*$/i\'', function () {
      const root = compileSchemaValidator({
        type: 'string',
        pattern: '/^(\\([0-9]{3}\\))?[0-9]{3}-[0-9]{4}$/',
      });

      assert.isTrue(root.validate('555-1212'), '555-1212 is a local phonenumber');
      assert.isTrue(root.validate('(888)555-1212'), 'is valid phonenumber with area code');
      assert.isFalse(root.validate('(888)555-1212 ext. 532'), 'is not valid phonenumber with extension');
      assert.isFalse(root.validate('(800)FLOWERS'), 'is not valid phonenumber by letters');
    });

    it('should validate type: \'string\', pattern: /^.*$/i', function () {
      const root = compileSchemaValidator({
        type: 'string',
        pattern: /^(\([0-9]{3}\))?[0-9]{3}-[0-9]{4}$/,
      });

      assert.isTrue(root.validate('555-1212'), '555-1212 is a local phonenumber');
      assert.isTrue(root.validate('(888)555-1212'), 'is valid phonenumber with area code');
      assert.isFalse(root.validate('(888)555-1212 ext. 532'), 'is not valid phonenumber with extension');
      assert.isFalse(root.validate('(800)FLOWERS'), 'is not valid phonenumber by letters');

    });

  });

});
