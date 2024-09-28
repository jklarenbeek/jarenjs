import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
} from '@jarenjs/validate';

// from: https://json-schema.org/learn/miscellaneous-examples#conditional-validation-with-dependentrequired

const compiler = new JarenValidator();

describe('Schema $data Examples', function () {

  describe('#$data_reference()', function () {
    // $data reference is supported in the keywords:
    //  constant, enum, format, maximum / minimum,
    //  exclusiveMaximum / exclusiveMinimum, maxLength / minLength,
    //  maxItems / minItems, maxProperties / minProperties,
    //  formatMaximum / formatMinimum, formatExclusiveMaximum / formatExclusiveMinimum,
    //  multipleOf, pattern, required, uniqueItems.

    // The value of "$data" should be a relative JSON - pointer.

    it.skip('should validate a value in property smaller is less or equal then larger (not implemented)', function () {
      const validate = compiler.compile({
        properties: {
          smaller: {
            type: 'number',
            maximum: { $data: '1/larger' },
          },
          larger: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({
        smaller: 5,
        larger: 7,
      }));
    });

    it.skip('should validate the properties with same format ass their field names (not implemented)', function () {
      const validate = compiler.compile({
        additionalProperties: {
          type: 'string',
          format: { $data: '0#' },
        },
      });

      assert.isTrue(validate({
        'date-time': '1963-06-19T08:30:06.283185Z',
        email: 'joe.bloggs@example.com',
      }));

    });
  });
});
