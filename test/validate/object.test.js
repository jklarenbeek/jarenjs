/* eslint-disable no-useless-escape */
import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
} from '@jarenjs/validate';

// https://json-schema.org/understanding-json-schema/reference/object.html
const compiler = new JarenValidator();

describe('Schema Object Type', function () {
  describe('#objectPrimitives()', function () {
    it.skip('should throw an error when minProperties has a negative value??', function () {
      assert.throws(() => compiler.compile({
        type: 'object',
        minProperties: -1,
      }));
    });

    it('should throw an error when maxProperties is smaller then minProperties', function () {
      assert.throws(() => compiler.compile({
        type: 'object',
        minProperties: 3,
        maxProperties: 2,
      }));
    });

    it('should validate the object member size', function () {
      const validate = compiler.compile({
        type: 'object',
        minProperties: 2,
        maxProperties: 3,
      });

      assert.isFalse(validate(null), 'null object is not enough');
      assert.isFalse(validate({}), 'empty object is not enough');
      assert.isFalse(validate({ a: 0 }), 'single property is not enough');
      assert.isTrue(validate({ a: 0, b: 1 }), 'two properties are enough');
      assert.isTrue(validate({ a: 0, b: 1, c: 2 }), 'three properties are enough');
      assert.isFalse(validate({ a: 0, b: 1, c: 2, d: 3 }), 'four properties are to much');
    });

    it('should validate required properties of object', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          address: { type: 'string' },
          telephone: { type: 'string' },
        },
        required: ['name', 'email'],
      });

      assert.isTrue(validate({
        name: 'William Shakespeare',
        email: 'bill@stratford-upon-avon.co.uk',
      }), 'minimal required properties to validate');
      assert.isTrue(validate({
        name: 'William Shakespeare',
        email: 'bill@stratford-upon-avon.co.uk',
        address: 'Henley Street, Stratford-upon-Avon, Warwickshire, England',
        authorship: 'in question',
      }), 'required properties satisfied with addional properties');
      assert.isFalse(validate({
        name: 'William Shakespeare',
        address: 'Henley Street, Stratford-upon-Avon, Warwickshire, England',
      }), 'missing email address');
    });

    it('should not trigger with an map as type', function () {
      const validate = compiler.compile({ type: 'map' });
      assert.isFalse(validate({}), 'does not validate an object');
      // assert.isTrue(validate(new Map([
      //   [1, "one"],
      //   [2, "two"],
      //   [3, "three"],
      // ])));
    });
  });

  describe('#objectPropertyNames()', function () {
    it('should validate propertyNames with maxLength', function () {
      const validate = compiler.compile({ propertyNames: { maxLength: 3 } });

      assert.isTrue(validate({}), 'object without properties is valid');
      assert.isTrue(validate(['f', 'foo']), 'ignores array');
      assert.isTrue(validate('foobar'), 'ignores string');
      assert.isTrue(validate(42), 'ignores number');
      assert.isTrue(validate({ f: {}, foo: {} }), 'all property names valid');
      assert.isFalse(validate({ foo: {}, foobar: {} }), 'foobar is too long');
    });

    it('should validate propertyNames with regex identifier', function () {
      const validate = compiler.compile({
        type: 'object',
        propertyNames: {
          pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
        },
      });

      assert.isTrue(validate({ _a_proper_token_001: 'value' }), 'a valid id/key token');
      assert.isFalse(validate({ '001 invalid': 'key' }), 'an invalid id/key token');
    });

    it('should validate propertyNames with regex pattern', function () {
      const validate = compiler.compile({ propertyNames: { pattern: '^a+$' } });

      assert.isTrue(validate({}), 'object without properties is valid');
      assert.isTrue(validate({ a: {}, aa: {}, aaa: {} }), 'valid matching property names');
      assert.isFalse(validate({ aaA: {} }), 'invalid non-matching property name');
    });

    it('should validate propertyNames with boolean schema true', function () {
      const validate = compiler.compile({ propertyNames: true });

      assert.isTrue(validate({}), 'object without properties is valid');
      assert.isTrue(validate({ foo: 1 }), 'object with any properties is valid');
    });

    it('should validate propertyNames with boolean schema false', function () {
      const validate = compiler.compile({ propertyNames: false });

      assert.isTrue(validate({}), 'object without properties is valid');
      assert.isFalse(validate({ foo: 1 }), 'object with any properties is invalid');
    });
  });

  describe('#objectProperties()', function () {
    it('should validate true for unknown property names', function () {
      const validate = compiler.compile({
        properties: {
          number: { type: 'number' },
          street_name: { type: 'string' },
          street_type: { enum: ['Street', 'Avenue', 'Boulevard'] },
        },
      });

      assert.isTrue(validate({}), 'empty address object');
      assert.isTrue(validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue',
      }), 'valid typed address');
      assert.isFalse(validate({
        number: '1600', street_name: 'Pennsylvania', street_type: 'Avenue',
      }), 'invalid address number');
      assert.isTrue(validate({
        number: 1600, street_name: 'Pennsylvania',
      }), 'valid us address');
      assert.isTrue(validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue', direction: 'NW',
      }), 'additional properties is default true');
    });

    it('should validate properties with a boolean schema', function () {
      const validate = compiler.compile({
        properties: {
          foo: true,
          bar: false,
        },
      });

      assert.isTrue(validate({}), 'no property present is valid');
      assert.isTrue(validate({ foo: 1 }), 'only \'true\' property present is valid');
      assert.isFalse(validate({ bar: 2 }), 'only \'false\' property present is invalid');
      assert.isFalse(validate({ foo: 1, bar: 2 }), 'both properties present is invalid');
    });

    it('should validate properties with escaped characters', function () {
      const validate = compiler.compile({
        properties: {
          'foo\nbar': { type: 'number' },
          'foo"bar': { type: 'number' },
          'foo\\bar': { type: 'number' },
          'foo\rbar': { type: 'number' },
          'foo\tbar': { type: 'number' },
          'foo\fbar': { type: 'number' },
        },
      });

      assert.isTrue(validate({
        'foo\nbar': 1,
        'foo"bar': 1,
        'foo\\bar': 1,
        'foo\rbar': 1,
        'foo\tbar': 1,
        'foo\fbar': 1,
      }), 'object with all numbers is valid');
      assert.isFalse(validate({ 'foo\nbar': '1',
        'foo"bar': '1',
        'foo\\bar': '1',
        'foo\rbar': '1',
        'foo\tbar': '1',
        'foo\fbar': '1',
      }), 'object with strings is invalid');
    });

    it('should validate properties with null valued instance properties', function () {
      const validate = compiler.compile({
        properties: {
          foo: { type: 'null' },
        },
      });

      assert.isTrue(validate({ foo: null }), 'allows null values');
    });

    it.skip('should not validate properties whose names are Javascript object property names', function () {
      const validate = compiler.compile({
        properties: {
          __proto__: { type: 'number' }, // __proto__ is the one that I cannot fix atm.
          toString: {
            properties: { length: { type: 'string' } },
          },
          constructor: { type: 'number' },
        },
      });

      assert.isTrue(validate([]), 'ignores arrays');
      assert.isTrue(validate(12), 'ignores other non-objects');
      assert.isTrue(validate({}), 'none of the properties mentioned');
      assert.isTrue(validate({
        __proto__: 12,
        toString: { length: 'foo' },
        constructor: 37,
      }), 'all present and valid');
      assert.isFalse(validate({ __proto__: 'foo' }), '__proto__ not valid');
      assert.isFalse(validate({ toString: { length: 37 } }), 'toString not valid');
      assert.isFalse(validate({ constructor: { length: 37 } }), 'constructor not valid');
    });
  });

  describe('#objectPatternProperties()', function () {
    it('should validate patternProperties matching a regex', function () {
      const validate = compiler.compile({
        patternProperties: {
          'f.*o': { type: 'integer' },
        },
      });

      assert.isTrue(validate({ foo: 1 }), 'a single valid match is valid');
      assert.isTrue(validate({ foo: 1, foooooo: 2 }), 'multiple valid matches is valid');
      assert.isFalse(validate({ foo: 'bar', fooooo: 2 }), 'a single invalid match is invalid');
      assert.isFalse(validate({ foo: 'bar', foooooo: 'baz' }), 'multiple invalid matches is invalid');
      assert.isTrue(validate(['foo']), 'ignores arrays');
      assert.isTrue(validate('foo'), 'ignores strings');
      assert.isTrue(validate(42), 'ignores other non-objects');
    });

    it('should validate multiple simultaneous patternProperties', function () {
      const validate = compiler.compile({
        patternProperties: {
          'a*': { type: 'integer' },
          'aaa*': { maximum: 20 },
        },
      });

      assert.isTrue(validate({ a: 21 }), 'a single valid match is valid');
      assert.isTrue(validate({ aaaa: 18 }), 'a simultaneous match is valid');
      assert.isTrue(validate({ a: 21, aaaa: 18 }), 'multiple matches is valid');
      assert.isFalse(validate({ a: 'bar' }), 'an invalid due to one is invalid');
      assert.isFalse(validate({ aaaa: 31 }), 'an invalid due to the other is invalid');
      assert.isFalse(validate({ aaa: 'foo', aaaa: 31 }), 'an invalid due to both is invalid');
    });

    it('should test regexes are not anchored by default and are case sensitive', function () {
      const validate = compiler.compile({
        patternProperties: {
          '[0-9]{2,}': { type: 'boolean' },
          X_: { type: 'string' },
        },
      });

      assert.isTrue(validate({ 'answer 1': '42' }), 'non recognized members are ignored');
      assert.isFalse(validate({ a31b: null }), 'recognized members are accounted for');
      assert.isTrue(validate({ a_x_3: 3 }), 'regexes are case sensitive');
      assert.isFalse(validate({ a_X_3: 3 }), 'regexes are case sensitive, 2');
    });

    it('should test patternProperties with boolean schemas', function () {
      const validate = compiler.compile({
        patternProperties: {
          'f.*': true,
          'b.*': false,
        },
      });

      assert.isTrue(validate({ 'answer 1': '42' }), 'object with property matching schema true is valid');
      assert.isFalse(validate({ bar: 2 }), 'object with property matching schema false is invalid');
      assert.isFalse(validate({ foo: 1, bar: 2 }), 'object with both properties is invalid');
      assert.isFalse(validate({ foobar: 1 }), 'object with a property matching both true and false is invalid');
      assert.isTrue(validate({}), 'empty object is valid');
    });

    it('should test patternProperties with boolean schemas', function () {
      const validate = compiler.compile({
        patternProperties: {
          '^.*bar$': { type: 'null' },
        },
      });

      assert.isTrue(validate({ foobar: null }), 'allows null values');
    });

  });

  describe('#objectDependencies()', function () {
    it('should return true when there are no dependencies', function () {
      const validate = compiler.compile({ dependencies: {} });
      assert.isTrue(validate({}), 'neither');
      assert.isTrue(validate(['bar']), 'ignores array');
      assert.isTrue(validate('foobar'), 'ignores string');
      assert.isTrue(validate(12), 'ignores numbers');

      assert.isTrue(validate({ foo: 1, bar: 2, baz: 3 }), 'with dependencies');
      assert.isTrue(validate({ bar: 1 }), 'not a dependency');
      assert.isTrue(validate({ a: 1 }), 'without dependencies');
    });

    it('should validate with an empty array of dependencies required', function () {
      const validate = compiler.compile({
        dependencies: { bar: [] },
      });

      assert.isTrue(validate({}), 'neither');
      assert.isTrue(validate({ bar: 2 }), 'object with one property');
    });

    it('should validate simple dependencies required', function () {
      const validate = compiler.compile({
        dependencies: {
          foo: ['bar', 'baz'],
        },
      });

      assert.isTrue(validate({}), 'neither');
      assert.isTrue(validate(['bar']), 'ignores array');
      assert.isTrue(validate('foobar'), 'ignores string');
      assert.isTrue(validate(12), 'ignores numbers');

      assert.isTrue(validate({ foo: 1, bar: 2, baz: 3 }), 'with dependencies');
      assert.isTrue(validate({ bar: 1 }), 'not a dependency');
      assert.isTrue(validate({ a: 1 }), 'without dependencies');
      assert.isFalse(validate({ foo: 1 }), 'missing dependencies: bar & baz');
      assert.isFalse(validate({ foo: 1, bar: 2 }), 'missing dependency: baz');
      assert.isFalse(validate({ foo: 1, baz: 3 }), 'missing dependency: bar');
    });

    it('should validate dependencies required 1', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          name: { type: 'string' },
          credit_card: { type: 'number' },
          billing_address: { type: 'string' },
        },
        required: ['name'],
        dependencies: {
          credit_card: ['billing_address'],
        },
      });

      assert.isTrue(
        validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
          billing_address: '555 Debtor\'s Lane',
        }),
        'creditcard and billing address are present',
      );
      assert.isFalse(
        validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
        }),
        'credit card needs billing address',
      );
      assert.isTrue(
        validate({
          name: 'Joham Doe',
        }),
        'a single name is valid',
      );
      assert.isTrue(
        validate({
          name: 'Joham Doe',
          billing_address: '555 Debtor\'s Lane',
        }),
        'a name with billing address is valid',
      );
    });

    it('should validate dependencies required 2', function () {
      const validate = compiler.compile({
        dependencies: { quux: ['foo', 'bar'] },
      });

      assert.isTrue(validate({}), 'neither');
      assert.isTrue(validate({ foo: 1, bar: 2 }), 'nondependent');
      assert.isTrue(validate({ foo: 1, bar: 2, quux: 3 }), 'with dependencies');
      assert.isFalse(validate({ foo: 1, quux: 3 }), 'missing bar dependency');
      assert.isFalse(validate({ bar: 1, quux: 3 }), 'missing foo dependency');
      assert.isFalse(validate({ quux: 3 }), 'missing both dependencies');
    });

    it('should validate dependencies required 3', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          name: { type: 'string' },
          credit_card: { type: 'number' },
          billing_address: { type: 'string' },
        },
        required: ['name'],
        dependencies: {
          credit_card: ['billing_address'],
          billing_address: ['credit_card'],
        },
      });

      assert.isTrue(
        validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
          billing_address: '555 Debtor\'s Lane',
        }),
        'creditcard and billing address are present',
      );
      assert.isFalse(
        validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
        }),
        'creditcard needs billing address',
      );
      assert.isFalse(
        validate({
          name: 'Joham Doe',
          billing_address: '555 Debtor\'s Lane',
        }),
        'a billing address needs a creditcard',
      );

    });

    it('should validate a single dependencies schema', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          name: { type: 'string' },
          credit_card: { type: 'number' },
        },
        required: ['name'],
        dependencies: {
          credit_card: {
            properties: {
              billing_address: { type: 'string' },
            },
            required: ['billing_address'],
          },
        },
      });

      assert.isTrue(
        validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
          billing_address: '555 Debtor\'s Lane',
        }),
        'creditcard and billing address are present',
      );
      assert.isFalse(
        validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
        }),
        'creditcard needs billing address',
      );
      assert.isTrue(
        validate({
          name: 'Joham Doe',
          billing_address: '555 Debtor\'s Lane',
        }),
        'a billing address only is present',
      );

    });

    it('should validate with multiple dependency schemas', function () {
      const validate = compiler.compile({
        dependencies: {
          bar: {
            properties: {
              foo: { type: 'integer' },
              bar: { type: 'integer' },
            },
          },
        },
      });

      assert.isTrue(validate({ foo: 1, bar: 2 }), 'both properties are valid types');
      assert.isTrue(validate({ foo: 'quux' }), 'no dependency');
      assert.isFalse(validate({ foo: 'quux', bar: 2 }), 'wrong foo dependency');
      assert.isFalse(validate({ foo: 2, bar: 'quux' }), 'wrong bar dependency');
      assert.isFalse(validate({ foo: 'quux', bar: 'quux' }), 'wrong dependencies');
    });

    it('should validate with boolean dependency schemas', function () {
      const validate = compiler.compile({
        dependencies: {
          foo: true,
          bar: false,
        },
      });

      assert.isTrue(validate({ foo: 1 }), 'object with property having schema true is valid');
      assert.isFalse(validate({ bar: 2 }), 'object with property having schema false is invalid');
      assert.isFalse(validate({ foo: 1, bar: 2 }), 'object with both boolean properties is invalid');
      assert.isTrue(validate({}), 'empty object is valid');
    });

    it('should validate mixed dependencies with escape characters', function () {
      const validate = compiler.compile({
        dependencies: {
          'foo\nbar': ['foo\rbar'],
          'foo\tbar': {
            minProperties: 4,
          },
          'foo\'bar': { required: ['foo\"bar'] },
          'foo\"bar': ['foo\'bar'],
        },
      });

      assert.isTrue(validate({ 'foo\nbar': 1, 'foo\rbar': 2 }), 'object 1 is valid');
      assert.isTrue(validate({ 'foo\tbar': 1, a: 2, b: 3, c: 4 }), 'object 2 is valid');
      assert.isTrue(validate({ 'foo\'bar': 1, 'foo\"bar': 2 }), 'object 3 is valid');
      assert.isFalse(validate({ 'foo\nbar': 1, foo: 2 }), 'object 1 is invalid');
      assert.isFalse(validate({ 'foo\tbar': 1, a: 2 }), 'object 2 is invalid');
      assert.isFalse(validate({ 'foo\'bar': 1 }), 'object 3 is invalid');
      assert.isFalse(validate({ 'foo\"bar': 2 }), 'object 4 is invalid');
    });
  });

  describe('#objectDependentRequired()', function () {
    it('should return true when dependentRequired is empty', function () {
      const validate = compiler.compile({ dependentRequired: {} });
      assert.isTrue(validate({}), 'neither');
      assert.isTrue(validate(['bar']), 'ignores array');
      assert.isTrue(validate('foobar'), 'ignores string');
      assert.isTrue(validate(12), 'ignores numbers');

      assert.isTrue(validate({ foo: 1, bar: 2, baz: 3 }), 'with dependencies');
      assert.isTrue(validate({ bar: 1 }), 'not a dependency');
      assert.isTrue(validate({ a: 1 }), 'without dependencies');
    });

    it('should validate with an empty array of dependencies required', function () {
      const validate = compiler.compile({
        dependentRequired: { bar: [] },
      });

      assert.isTrue(validate({}), 'neither');
      assert.isTrue(validate({ bar: 2 }), 'object with one property');
    });

    it('should validate a simple dependentRequired property', function () {
      const validate = compiler.compile({
        $id: 'https://example.com/conditional-validation-dependentRequired.schema.json',
        title: 'Conditional Validation with dependentRequired',
        type: 'object',
        properties: {
          foo: {
            type: 'boolean',
          },
          bar: {
            type: 'string',
          },
        },
        dependentRequired: {
          foo: ['bar'],
        },
      });


      assert.isTrue(validate({
        foo: true,
        bar: 'Hello World',
      }), 'validates a dependency requirement');

      assert.isTrue(validate({}), 'validates since both foo and bar are missing');
      assert.isFalse(validate({ foo: true }), 'does not validate since bar is missing');
    });

    it('should validate dependentRequired 1', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          name: { type: 'string' },
          credit_card: { type: 'number' },
          billing_address: { type: 'string' },
        },
        required: ['name'],
        dependentRequired: {
          credit_card: ['billing_address'],
        },
      });

      assert.isTrue(
        validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
          billing_address: '555 Debtor\'s Lane',
        }),
        'creditcard and billing address are present',
      );
      assert.isFalse(
        validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
        }),
        'credit card needs billing address',
      );
      assert.isTrue(
        validate({
          name: 'Joham Doe',
        }),
        'a single name is valid',
      );
      assert.isTrue(
        validate({
          name: 'Joham Doe',
          billing_address: '555 Debtor\'s Lane',
        }),
        'a name with billing address is valid',
      );
    });

    it('should validate dependentRequired 2', function () {
      const validate = compiler.compile({
        dependentRequired: { quux: ['foo', 'bar'] },
      });

      assert.isTrue(validate({}), 'neither');
      assert.isTrue(validate({ foo: 1, bar: 2 }), 'nondependent');
      assert.isTrue(validate({ foo: 1, bar: 2, quux: 3 }), 'with dependencies');
      assert.isFalse(validate({ foo: 1, quux: 3 }), 'missing bar dependency');
      assert.isFalse(validate({ bar: 1, quux: 3 }), 'missing foo dependency');
      assert.isFalse(validate({ quux: 3 }), 'missing both dependencies');
    });

    it('should validate dependentRequired 3', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          name: { type: 'string' },
          credit_card: { type: 'number' },
          billing_address: { type: 'string' },
        },
        required: ['name'],
        dependentRequired: {
          credit_card: ['billing_address'],
          billing_address: ['credit_card'],
        },
      });

      assert.isTrue(
        validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
          billing_address: '555 Debtor\'s Lane',
        }),
        'creditcard and billing address are present',
      );
      assert.isFalse(
        validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
        }),
        'creditcard needs billing address',
      );
      assert.isFalse(
        validate({
          name: 'Joham Doe',
          billing_address: '555 Debtor\'s Lane',
        }),
        'a billing address needs a creditcard',
      );

    });

    it('should validate mixed properties with escape characters', function () {
      const validate = compiler.compile({
        dependentRequired: {
          'foo\nbar': ['foo\rbar'],
          'foo\"bar': ['foo\'bar'],
        },
      });

      assert.isTrue(validate({ 'foo\nbar': 1, 'foo\rbar': 2 }), 'object 1 is valid');
      assert.isTrue(validate({ 'foo\tbar': 1, a: 2, b: 3, c: 4 }), 'object 2 is valid');
      assert.isTrue(validate({ 'foo\'bar': 1, 'foo\"bar': 2 }), 'object 3 is valid');
      assert.isFalse(validate({ 'foo\nbar': 1, foo: 2 }), 'object 1 is invalid');
      assert.isFalse(validate({ 'foo\"bar': 2 }), 'object 2 is invalid');
    });

  });

  describe('#objectDependantSchemas()', function () {
    it('should return true when dependentSchemas is empty', function () {
      const validate = compiler.compile({ dependentSchemas: {} });
      assert.isTrue(validate({}), 'neither');
      assert.isTrue(validate(['bar']), 'ignores array');
      assert.isTrue(validate('foobar'), 'ignores string');
      assert.isTrue(validate(12), 'ignores numbers');

      assert.isTrue(validate({ foo: 1, bar: 2, baz: 3 }), 'with dependencies');
      assert.isTrue(validate({ bar: 1 }), 'not a dependency');
      assert.isTrue(validate({ a: 1 }), 'without dependencies');
    });

    it('should validate a single dependentSchemas 1', function () {
      const validate = compiler.compile({
        $id: 'https://example.com/conditional-validation-dependentSchemas.schema.json',
        title: 'Conditional Validation with dependentSchemas',
        type: 'object',
        properties: {
          foo: {
            type: 'boolean',
          },
          propertiesCount: {
            type: 'integer',
            minimum: 0,
          },
        },
        dependentSchemas: {
          foo: {
            properties: {
              propertiesCount: {
                minimum: 7,
              },
            },
            required: ['propertiesCount'],
          },
        },
      });

      assert.isTrue(validate({
        foo: true,
        propertiesCount: 10,
      }), 'when foo is present propertiesCount is required');

      assert.isTrue(validate({
        propertiesCount: 5,
      }), 'propertiesCount need to be greater then or equal to 0');

      assert.isFalse(validate({
        foo: true,
        propertiesCount: 5,
      }), 'propertiesCount must be equal or greater then 7');
    });

    it('should validate a single dependentSchemas 2', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          name: { type: 'string' },
          credit_card: { type: 'number' },
        },
        required: ['name'],
        dependencies: {
          credit_card: {
            properties: {
              billing_address: { type: 'string' },
            },
            required: ['billing_address'],
          },
        },
      });

      assert.isTrue(
        validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
          billing_address: '555 Debtor\'s Lane',
        }),
        'creditcard and billing address are present',
      );
      assert.isFalse(
        validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
        }),
        'creditcard needs billing address',
      );
      assert.isTrue(
        validate({
          name: 'Joham Doe',
          billing_address: '555 Debtor\'s Lane',
        }),
        'a billing address only is present',
      );

    });

    it('should validate with multiple dependentSchemas', function () {
      const validate = compiler.compile({
        dependentSchemas: {
          bar: {
            properties: {
              foo: { type: 'integer' },
              bar: { type: 'integer' },
            },
          },
        },
      });

      assert.isTrue(validate({ foo: 1, bar: 2 }), 'both properties are valid types');
      assert.isTrue(validate({ foo: 'quux' }), 'no dependency');
      assert.isFalse(validate({ foo: 'quux', bar: 2 }), 'wrong foo dependency');
      assert.isFalse(validate({ foo: 2, bar: 'quux' }), 'wrong bar dependency');
      assert.isFalse(validate({ foo: 'quux', bar: 'quux' }), 'wrong dependencies');
    });

    it('should validate with boolean dependency schemas', function () {
      const validate = compiler.compile({
        dependentSchemas: {
          foo: true,
          bar: false,
        },
      });

      assert.isTrue(validate({ foo: 1 }), 'object with property having schema true is valid');
      assert.isFalse(validate({ bar: 2 }), 'object with property having schema false is invalid');
      assert.isFalse(validate({ foo: 1, bar: 2 }), 'object with both boolean properties is invalid');
      assert.isTrue(validate({}), 'empty object is valid');
    });

    it('should validate mixed properties with escape characters', function () {
      const validate = compiler.compile({
        dependentSchemas: {
          'foo\tbar': { minProperties: 4 },
          'foo\'bar': { required: ['foo\"bar'] },
        },
      });

      assert.isTrue(validate({ 'foo\nbar': 1, 'foo\rbar': 2 }), 'object 1 is valid');
      assert.isTrue(validate({ 'foo\tbar': 1, a: 2, b: 3, c: 4 }), 'object 2 is valid');
      assert.isTrue(validate({ 'foo\'bar': 1, 'foo\"bar': 2 }), 'object 3 is valid');
      assert.isFalse(validate({ 'foo\tbar': 1, a: 2 }), 'object 1 is invalid');
      assert.isFalse(validate({ 'foo\'bar': 1 }), 'object 2 is invalid');
    });
  });

  describe('#objectAdditionalProperties()', function () {
    it('should validate object prohibiting additionalProperties', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          number: { type: 'number' },
          street_name: { type: 'string' },
          street_type: { enum: ['Street', 'Avenue', 'Boulevard'] },
        },
        additionalProperties: false,
      });

      assert.isTrue(validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue',
      }), 'valid typed address');
      assert.isFalse(validate({
        number: '1600', street_name: 'Pennsylvania', street_type: 'Avenue', direction: 'NW',
      }), 'number is of wrong type and invalid property direction');
      assert.isFalse(validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue', direction: 'NW',
      }), 'invalid property direction');

    });

    it('should validate object with typed additionalProperties', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          number: { type: 'number' },
          street_name: { type: 'string' },
          street_type: { enum: ['Street', 'Avenue', 'Boulevard'] },
        },
        additionalProperties: {
          type: 'string',
        },
      });

      assert.isTrue(validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue',
      }), 'valid typed address');
      assert.isTrue(validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue', direction: 'NW',
      }), 'valid typed address with typed additionalProperties');
      assert.isFalse(validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue', office_number: 201,
      }), 'invalid address wrongly typed additionalProperties');


    });

    it('should validate patternProperties with no additionalItems', function () {
      const validate = compiler.compile({
        patternProperties: {
          '^S_': { type: 'string' },
          '^I_': { type: 'integer' },
        },
        additionalProperties: false,
      });

      assert.isTrue(validate({ S_25: 'This is a string' }), 'key within pattern with string value');
      assert.isTrue(validate({ I_42: 42 }), 'key within pattern with integer value');
      assert.isFalse(validate({ S_0: 108 }), 'key with pattern but wrong value type');
      assert.isFalse(validate({ I_42: '42' }), 'key integer within pattern but wrong value type');
      assert.isFalse(validate({ keyword: 42 }), 'additionalItem doesnt allow number');
      assert.isFalse(validate({ keyword: 'value' }), 'additionalItems doesnt allow string');
    });

    it('should validate a combination of properties, patternProperties and additionalProperties', function () {
      const validate = compiler.compile({
        properties: {
          buildin: { type: 'number' },
        },
        patternProperties: {
          '^S_': { type: 'string' },
          '^I_': { type: 'integer' },
        },
        additionalProperties: {
          type: 'string',
        },
      });

      assert.isTrue(validate({ buildin: 5 }), 'buildin property is number type');
      assert.isTrue(validate({ S_25: 'This is a string' }), 'key within pattern with string value');
      assert.isTrue(validate({ I_42: 42 }), 'key within integer pattern with integer value');
      assert.isTrue(validate({ keyword: 'value' }), 'is of additionalProperties type string');
      assert.isFalse(validate({ S_0: 108 }), 'key within string pattern but wrong value type');
      assert.isFalse(validate({ I_42: '42' }), 'key within integer pattern but wrong value type');
      assert.isFalse(validate({ keyword: 42 }), 'invalid additionalProperties should be string.');
    });
  });

  describe('objectUnevaluatedProperties()', function () {
    it('unevaluatedProperties is true', function () {
      const validate = compiler.compile({
        type: 'object',
        unevaluatedProperties: true,
      });
      assert.isTrue(validate({}), 'with no unevaluated properties');
      assert.isTrue(validate({ foo: 'foo' }), 'with unevaluated properties');
    });

    it.skip('unevaluatedProperties with schema', function () {
      const validate = compiler.compile({ type: 'object',
        unevaluatedProperties: {
          type: 'string',
          minLength: 3,
        },
      });
      assert.isTrue(validate({}), 'with no unevaluated properties');
      assert.isTrue(validate({ foo: 'foo' }), 'with a valid unevaluated properties');
      assert.isFalse(validate({ foo: 'fo' }), 'with invalid unevaluated properties');
      assert.isFalse(validate({ foo: 42 }), 'with invalid unevaluated number property');
    });

    it('should have no unevaluatedProperties', function () {
      const validate = compiler.compile({
        type: 'object',
        unevaluatedProperties: false,
      });
      assert.isTrue(validate({}), 'with no unevaluated properties');
      assert.isFalse(validate({ foo: 'foo' }), 'with unevaluated properties');
    });

    it.skip('should validate properties with no adjacent unevaluatedProperties', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        unevaluatedProperties: false,
      });
      assert.isTrue(validate({ foo: 'foo' }), 'with no unevaluated properties');
      assert.isFalse(validate({ foo: 42 }), 'with no number property called foo');
      assert.isFalse(validate({ foo: 'foo', bar: 'bar' }), 'with unevaluated properties');
    });

    it.skip('should validate patternProperties with no adjacent unevaluatedProperties', function () {
      const validate = compiler.compile({
        type: 'object',
        patternProperties: {
          '^foo': { type: 'string' },
        },
        unevaluatedProperties: false,
      });
      assert.isTrue(validate({ foo: 'foo' }), 'with no unevaluated properties');
      assert.isFalse(validate({ foo: 'foo', bar: 'bar' }), 'with unevaluated properties');
    });

    it('should validate additionalProperties with no adjacent unevaluatedProperties', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        additionalProperties: true,
        unevaluatedProperties: false,
      });
      assert.isTrue(validate({ foo: 'foo' }), 'with no additional properties');
      assert.isFalse(validate({ foo: 12 }), 'Invalid type. Expected String but got Integer');
      assert.isTrue(validate({ foo: 'foo', bar: 'bar' }), 'with additional properties');
    });

    it.skip('should validate unevaluatedProperties with allOf nested properties', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        allOf: [
          { properties: { bar: { type: 'string' } } },
        ],
        unevaluatedProperties: false,
      });
      assert.isTrue(validate({ foo: 'foo', bar: 'bar' }), 'with no unevaluated properties');
      assert.isFalse(validate({ foo: 'foo', bar: 'bar', baz: 'baz' }), 'with unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with allOf nested patternProperties', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        allOf: [
          { patternProperties: { '^bar': { type: 'string' } } },
        ],
        unevaluatedProperties: false,
      });
      assert.isTrue(validate({ foo: 'foo', bar: 'bar' }), 'with no unevaluated properties');
      assert.isFalse(validate({ foo: 'foo', bar: 'bar', baz: 'baz' }), 'with unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with allOf nested additionalProperties', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        allOf: [
          { additionalProperties: true },
        ],
        unevaluatedProperties: false,
      });
      assert.isTrue(validate({ foo: 'foo' }), 'with no additional properties');
      assert.isTrue(validate({ foo: 'foo', bar: 'bar' }), 'with additional properties');
    });

    it.skip('should validate unevaluatedProperties with anyOf nested properties', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        allOf: [
          {
            properties: {
              bar: { const: 'bar' },
            },
            required: ['bar'],
          },
          {
            properties: {
              baz: { const: 'baz' },
            },
            required: ['baz'],
          },
          {
            properties: {
              quux: { const: 'quux' },
            },
            required: ['quux'],
          },
        ],
        unevaluatedProperties: false,
      });
      assert.isTrue(validate({ foo: 'foo', bar: 'bar' }), 'when one matches and has no unevaluated properties');
      assert.isFalse(validate({ foo: 'foo', bar: 'bar', baz: 'not-baz' }), 'when one matches and has unevaluated properties');
      assert.isTrue(validate({ foo: 'foo', bar: 'bar', baz: 'baz' }), 'when two match and has no unevaluated properties');
      assert.isFalse(validate({ foo: 'foo', bar: 'bar', baz: 'baz', quux: 'not-quux' }), 'when two match and has unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with oneOf nested properties', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        oneOf: [
          {
            properties: {
              bar: { const: 'bar' },
            },
            required: ['bar'],
          },
          {
            properties: {
              baz: { const: 'baz' },
            },
            required: ['baz'],
          },
        ],
        unevaluatedProperties: false,
      });
      assert.isTrue(validate({ foo: 'foo', bar: 'bar' }), 'when one matches and has no unevaluated properties');
      assert.isFalse(validate({ foo: 'foo', bar: 'bar', quux: 'quux' }), 'when one matches and has unevaluated properties');
      assert.isFalse(validate({ foo: 'foo', bar: 'bar', baz: 'baz' }), 'when two matches and has no unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with nested not', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        not: {
          not: {
            properties: {
              bar: { const: 'bar' },
            },
            required: ['bar'],
          },
        },
        unevaluatedProperties: false,
      });

      assert.isFalse(validate({ foo: 'foo', bar: 'bar' }), 'with unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with if/then/else', function () {
      const validate = compiler.compile({
        type: 'object',
        if: {
          properties: {
            foo: { const: 'then' },
          },
          required: ['foo'],
        },
        then: {
          properties: {
            bar: { type: 'string' },
          },
          required: ['bar'],
        },
        else: {
          properties: {
            baz: { type: 'string' },
          },
          required: ['baz'],
        },
        unevaluatedProperties: false,
      });

      assert.isTrue(validate({ foo: 'then', bar: 'bar' }), 'when if is true and has no unevaluated properties');
      assert.isFalse(validate({ foo: 'then', bar: 'bar', baz: 'baz' }), 'when if is true and has unevaluated properties');
      assert.isTrue(validate({ baz: 'baz' }), 'when if is false and has no unevaluated properties');
      assert.isFalse(validate({ foo: 'else', baz: 'baz' }), 'when if is false and has unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with if/else', function () {
      const validate = compiler.compile({
        type: 'object',
        if: {
          properties: {
            foo: { const: 'then' },
          },
          required: ['foo'],
        },
        else: {
          properties: {
            baz: { type: 'string' },
          },
          required: ['baz'],
        },
        unevaluatedProperties: false,
      });

      // TODO: i dont think these assertions are all right.
      assert.isFalse(validate({ foo: 'then', bar: 'bar' }), 'when if is true and has unevaluated property bar');
      assert.isFalse(validate({ foo: 'then', baz: 'baz' }), 'when if is true and has unevaluated properties baz');
      assert.isFalse(validate({ foo: 'then', bar: 'bar', baz: 'baz' }), 'when if is true and has unevaluated properties');
      assert.isTrue(validate({ baz: 'baz' }), 'when if is false and has no unevaluated properties');
      // TODO: sorry what? why? foo is not marked as evaluated? maybe cause foo is false in this matter.
      assert.isFalse(validate({ foo: 'else', baz: 'baz' }), 'when if is false and has unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with if/then', function () {
      const validate = compiler.compile({
        type: 'object',
        if: {
          properties: {
            foo: { const: 'then' },
          },
          required: ['foo'],
        },
        then: {
          properties: {
            bar: { type: 'string' },
          },
          required: ['bar'],
        },
        unevaluatedProperties: false,
      });

      assert.isTrue(validate({ foo: 'then', bar: 'bar' }), 'when if is true and has no unevaluated properties');
      assert.isFalse(validate({ foo: 'then', bar: 'bar', baz: 'baz' }), 'when if is true and has unevaluated properties baz');
      assert.isFalse(validate({ baz: 'baz' }), 'when if is false and has unevaluated properties');
      assert.isFalse(validate({ foo: 'else', baz: 'baz' }), 'when if is false and has unevaluated properties');
    });

    it.skip('should do something with anyOf unevaluated items', function () {
      const validate = compiler.compile({
        type: 'object',
        required: ['foo'],
        properties: { foo: { type: 'number' } },
        unevaluatedProperties: false,
        anyOf: [
          {
            required: ['bar'],
            properties: { bar: { type: 'number' } },
          },
          {
            required: ['baz'],
            properties: { baz: { type: 'number' } },
          },
        ],
      });

      assert.isTrue(validate({ foo: 1, bar: 2 }), 'foo and bar are evaluated');
      assert.isTrue(validate({ foo: 1, baz: 3 }), 'foo and baz are evaluated');
      assert.isTrue(validate({ foo: 1, bar: 2, baz: 3 }), 'foo, bar and baz are evaluated');
      assert.isFalse(validate({ foo: 1 }), 'neither bar nor baz are present');
      assert.isFalse(validate({ foo: 1, bar: 2, boo: 3 }), 'boo is unevaluated');
      assert.isFalse(validate({ foo: 1, bar: 2, baz: '3' }), 'not valid against the 2nd subschema, so baz is unevaluated');

    });

    it.skip('should be able to extend an address with type with allOf', function () {
      const validate = compiler.compile({
        allOf: [
          {
            type: 'object',
            properties: {
              street_address: { type: 'string' },
              city: { type: 'string' },
              state: { type: 'string' },
            },
            required: ['street_address', 'city', 'state'],
          },
        ],
        properties: {
          type: { enum: ['residential', 'business'] },
        },
        required: ['type'],
        unevaluatedProperties: false,
      });

      assert.isTrue(validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
      }), 'address without type is valid');
      assert.isTrue(validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
        type: 'business',
      }), 'address with type is valid');
      assert.isFalse(validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
        type: 'business',
        "something that doesn't belong": 'hi!',
      }), 'any other property not defined is not allowed');
    });

    it.skip('should allow the department property only if the type of address is business', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          street_address: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
          type: { enum: ['residential', 'business'] },
        },
        required: ['street_address', 'city', 'state', 'type'],

        if: {
          type: 'object',
          properties: {
            type: { const: 'business' },
          },
          required: ['type'],
        },
        then: {
          properties: {
            department: { type: 'string' },
          },
        },

        unevaluatedProperties: false,
      });
      assert.isTrue(validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
        type: 'business',
        department: 'HR',
      }), 'business address has a valid department');
      assert.isFalse(validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
        type: 'residential',
        department: 'HR',
      }), 'residential address doesnt allow a department');
    });

    it.skip('should validate inheritance example for issue #556', function () {
      const validate = compiler.compile({
        title: 'Vehicle',
        type: 'object',
        oneOf: [
          {
            typeOf: 'Car',
            required: ['wheels', 'headlights'],
            properties: {
              wheels: {},
              headlights: {},
            },
          },
          {
            typeOf: 'Boat',
            required: ['pontoons'],
            properties: {
              pontoons: {},
            },
          },
          {
            typeOf: 'Plane',
            required: ['wings'],
            properties: {
              wings: {},
            },
          },
        ],
        unevaluatedProperties: false,
      });

      assert.isTrue(validate({ pontoons: 'pontoons' }), 'is a boat, but not a car or a plane.');
      assert.isFalse(validate({ pontoons: 'pontoons', wheels: 'wheels' }), 'is a boat with an unevaluated property wheels');
    });

    it.skip('should validate example schema for (A | B) & (C | D) issue #86', function () {
      const validate = compiler.compile({
        $ref: '#/$defs/root',
        $defs: {
          root: {
            allOf: [
              {
                oneOf: [
                  { $ref: '#/$defs/a' },
                  { $ref: '#/$defs/b' },
                ],
              },
              {
                oneOf: [
                  { $ref: '#/$defs/c' },
                  { $ref: '#/$defs/d' },
                ],
              },
            ],
            unevaluatedProperties: false,
          },
          a: {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['a'],
          },
          b: {
            type: 'object',
            properties: { b: { type: 'string' } },
            required: ['b'],
          },
          c: {
            type: 'object',
            properties: { c: { type: 'string' } },
            required: ['c'],
          },
          d: {
            type: 'object',
            properties: { d: { type: 'string' } },
            required: ['d'],
          },
        },
      });

      assert.isTrue(validate({ a: 'a', c: 'c' }), 'valid A & C');
      assert.isTrue(validate({ b: 'b', c: 'c' }), 'valid B & C');
      assert.isFalse(validate({ a: 'a', b: 'b', c: 'c' }), 'invalid A & B & C');
      assert.isFalse(validate({ a: 'a', c: 'c', e: 'e' }), 'invalid unevaluated property E');
    });
  });
});
