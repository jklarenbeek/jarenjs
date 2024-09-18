import { describe, it } from 'node:test';
import * as assert from '@jaren/tools/assert';


import {
  compileSchemaValidator,
  registerFormatCompilers,
  ValidatorOptions
} from '@jaren/validate';

import * as formats from '@jaren/formats';

const options = new ValidatorOptions(
  registerFormatCompilers({}, formats.dateTimeFormats)
);

// https://json-schema.org/understanding-json-schema/reference/string.html

describe('Schema Date Formats', function () {

  describe('#formatDateTime()', function () {
    it('should validate format: \'date-time\', a RFC3339 date string', function () {
      const root = compileSchemaValidator({
        format: 'date-time'
      }, options);

      assert.isTrue(root.validate(undefined), 'ignore undefined');
      assert.isTrue(root.validate(null), 'ignore null');
      assert.isTrue(root.validate(true), 'ignore boolean type');
      assert.isTrue(root.validate(1), 'ignore number type');
      assert.isTrue(root.validate({}), 'ignore object type');
      assert.isTrue(root.validate([]), 'ignore array type');
      assert.isTrue(root.validate('1963-06-19T08:30:06.283185Z'), 'a valid date-time string');
      assert.isTrue(root.validate('1963-06-19T08:30:06Z'), 'a valid date-time string without second fraction');
      assert.isTrue(root.validate('1937-01-01T12:00:27.87+00:20'), 'a valid date-time string with plus offset');
      assert.isTrue(root.validate('1990-12-31T15:59:50.123-08:00'), 'a valid date-time string with minus offset');
      assert.isFalse(root.validate('1990-02-31T15:59:60.123-08:00'), 'an invalid day in date-time string');
      assert.isFalse(root.validate('1990-12-31T15:59:60-24:00'), 'an invalid offset in date-time string');
      assert.isFalse(root.validate('06/19/1963 08:30:06 PST'), 'an invalid date-time string');
      // assert.isTrue(root.validate('06/19/1963 08:30:06 PST'), 'a local date-time string');
      assert.isTrue(root.validate('1963-06-19t08:30:06.283185z'), 'case-insensitive T and Z');
      assert.isFalse(root.validate('2013-350T01:01:01'), 'only RFC3339 not all of ISO 8601 are valid');
    });
    it('should validate format: \'date-time\', formatMinimum', function () {
      const root = compileSchemaValidator({
        format: 'date-time',
        formatMinimum: '1975-01-17T09:30:02Z'
      }, options);

      assert.isTrue(root.validate(undefined), 'ignore undefined');
      assert.isTrue(root.validate(null), 'ignore null');
      assert.isTrue(root.validate(true), 'ignore boolean type');
      assert.isTrue(root.validate(1), 'ignore number type');
      assert.isTrue(root.validate({}), 'ignore object type');
      assert.isTrue(root.validate([]), 'ignore array type');
      assert.isTrue(root.validate('1975-01-17T09:30:02Z'), 'a valid exact minimum');
      assert.isTrue(root.validate(new Date(Date.parse('1975-01-17T09:30:02Z'))), 'a valid exact datetype minimum');
      assert.isTrue(root.validate('1981-10-01T15:12:11Z'), 'a valid minimum');
      assert.isTrue(root.validate(new Date(Date.parse('1981-10-01T15:12:11Z'))), 'a valid datetype minimum');
      assert.isFalse(root.validate('1974-02-12T05:33:24Z'), 'a datetime which is lesser then the minimum');
      assert.isFalse(root.validate(new Date(Date.parse('1974-02-12T05:33:24Z'))), 'a datetime datetype which is lesser then the minimum');
    });
    it('should validate format: \'date-time\', formatExclusiveMinimum', function () {
      const root = compileSchemaValidator({
        format: 'date-time',
        formatExclusiveMinimum: '1975-01-17T09:30:02Z'
      }, options);

      assert.isTrue(root.validate(undefined), 'ignore undefined');
      assert.isTrue(root.validate(null), 'ignore null');
      assert.isTrue(root.validate(true), 'ignore boolean type');
      assert.isTrue(root.validate(1), 'ignore number type');
      assert.isTrue(root.validate({}), 'ignore object type');
      assert.isTrue(root.validate([]), 'ignore array type');
      assert.isFalse(root.validate('1975-01-17T09:30:02Z'), 'an invalid exact minimum');
      assert.isFalse(root.validate(new Date(Date.parse('1975-01-17T09:30:02Z'))), 'an invalid datetype exact minimum');
      assert.isTrue(root.validate('1981-10-01T15:12:11Z'), 'a valid exclusive minimum');
      assert.isTrue(root.validate(new Date(Date.parse('1981-10-01T15:12:11Z'))), 'a valid datetype exclusive minimum');
      assert.isFalse(root.validate('1974-02-12T05:33:24Z'), 'a datetime which is lesser then the minimum');
      assert.isFalse(root.validate(new Date(Date.parse('1974-02-12T05:33:24Z'))), 'a datetype which is lesser then the minimum');
    });
    it('should validate format: \'date-time\', formatMaximum', function () {
      const root = compileSchemaValidator({
        format: 'date-time',
        formatMaximum: '1975-01-17T09:30:02Z'
      }, options);

      assert.isTrue(root.validate(undefined), 'ignore undefined');
      assert.isTrue(root.validate(null), 'ignore null');
      assert.isTrue(root.validate(true), 'ignore boolean type');
      assert.isTrue(root.validate(1), 'ignore number type');
      assert.isTrue(root.validate({}), 'ignore object type');
      assert.isTrue(root.validate([]), 'ignore array type');
      assert.isTrue(root.validate('1975-01-17T09:30:02Z'), 'a valid exact maximum');
      assert.isTrue(root.validate(new Date(Date.parse('1975-01-17T09:30:02Z'))), 'a valid exact datetype maximum');
      assert.isFalse(root.validate('1981-10-01T15:12:11Z'), 'an invalid maximum');
      assert.isFalse(root.validate(new Date(Date.parse('1981-10-01T15:12:11Z'))), 'an invalid datetype maximum');
      assert.isTrue(root.validate('1974-02-12T05:33:24Z'), 'a valid datetime under the maximum');
      assert.isTrue(root.validate(new Date(Date.parse('1974-02-12T05:33:24Z'))), 'a valid datetype under the maximum');
    });
    it('should validate format: \'date-time\', formatExclusiveMaximum', function () {
      const root = compileSchemaValidator({
        format: 'date-time',
        formatExclusiveMaximum: '1975-01-17T09:30:02Z'
      }, options);

      assert.isTrue(root.validate(undefined), 'ignore undefined');
      assert.isTrue(root.validate(null), 'ignore null');
      assert.isTrue(root.validate(true), 'ignore boolean type');
      assert.isTrue(root.validate(1), 'ignore number type');
      assert.isTrue(root.validate({}), 'ignore object type');
      assert.isTrue(root.validate([]), 'ignore array type');
      assert.isFalse(root.validate('1975-01-17T09:30:02Z'), 'an invalid exact maximum');
      assert.isFalse(root.validate(new Date(Date.parse('1975-01-17T09:30:02Z'))), 'an invalid datetype exact maximum');
      assert.isFalse(root.validate('1981-10-01T15:12:11Z'), 'an invalid exclusive maximum');
      assert.isFalse(root.validate(new Date(Date.parse('1981-10-01T15:12:11Z'))), 'an invalid datetype exclusive maximum');
      assert.isTrue(root.validate('1974-02-12T05:33:24Z'), 'a datetime which is lesser then the maximum');
      assert.isTrue(root.validate(new Date(Date.parse('1974-02-12T05:33:24Z'))), 'a datetype which is lesser then the maximum');
    });
    it('should validate format: \'date-time\', between minimum and maximum', function () {
      const root = compileSchemaValidator({
        format: 'date-time',
        formatMinimum: '1975-01-17T09:30:02Z',
        formatMaximum: '1981-10-01T15:22:45Z'
      }, options);

      assert.isTrue(root.validate(undefined), 'ignore undefined');
      assert.isTrue(root.validate(null), 'ignore null');
      assert.isTrue(root.validate(true), 'ignore boolean type');
      assert.isTrue(root.validate(1), 'ignore number type');
      assert.isTrue(root.validate({}), 'ignore object type');
      assert.isTrue(root.validate([]), 'ignore array type');
      assert.isTrue(root.validate('1975-01-17T09:30:02Z'), 'a valid exact minimum');
      assert.isTrue(root.validate(new Date(Date.parse('1975-01-17T09:30:02Z'))), 'a valid exact datetype minimum');
      assert.isTrue(root.validate('1981-10-01T15:22:45Z'), 'a valid maximum');
      assert.isTrue(root.validate(new Date(Date.parse('1981-10-01T15:22:45Z'))), 'a valid datetype maximum');
      assert.isFalse(root.validate('1974-02-12T05:33:24Z'), 'an invalid datetime under the minimum');
      assert.isFalse(root.validate(new Date(Date.parse('1974-02-12T05:33:24Z'))), 'an invalid datetype under the minimum');
      assert.isFalse(root.validate('1984-03-02T16:15:14Z'), 'an invalid datetime above the maximum');
      assert.isFalse(root.validate(new Date(Date.parse('1984-03-02T16:15:14Z'))), 'an invalid datetype above the maximum');
    });
  });

  describe('#formatDate()', function () {
    it('should validate format: \'date\',  a RFC3339 date string', function () {
      const root = compileSchemaValidator({
        format: 'date'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('1963-06-19'), 'a valid date string');
      assert.isFalse(root.validate('1963-6-19'), 'missing month digit');
      assert.isFalse(root.validate('06/19/1963'), 'a different valid date string');
      // assert.isFalse(root.validate('06/19/1963'), 'an invalid date string');
      assert.isFalse(root.validate('2013-350'), 'only RFC3339 not all of ISO 8601 are valid');
    });
  });

  describe('#formatTime()', function () {
    it('should validate format: \'time\', a RFC3339 date string', function () {
      const root = compileSchemaValidator({
        format: 'time'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('08:30:06Z'), 'a valid time string');
      assert.isTrue(root.validate('08:30:06.283185Z'), 'a valid time string with milliseconds');
      assert.isTrue(root.validate('08:30:06+01:00'), 'a valid time string with plus offset');
      assert.isTrue(root.validate('08:30:06.123+01:00'), 'a valid time string with millseconds and plus offset');
      assert.isTrue(root.validate('08:30:06-01:00'), 'a valid time string with min offset');
      assert.isFalse(root.validate('08:30:06'), 'an invalid time string without Z');
      assert.isFalse(root.validate('08:30:06 PST'), 'an invalid time string');
      assert.isFalse(root.validate('01:01:01,1111'), 'only RFC3339 not all of ISO 8601 are valid');
    });
  });
});
