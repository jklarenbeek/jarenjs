/* eslint-disable no-useless-escape */
import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  compileSchemaValidator,
} from '@jarenjs/validate';

// https://json-schema.org/understanding-json-schema/reference/object.html

describe('Schema Object Type', function () {
  describe('#objectPrimitives()', function () {
    it.skip('should throw an error when minProperties has a negative value??', function () {
      assert.throws(() => compileSchemaValidator({
        type: 'object',
        minProperties: -1,
      }));
    });

    it('should throw an error when maxProperties is smaller then minProperties', function () {
      assert.throws(() => compileSchemaValidator({
        type: 'object',
        minProperties: 3,
        maxProperties: 2,
      }));
    });

    it('should validate the object member size', function () {
      const root = compileSchemaValidator({
        type: 'object',
        minProperties: 2,
        maxProperties: 3,
      });

      assert.isFalse(root.validate(null), 'null object is not enough');
      assert.isFalse(root.validate({}), 'empty object is not enough');
      assert.isFalse(root.validate({ a: 0 }), 'single property is not enough');
      assert.isTrue(root.validate({ a: 0, b: 1 }), 'two properties are enough');
      assert.isTrue(root.validate({ a: 0, b: 1, c: 2 }), 'three properties are enough');
      assert.isFalse(root.validate({ a: 0, b: 1, c: 2, d: 3 }), 'four properties are to much');
    });

    it('should validate required properties of object', function () {
      const root = compileSchemaValidator({
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          address: { type: 'string' },
          telephone: { type: 'string' },
        },
        required: ['name', 'email'],
      });

      assert.isTrue(root.validate({
        name: 'William Shakespeare',
        email: 'bill@stratford-upon-avon.co.uk',
      }), 'minimal required properties to validate');
      assert.isTrue(root.validate({
        name: 'William Shakespeare',
        email: 'bill@stratford-upon-avon.co.uk',
        address: 'Henley Street, Stratford-upon-Avon, Warwickshire, England',
        authorship: 'in question',
      }), 'required properties satisfied with addional properties');
      assert.isFalse(root.validate({
        name: 'William Shakespeare',
        address: 'Henley Street, Stratford-upon-Avon, Warwickshire, England',
      }), 'missing email address');
    });

    it('should not trigger with an map as type', function () {
      const root = compileSchemaValidator({ type: 'map' });
      assert.isFalse(root.validate({}), 'does not validate an object');
      // assert.isTrue(root.validate(new Map([
      //   [1, "one"],
      //   [2, "two"],
      //   [3, "three"],
      // ])));
    });
  });

  describe('#objectPropertyNames()', function () {
    it('should validate propertyNames with maxLength', function () {
      const root = compileSchemaValidator({ propertyNames: { maxLength: 3 } });

      assert.isTrue(root.validate({}), 'object without properties is valid');
      assert.isTrue(root.validate(['f', 'foo']), 'ignores array');
      assert.isTrue(root.validate('foobar'), 'ignores string');
      assert.isTrue(root.validate(42), 'ignores number');
      assert.isTrue(root.validate({ f: {}, foo: {} }), 'all property names valid');
      assert.isFalse(root.validate({ foo: {}, foobar: {} }), 'foobar is too long');
    });

    it('should validate propertyNames with regex identifier', function () {
      const root = compileSchemaValidator({
        type: 'object',
        propertyNames: {
          pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
        },
      });

      assert.isTrue(root.validate({ _a_proper_token_001: 'value' }), 'a valid id/key token');
      assert.isFalse(root.validate({ '001 invalid': 'key' }), 'an invalid id/key token');
    });

    it('should validate propertyNames with regex pattern', function () {
      const root = compileSchemaValidator({ propertyNames: { pattern: '^a+$' } });

      assert.isTrue(root.validate({}), 'object without properties is valid');
      assert.isTrue(root.validate({ a: {}, aa: {}, aaa: {} }), 'valid matching property names');
      assert.isFalse(root.validate({ aaA: {} }), 'invalid non-matching property name');
    });

    it('should validate propertyNames with boolean schema true', function () {
      const root = compileSchemaValidator({ propertyNames: true });

      assert.isTrue(root.validate({}), 'object without properties is valid');
      assert.isTrue(root.validate({ foo: 1 }), 'object with any properties is valid');
    });

    it('should validate propertyNames with boolean schema false', function () {
      const root = compileSchemaValidator({ propertyNames: false });

      assert.isTrue(root.validate({}), 'object without properties is valid');
      assert.isFalse(root.validate({ foo: 1 }), 'object with any properties is invalid');
    });
  });

  describe('#objectProperties()', function () {
    it('should validate true for unknown property names', function () {
      const root = compileSchemaValidator({
        properties: {
          number: { type: 'number' },
          street_name: { type: 'string' },
          street_type: { enum: ['Street', 'Avenue', 'Boulevard'] },
        },
      });

      assert.isTrue(root.validate({}), 'empty address object');
      assert.isTrue(root.validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue',
      }), 'valid typed address');
      assert.isFalse(root.validate({
        number: '1600', street_name: 'Pennsylvania', street_type: 'Avenue',
      }), 'invalid address number');
      assert.isTrue(root.validate({
        number: 1600, street_name: 'Pennsylvania',
      }), 'valid us address');
      assert.isTrue(root.validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue', direction: 'NW',
      }), 'additional properties is default true');
    });

    it('should validate properties with a boolean schema', function () {
      const root = compileSchemaValidator({
        properties: {
          foo: true,
          bar: false,
        },
      });

      assert.isTrue(root.validate({}), 'no property present is valid');
      assert.isTrue(root.validate({ foo: 1 }), 'only \'true\' property present is valid');
      assert.isFalse(root.validate({ bar: 2 }), 'only \'false\' property present is invalid');
      assert.isFalse(root.validate({ foo: 1, bar: 2 }), 'both properties present is invalid');
    });

    it('should validate properties with escaped characters', function () {
      const root = compileSchemaValidator({
        properties: {
          'foo\nbar': { type: 'number' },
          'foo"bar': { type: 'number' },
          'foo\\bar': { type: 'number' },
          'foo\rbar': { type: 'number' },
          'foo\tbar': { type: 'number' },
          'foo\fbar': { type: 'number' },
        },
      });

      assert.isTrue(root.validate({
        'foo\nbar': 1,
        'foo"bar': 1,
        'foo\\bar': 1,
        'foo\rbar': 1,
        'foo\tbar': 1,
        'foo\fbar': 1,
      }), 'object with all numbers is valid');
      assert.isFalse(root.validate({ 'foo\nbar': '1',
        'foo"bar': '1',
        'foo\\bar': '1',
        'foo\rbar': '1',
        'foo\tbar': '1',
        'foo\fbar': '1',
      }), 'object with strings is invalid');
    });

    it('should validate properties with null valued instance properties', function () {
      const root = compileSchemaValidator({
        properties: {
          foo: { type: 'null' },
        },
      });

      assert.isTrue(root.validate({ foo: null }), 'allows null values');
    });

    it.skip('should not validate properties whose names are Javascript object property names', function () {
      const root = compileSchemaValidator({
        properties: {
          __proto__: { type: 'number' }, // __proto__ is the one that I cannot fix atm.
          toString: {
            properties: { length: { type: 'string' } },
          },
          constructor: { type: 'number' },
        },
      });

      assert.isTrue(root.validate([]), 'ignores arrays');
      assert.isTrue(root.validate(12), 'ignores other non-objects');
      assert.isTrue(root.validate({}), 'none of the properties mentioned');
      assert.isTrue(root.validate({
        __proto__: 12,
        toString: { length: 'foo' },
        constructor: 37,
      }), 'all present and valid');
      assert.isFalse(root.validate({ __proto__: 'foo' }), '__proto__ not valid');
      assert.isFalse(root.validate({ toString: { length: 37 } }), 'toString not valid');
      assert.isFalse(root.validate({ constructor: { length: 37 } }), 'constructor not valid');
    });
  });

  describe('#objectPatternProperties()', function () {
    it('should validate patternProperties matching a regex', function () {
      const root = compileSchemaValidator({
        patternProperties: {
          'f.*o': { type: 'integer' },
        },
      });

      assert.isTrue(root.validate({ foo: 1 }), 'a single valid match is valid');
      assert.isTrue(root.validate({ foo: 1, foooooo: 2 }), 'multiple valid matches is valid');
      assert.isFalse(root.validate({ foo: 'bar', fooooo: 2 }), 'a single invalid match is invalid');
      assert.isFalse(root.validate({ foo: 'bar', foooooo: 'baz' }), 'multiple invalid matches is invalid');
      assert.isTrue(root.validate(['foo']), 'ignores arrays');
      assert.isTrue(root.validate('foo'), 'ignores strings');
      assert.isTrue(root.validate(42), 'ignores other non-objects');
    });

    it('should validate multiple simultaneous patternProperties', function () {
      const root = compileSchemaValidator({
        patternProperties: {
          'a*': { type: 'integer' },
          'aaa*': { maximum: 20 },
        },
      });

      assert.isTrue(root.validate({ a: 21 }), 'a single valid match is valid');
      assert.isTrue(root.validate({ aaaa: 18 }), 'a simultaneous match is valid');
      assert.isTrue(root.validate({ a: 21, aaaa: 18 }), 'multiple matches is valid');
      assert.isFalse(root.validate({ a: 'bar' }), 'an invalid due to one is invalid');
      assert.isFalse(root.validate({ aaaa: 31 }), 'an invalid due to the other is invalid');
      assert.isFalse(root.validate({ aaa: 'foo', aaaa: 31 }), 'an invalid due to both is invalid');
    });

    it('should test regexes are not anchored by default and are case sensitive', function () {
      const root = compileSchemaValidator({
        patternProperties: {
          '[0-9]{2,}': { type: 'boolean' },
          X_: { type: 'string' },
        },
      });

      assert.isTrue(root.validate({ 'answer 1': '42' }), 'non recognized members are ignored');
      assert.isFalse(root.validate({ a31b: null }), 'recognized members are accounted for');
      assert.isTrue(root.validate({ a_x_3: 3 }), 'regexes are case sensitive');
      assert.isFalse(root.validate({ a_X_3: 3 }), 'regexes are case sensitive, 2');
    });

    it('should test patternProperties with boolean schemas', function () {
      const root = compileSchemaValidator({
        patternProperties: {
          'f.*': true,
          'b.*': false,
        },
      });

      assert.isTrue(root.validate({ 'answer 1': '42' }), 'object with property matching schema true is valid');
      assert.isFalse(root.validate({ bar: 2 }), 'object with property matching schema false is invalid');
      assert.isFalse(root.validate({ foo: 1, bar: 2 }), 'object with both properties is invalid');
      assert.isFalse(root.validate({ foobar: 1 }), 'object with a property matching both true and false is invalid');
      assert.isTrue(root.validate({}), 'empty object is valid');
    });

    it('should test patternProperties with boolean schemas', function () {
      const root = compileSchemaValidator({
        patternProperties: {
          '^.*bar$': { type: 'null' },
        },
      });

      assert.isTrue(root.validate({ foobar: null }), 'allows null values');
    });

  });

  describe('#objectDependencies()', function () {
    it('should return true when there are no dependencies', function () {
      const root = compileSchemaValidator({ dependencies: {} });
      assert.isTrue(root.validate({}), 'neither');
      assert.isTrue(root.validate(['bar']), 'ignores array');
      assert.isTrue(root.validate('foobar'), 'ignores string');
      assert.isTrue(root.validate(12), 'ignores numbers');

      assert.isTrue(root.validate({ foo: 1, bar: 2, baz: 3 }), 'with dependencies');
      assert.isTrue(root.validate({ bar: 1 }), 'not a dependency');
      assert.isTrue(root.validate({ a: 1 }), 'without dependencies');
    });

    it('should validate with an empty array of dependencies required', function () {
      const root = compileSchemaValidator({
        dependencies: { bar: [] },
      });

      assert.isTrue(root.validate({}), 'neither');
      assert.isTrue(root.validate({ bar: 2 }), 'object with one property');
    });

    it('should validate simple dependencies required', function () {
      const root = compileSchemaValidator({
        dependencies: {
          foo: ['bar', 'baz'],
        },
      });

      assert.isTrue(root.validate({}), 'neither');
      assert.isTrue(root.validate(['bar']), 'ignores array');
      assert.isTrue(root.validate('foobar'), 'ignores string');
      assert.isTrue(root.validate(12), 'ignores numbers');

      assert.isTrue(root.validate({ foo: 1, bar: 2, baz: 3 }), 'with dependencies');
      assert.isTrue(root.validate({ bar: 1 }), 'not a dependency');
      assert.isTrue(root.validate({ a: 1 }), 'without dependencies');
      assert.isFalse(root.validate({ foo: 1 }), 'missing dependencies: bar & baz');
      assert.isFalse(root.validate({ foo: 1, bar: 2 }), 'missing dependency: baz');
      assert.isFalse(root.validate({ foo: 1, baz: 3 }), 'missing dependency: bar');
    });

    it('should validate dependencies required 1', function () {
      const root = compileSchemaValidator({
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
        root.validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
          billing_address: '555 Debtor\'s Lane',
        }),
        'creditcard and billing address are present',
      );
      assert.isFalse(
        root.validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
        }),
        'credit card needs billing address',
      );
      assert.isTrue(
        root.validate({
          name: 'Joham Doe',
        }),
        'a single name is valid',
      );
      assert.isTrue(
        root.validate({
          name: 'Joham Doe',
          billing_address: '555 Debtor\'s Lane',
        }),
        'a name with billing address is valid',
      );
    });

    it('should validate dependencies required 2', function () {
      const root = compileSchemaValidator({
        dependencies: { quux: ['foo', 'bar'] },
      });

      assert.isTrue(root.validate({}), 'neither');
      assert.isTrue(root.validate({ foo: 1, bar: 2 }), 'nondependent');
      assert.isTrue(root.validate({ foo: 1, bar: 2, quux: 3 }), 'with dependencies');
      assert.isFalse(root.validate({ foo: 1, quux: 3 }), 'missing bar dependency');
      assert.isFalse(root.validate({ bar: 1, quux: 3 }), 'missing foo dependency');
      assert.isFalse(root.validate({ quux: 3 }), 'missing both dependencies');
    });

    it('should validate dependencies required 3', function () {
      const root = compileSchemaValidator({
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
        root.validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
          billing_address: '555 Debtor\'s Lane',
        }),
        'creditcard and billing address are present',
      );
      assert.isFalse(
        root.validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
        }),
        'creditcard needs billing address',
      );
      assert.isFalse(
        root.validate({
          name: 'Joham Doe',
          billing_address: '555 Debtor\'s Lane',
        }),
        'a billing address needs a creditcard',
      );

    });

    it('should validate a single dependencies schema', function () {
      const root = compileSchemaValidator({
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
        root.validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
          billing_address: '555 Debtor\'s Lane',
        }),
        'creditcard and billing address are present',
      );
      assert.isFalse(
        root.validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
        }),
        'creditcard needs billing address',
      );
      assert.isTrue(
        root.validate({
          name: 'Joham Doe',
          billing_address: '555 Debtor\'s Lane',
        }),
        'a billing address only is present',
      );

    });

    it('should validate with multiple dependency schemas', function () {
      const root = compileSchemaValidator({
        dependencies: {
          bar: {
            properties: {
              foo: { type: 'integer' },
              bar: { type: 'integer' },
            },
          },
        },
      });

      assert.isTrue(root.validate({ foo: 1, bar: 2 }), 'both properties are valid types');
      assert.isTrue(root.validate({ foo: 'quux' }), 'no dependency');
      assert.isFalse(root.validate({ foo: 'quux', bar: 2 }), 'wrong foo dependency');
      assert.isFalse(root.validate({ foo: 2, bar: 'quux' }), 'wrong bar dependency');
      assert.isFalse(root.validate({ foo: 'quux', bar: 'quux' }), 'wrong dependencies');
    });

    it('should validate with boolean dependency schemas', function () {
      const root = compileSchemaValidator({
        dependencies: {
          foo: true,
          bar: false,
        },
      });

      assert.isTrue(root.validate({ foo: 1 }), 'object with property having schema true is valid');
      assert.isFalse(root.validate({ bar: 2 }), 'object with property having schema false is invalid');
      assert.isFalse(root.validate({ foo: 1, bar: 2 }), 'object with both boolean properties is invalid');
      assert.isTrue(root.validate({}), 'empty object is valid');
    });

    it('should validate mixed dependencies with escape characters', function () {
      const root = compileSchemaValidator({
        dependencies: {
          'foo\nbar': ['foo\rbar'],
          'foo\tbar': {
            minProperties: 4,
          },
          'foo\'bar': { required: ['foo\"bar'] },
          'foo\"bar': ['foo\'bar'],
        },
      });

      assert.isTrue(root.validate({ 'foo\nbar': 1, 'foo\rbar': 2 }), 'object 1 is valid');
      assert.isTrue(root.validate({ 'foo\tbar': 1, a: 2, b: 3, c: 4 }), 'object 2 is valid');
      assert.isTrue(root.validate({ 'foo\'bar': 1, 'foo\"bar': 2 }), 'object 3 is valid');
      assert.isFalse(root.validate({ 'foo\nbar': 1, foo: 2 }), 'object 1 is invalid');
      assert.isFalse(root.validate({ 'foo\tbar': 1, a: 2 }), 'object 2 is invalid');
      assert.isFalse(root.validate({ 'foo\'bar': 1 }), 'object 3 is invalid');
      assert.isFalse(root.validate({ 'foo\"bar': 2 }), 'object 4 is invalid');
    });
  });

  describe('#objectDependentRequired()', function () {
    it('should return true when dependentRequired is empty', function () {
      const root = compileSchemaValidator({ dependentRequired: {} });
      assert.isTrue(root.validate({}), 'neither');
      assert.isTrue(root.validate(['bar']), 'ignores array');
      assert.isTrue(root.validate('foobar'), 'ignores string');
      assert.isTrue(root.validate(12), 'ignores numbers');

      assert.isTrue(root.validate({ foo: 1, bar: 2, baz: 3 }), 'with dependencies');
      assert.isTrue(root.validate({ bar: 1 }), 'not a dependency');
      assert.isTrue(root.validate({ a: 1 }), 'without dependencies');
    });

    it('should validate with an empty array of dependencies required', function () {
      const root = compileSchemaValidator({
        dependentRequired: { bar: [] },
      });

      assert.isTrue(root.validate({}), 'neither');
      assert.isTrue(root.validate({ bar: 2 }), 'object with one property');
    });

    it('should validate a simple dependentRequired property', function () {
      const root = compileSchemaValidator({
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


      assert.isTrue(root.validate({
        foo: true,
        bar: 'Hello World',
      }), 'validates a dependency requirement');

      assert.isTrue(root.validate({}), 'validates since both foo and bar are missing');
      assert.isFalse(root.validate({ foo: true }), 'does not validate since bar is missing');
    });

    it('should validate dependentRequired 1', function () {
      const root = compileSchemaValidator({
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
        root.validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
          billing_address: '555 Debtor\'s Lane',
        }),
        'creditcard and billing address are present',
      );
      assert.isFalse(
        root.validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
        }),
        'credit card needs billing address',
      );
      assert.isTrue(
        root.validate({
          name: 'Joham Doe',
        }),
        'a single name is valid',
      );
      assert.isTrue(
        root.validate({
          name: 'Joham Doe',
          billing_address: '555 Debtor\'s Lane',
        }),
        'a name with billing address is valid',
      );
    });

    it('should validate dependentRequired 2', function () {
      const root = compileSchemaValidator({
        dependentRequired: { quux: ['foo', 'bar'] },
      });

      assert.isTrue(root.validate({}), 'neither');
      assert.isTrue(root.validate({ foo: 1, bar: 2 }), 'nondependent');
      assert.isTrue(root.validate({ foo: 1, bar: 2, quux: 3 }), 'with dependencies');
      assert.isFalse(root.validate({ foo: 1, quux: 3 }), 'missing bar dependency');
      assert.isFalse(root.validate({ bar: 1, quux: 3 }), 'missing foo dependency');
      assert.isFalse(root.validate({ quux: 3 }), 'missing both dependencies');
    });

    it('should validate dependentRequired 3', function () {
      const root = compileSchemaValidator({
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
        root.validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
          billing_address: '555 Debtor\'s Lane',
        }),
        'creditcard and billing address are present',
      );
      assert.isFalse(
        root.validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
        }),
        'creditcard needs billing address',
      );
      assert.isFalse(
        root.validate({
          name: 'Joham Doe',
          billing_address: '555 Debtor\'s Lane',
        }),
        'a billing address needs a creditcard',
      );

    });

    it('should validate mixed properties with escape characters', function () {
      const root = compileSchemaValidator({
        dependentRequired: {
          'foo\nbar': ['foo\rbar'],
          'foo\"bar': ['foo\'bar'],
        },
      });

      assert.isTrue(root.validate({ 'foo\nbar': 1, 'foo\rbar': 2 }), 'object 1 is valid');
      assert.isTrue(root.validate({ 'foo\tbar': 1, a: 2, b: 3, c: 4 }), 'object 2 is valid');
      assert.isTrue(root.validate({ 'foo\'bar': 1, 'foo\"bar': 2 }), 'object 3 is valid');
      assert.isFalse(root.validate({ 'foo\nbar': 1, foo: 2 }), 'object 1 is invalid');
      assert.isFalse(root.validate({ 'foo\"bar': 2 }), 'object 2 is invalid');
    });

  });

  describe('#objectDependantSchemas()', function () {
    it('should return true when dependentSchemas is empty', function () {
      const root = compileSchemaValidator({ dependentSchemas: {} });
      assert.isTrue(root.validate({}), 'neither');
      assert.isTrue(root.validate(['bar']), 'ignores array');
      assert.isTrue(root.validate('foobar'), 'ignores string');
      assert.isTrue(root.validate(12), 'ignores numbers');

      assert.isTrue(root.validate({ foo: 1, bar: 2, baz: 3 }), 'with dependencies');
      assert.isTrue(root.validate({ bar: 1 }), 'not a dependency');
      assert.isTrue(root.validate({ a: 1 }), 'without dependencies');
    });

    it('should validate a single dependentSchemas 1', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({
        foo: true,
        propertiesCount: 10,
      }), 'when foo is present propertiesCount is required');

      assert.isTrue(root.validate({
        propertiesCount: 5,
      }), 'propertiesCount need to be greater then or equal to 0');

      assert.isFalse(root.validate({
        foo: true,
        propertiesCount: 5,
      }), 'propertiesCount must be equal or greater then 7');
    });

    it('should validate a single dependentSchemas 2', function () {
      const root = compileSchemaValidator({
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
        root.validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
          billing_address: '555 Debtor\'s Lane',
        }),
        'creditcard and billing address are present',
      );
      assert.isFalse(
        root.validate({
          name: 'Joham Doe',
          credit_card: 5555555555555555,
        }),
        'creditcard needs billing address',
      );
      assert.isTrue(
        root.validate({
          name: 'Joham Doe',
          billing_address: '555 Debtor\'s Lane',
        }),
        'a billing address only is present',
      );

    });

    it('should validate with multiple dependentSchemas', function () {
      const root = compileSchemaValidator({
        dependentSchemas: {
          bar: {
            properties: {
              foo: { type: 'integer' },
              bar: { type: 'integer' },
            },
          },
        },
      });

      assert.isTrue(root.validate({ foo: 1, bar: 2 }), 'both properties are valid types');
      assert.isTrue(root.validate({ foo: 'quux' }), 'no dependency');
      assert.isFalse(root.validate({ foo: 'quux', bar: 2 }), 'wrong foo dependency');
      assert.isFalse(root.validate({ foo: 2, bar: 'quux' }), 'wrong bar dependency');
      assert.isFalse(root.validate({ foo: 'quux', bar: 'quux' }), 'wrong dependencies');
    });

    it('should validate with boolean dependency schemas', function () {
      const root = compileSchemaValidator({
        dependentSchemas: {
          foo: true,
          bar: false,
        },
      });

      assert.isTrue(root.validate({ foo: 1 }), 'object with property having schema true is valid');
      assert.isFalse(root.validate({ bar: 2 }), 'object with property having schema false is invalid');
      assert.isFalse(root.validate({ foo: 1, bar: 2 }), 'object with both boolean properties is invalid');
      assert.isTrue(root.validate({}), 'empty object is valid');
    });

    it('should validate mixed properties with escape characters', function () {
      const root = compileSchemaValidator({
        dependentSchemas: {
          'foo\tbar': { minProperties: 4 },
          'foo\'bar': { required: ['foo\"bar'] },
        },
      });

      assert.isTrue(root.validate({ 'foo\nbar': 1, 'foo\rbar': 2 }), 'object 1 is valid');
      assert.isTrue(root.validate({ 'foo\tbar': 1, a: 2, b: 3, c: 4 }), 'object 2 is valid');
      assert.isTrue(root.validate({ 'foo\'bar': 1, 'foo\"bar': 2 }), 'object 3 is valid');
      assert.isFalse(root.validate({ 'foo\tbar': 1, a: 2 }), 'object 1 is invalid');
      assert.isFalse(root.validate({ 'foo\'bar': 1 }), 'object 2 is invalid');
    });
  });

  describe('#objectAdditionalProperties()', function () {
    it('should validate object prohibiting additionalProperties', function () {
      const root = compileSchemaValidator({
        type: 'object',
        properties: {
          number: { type: 'number' },
          street_name: { type: 'string' },
          street_type: { enum: ['Street', 'Avenue', 'Boulevard'] },
        },
        additionalProperties: false,
      });

      assert.isTrue(root.validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue',
      }), 'valid typed address');
      assert.isFalse(root.validate({
        number: '1600', street_name: 'Pennsylvania', street_type: 'Avenue', direction: 'NW',
      }), 'number is of wrong type and invalid property direction');
      assert.isFalse(root.validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue', direction: 'NW',
      }), 'invalid property direction');

    });

    it('should validate object with typed additionalProperties', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue',
      }), 'valid typed address');
      assert.isTrue(root.validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue', direction: 'NW',
      }), 'valid typed address with typed additionalProperties');
      assert.isFalse(root.validate({
        number: 1600, street_name: 'Pennsylvania', street_type: 'Avenue', office_number: 201,
      }), 'invalid address wrongly typed additionalProperties');


    });

    it('should validate patternProperties with no additionalItems', function () {
      const root = compileSchemaValidator({
        patternProperties: {
          '^S_': { type: 'string' },
          '^I_': { type: 'integer' },
        },
        additionalProperties: false,
      });

      assert.isTrue(root.validate({ S_25: 'This is a string' }), 'key within pattern with string value');
      assert.isTrue(root.validate({ I_42: 42 }), 'key within pattern with integer value');
      assert.isFalse(root.validate({ S_0: 108 }), 'key with pattern but wrong value type');
      assert.isFalse(root.validate({ I_42: '42' }), 'key integer within pattern but wrong value type');
      assert.isFalse(root.validate({ keyword: 42 }), 'additionalItem doesnt allow number');
      assert.isFalse(root.validate({ keyword: 'value' }), 'additionalItems doesnt allow string');
    });

    it('should validate a combination of properties, patternProperties and additionalProperties', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({ buildin: 5 }), 'buildin property is number type');
      assert.isTrue(root.validate({ S_25: 'This is a string' }), 'key within pattern with string value');
      assert.isTrue(root.validate({ I_42: 42 }), 'key within integer pattern with integer value');
      assert.isTrue(root.validate({ keyword: 'value' }), 'is of additionalProperties type string');
      assert.isFalse(root.validate({ S_0: 108 }), 'key within string pattern but wrong value type');
      assert.isFalse(root.validate({ I_42: '42' }), 'key within integer pattern but wrong value type');
      assert.isFalse(root.validate({ keyword: 42 }), 'invalid additionalProperties should be string.');
    });
  });

  describe('objectUnevaluatedProperties()', function () {
    it('unevaluatedProperties is true', function () {
      const root = compileSchemaValidator({
        type: 'object',
        unevaluatedProperties: true,
      });
      assert.isTrue(root.validate({}), 'with no unevaluated properties');
      assert.isTrue(root.validate({ foo: 'foo' }), 'with unevaluated properties');
    });

    it.skip('unevaluatedProperties with schema', function () {
      const root = compileSchemaValidator({ type: 'object',
        unevaluatedProperties: {
          type: 'string',
          minLength: 3,
        },
      });
      assert.isTrue(root.validate({}), 'with no unevaluated properties');
      assert.isTrue(root.validate({ foo: 'foo' }), 'with a valid unevaluated properties');
      assert.isFalse(root.validate({ foo: 'fo' }), 'with invalid unevaluated properties');
      assert.isFalse(root.validate({ foo: 42 }), 'with invalid unevaluated number property');
    });

    it('should have no unevaluatedProperties', function () {
      const root = compileSchemaValidator({
        type: 'object',
        unevaluatedProperties: false,
      });
      assert.isTrue(root.validate({}), 'with no unevaluated properties');
      assert.isFalse(root.validate({ foo: 'foo' }), 'with unevaluated properties');
    });

    it.skip('should validate properties with no adjacent unevaluatedProperties', function () {
      const root = compileSchemaValidator({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        unevaluatedProperties: false,
      });
      assert.isTrue(root.validate({ foo: 'foo' }), 'with no unevaluated properties');
      assert.isFalse(root.validate({ foo: 42 }), 'with no number property called foo');
      assert.isFalse(root.validate({ foo: 'foo', bar: 'bar' }), 'with unevaluated properties');
    });

    it.skip('should validate patternProperties with no adjacent unevaluatedProperties', function () {
      const root = compileSchemaValidator({
        type: 'object',
        patternProperties: {
          '^foo': { type: 'string' },
        },
        unevaluatedProperties: false,
      });
      assert.isTrue(root.validate({ foo: 'foo' }), 'with no unevaluated properties');
      assert.isFalse(root.validate({ foo: 'foo', bar: 'bar' }), 'with unevaluated properties');
    });

    it('should validate additionalProperties with no adjacent unevaluatedProperties', function () {
      const root = compileSchemaValidator({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        additionalProperties: true,
        unevaluatedProperties: false,
      });
      assert.isTrue(root.validate({ foo: 'foo' }), 'with no additional properties');
      assert.isFalse(root.validate({ foo: 12 }), 'Invalid type. Expected String but got Integer');
      assert.isTrue(root.validate({ foo: 'foo', bar: 'bar' }), 'with additional properties');
    });

    it.skip('should validate unevaluatedProperties with allOf nested properties', function () {
      const root = compileSchemaValidator({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        allOf: [
          { properties: { bar: { type: 'string' } } },
        ],
        unevaluatedProperties: false,
      });
      assert.isTrue(root.validate({ foo: 'foo', bar: 'bar' }), 'with no unevaluated properties');
      assert.isFalse(root.validate({ foo: 'foo', bar: 'bar', baz: 'baz' }), 'with unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with allOf nested patternProperties', function () {
      const root = compileSchemaValidator({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        allOf: [
          { patternProperties: { '^bar': { type: 'string' } } },
        ],
        unevaluatedProperties: false,
      });
      assert.isTrue(root.validate({ foo: 'foo', bar: 'bar' }), 'with no unevaluated properties');
      assert.isFalse(root.validate({ foo: 'foo', bar: 'bar', baz: 'baz' }), 'with unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with allOf nested additionalProperties', function () {
      const root = compileSchemaValidator({
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        allOf: [
          { additionalProperties: true },
        ],
        unevaluatedProperties: false,
      });
      assert.isTrue(root.validate({ foo: 'foo' }), 'with no additional properties');
      assert.isTrue(root.validate({ foo: 'foo', bar: 'bar' }), 'with additional properties');
    });

    it.skip('should validate unevaluatedProperties with anyOf nested properties', function () {
      const root = compileSchemaValidator({
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
      assert.isTrue(root.validate({ foo: 'foo', bar: 'bar' }), 'when one matches and has no unevaluated properties');
      assert.isFalse(root.validate({ foo: 'foo', bar: 'bar', baz: 'not-baz' }), 'when one matches and has unevaluated properties');
      assert.isTrue(root.validate({ foo: 'foo', bar: 'bar', baz: 'baz' }), 'when two match and has no unevaluated properties');
      assert.isFalse(root.validate({ foo: 'foo', bar: 'bar', baz: 'baz', quux: 'not-quux' }), 'when two match and has unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with oneOf nested properties', function () {
      const root = compileSchemaValidator({
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
      assert.isTrue(root.validate({ foo: 'foo', bar: 'bar' }), 'when one matches and has no unevaluated properties');
      assert.isFalse(root.validate({ foo: 'foo', bar: 'bar', quux: 'quux' }), 'when one matches and has unevaluated properties');
      assert.isFalse(root.validate({ foo: 'foo', bar: 'bar', baz: 'baz' }), 'when two matches and has no unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with nested not', function () {
      const root = compileSchemaValidator({
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

      assert.isFalse(root.validate({ foo: 'foo', bar: 'bar' }), 'with unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with if/then/else', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({ foo: 'then', bar: 'bar' }), 'when if is true and has no unevaluated properties');
      assert.isFalse(root.validate({ foo: 'then', bar: 'bar', baz: 'baz' }), 'when if is true and has unevaluated properties');
      assert.isTrue(root.validate({ baz: 'baz' }), 'when if is false and has no unevaluated properties');
      assert.isFalse(root.validate({ foo: 'else', baz: 'baz' }), 'when if is false and has unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with if/else', function () {
      const root = compileSchemaValidator({
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
      assert.isFalse(root.validate({ foo: 'then', bar: 'bar' }), 'when if is true and has unevaluated property bar');
      assert.isFalse(root.validate({ foo: 'then', baz: 'baz' }), 'when if is true and has unevaluated properties baz');
      assert.isFalse(root.validate({ foo: 'then', bar: 'bar', baz: 'baz' }), 'when if is true and has unevaluated properties');
      assert.isTrue(root.validate({ baz: 'baz' }), 'when if is false and has no unevaluated properties');
      // TODO: sorry what? why? foo is not marked as evaluated? maybe cause foo is false in this matter.
      assert.isFalse(root.validate({ foo: 'else', baz: 'baz' }), 'when if is false and has unevaluated properties');
    });

    it.skip('should validate unevaluatedProperties with if/then', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({ foo: 'then', bar: 'bar' }), 'when if is true and has no unevaluated properties');
      assert.isFalse(root.validate({ foo: 'then', bar: 'bar', baz: 'baz' }), 'when if is true and has unevaluated properties baz');
      assert.isFalse(root.validate({ baz: 'baz' }), 'when if is false and has unevaluated properties');
      assert.isFalse(root.validate({ foo: 'else', baz: 'baz' }), 'when if is false and has unevaluated properties');
    });

    it.skip('should do something with anyOf unevaluated items', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({ foo: 1, bar: 2 }), 'foo and bar are evaluated');
      assert.isTrue(root.validate({ foo: 1, baz: 3 }), 'foo and baz are evaluated');
      assert.isTrue(root.validate({ foo: 1, bar: 2, baz: 3 }), 'foo, bar and baz are evaluated');
      assert.isFalse(root.validate({ foo: 1 }), 'neither bar nor baz are present');
      assert.isFalse(root.validate({ foo: 1, bar: 2, boo: 3 }), 'boo is unevaluated');
      assert.isFalse(root.validate({ foo: 1, bar: 2, baz: '3' }), 'not valid against the 2nd subschema, so baz is unevaluated');

    });

    it.skip('should be able to extend an address with type with allOf', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
      }), 'address without type is valid');
      assert.isTrue(root.validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
        type: 'business',
      }), 'address with type is valid');
      assert.isFalse(root.validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
        type: 'business',
        "something that doesn't belong": 'hi!',
      }), 'any other property not defined is not allowed');
    });

    it.skip('should allow the department property only if the type of address is business', function () {
      const root = compileSchemaValidator({
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
      assert.isTrue(root.validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
        type: 'business',
        department: 'HR',
      }), 'business address has a valid department');
      assert.isFalse(root.validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
        type: 'residential',
        department: 'HR',
      }), 'residential address doesnt allow a department');
    });

    it.skip('should validate inheritance example for issue #556', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({ pontoons: 'pontoons' }), 'is a boat, but not a car or a plane.');
      assert.isFalse(root.validate({ pontoons: 'pontoons', wheels: 'wheels' }), 'is a boat with an unevaluated property wheels');
    });

    it.skip('should validate example schema for (A | B) & (C | D) issue #86', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({ a: 'a', c: 'c' }), 'valid A & C');
      assert.isTrue(root.validate({ b: 'b', c: 'c' }), 'valid B & C');
      assert.isFalse(root.validate({ a: 'a', b: 'b', c: 'c' }), 'invalid A & B & C');
      assert.isFalse(root.validate({ a: 'a', c: 'c', e: 'e' }), 'invalid unevaluated property E');
    });
  });
});
