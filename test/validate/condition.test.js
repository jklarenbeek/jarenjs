import { describe, it } from 'node:test';
import * as assert from '@jaren/tools/assert';

import {
  compileSchemaValidator,
} from '@jaren/validate';

describe('Schema Conditionals', function () {
  describe('#if()', function () {
    // https://json-schema.org/understanding-json-schema/reference/conditionals.html
    it('should validate without the if keyword', function () {
      const root = compileSchemaValidator({
        then: { minimum: -10 },
        else: { multipleOf: 2 },
      });

      assert.isTrue(root.validate(-100), 'valid through missing if');
      assert.isTrue(root.validate(3), 'still valid through missing if');
    });

    it('should validate without the else keyword', function () {
      const root = compileSchemaValidator({
        if: { exclusiveMaximum: 0 },
        then: { minimum: -10 },
      });

      assert.isTrue(root.validate(-1), 'valid through then');
      assert.isFalse(root.validate(-100), 'invalid through then');
      assert.isTrue(root.validate(3), 'valid when if test fails');
    });

    it('should validate without the then keyword', function () {
      const root = compileSchemaValidator({
        if: { exclusiveMaximum: 0 },
        else: { multipleOf: 2 },
      });

      assert.isTrue(root.validate(-1), 'valid when if test passes');
      assert.isTrue(root.validate(4), 'valid through else');
      assert.isFalse(root.validate(3), 'invalid through else');
    });

    it('should validate without the then and else keyword', function () {
      const root = compileSchemaValidator({
        if: { exclusiveMaximum: 0 },
      });

      assert.isTrue(root.validate(-1), 'valid when if test passes');
      assert.isTrue(root.validate(4), 'valid through missing then');
      assert.isTrue(root.validate(3), 'valid through missing else');

    });

    it('should validate against the correct branch', function () {
      const root = compileSchemaValidator({
        if: { exclusiveMaximum: 0 },
        then: { minimum: -10 },
        else: { multipleOf: 2 },
      });

      assert.isTrue(root.validate(-1), 'valid through then');
      assert.isFalse(root.validate(-100), 'invalid through then');
      assert.isTrue(root.validate(4), 'valid through else');
      assert.isFalse(root.validate(3), 'invalid through else');
    });

    it('should not be a very scalable postal code', function () {
      const root = compileSchemaValidator({
        type: 'object',
        properties: {
          street_address: {
            type: 'string',
          },
          country: {
            enum: ['United States of America', 'Canada'],
          },
        },
        if: {
          properties: { country: { const: 'United States of America' } },
        },
        then: {
          properties: { postal_code: { pattern: '[0-9]{5}(-[0-9]{4})?' } },
        },
        else: {
          properties: { postal_code: { pattern: '[A-Z][0-9][A-Z] [0-9][A-Z][0-9]' } },
        },
      });

      assert.isTrue(root.validate({
        street_address: '1600 Pennsylvania Avenue NW',
        country: 'United States of America',
        postal_code: '20500',
      }), 'a valid postal code for the US.');
      assert.isTrue(root.validate({
        street_address: '24 Sussex Drive',
        country: 'Canada',
        postal_code: 'K1M 1M4',
      }), 'a valid postal code for canada');
      assert.isFalse(root.validate({
        street_address: '24 Sussex Drive',
        country: 'Canada',
        postal_code: '10000',
      }), 'an invalid postal code for canada');
    });

    it('should be a better scalable postal code', function () {
      const root = compileSchemaValidator({
        type: 'object',
        properties: {
          street_address: {
            type: 'string',
          },
          country: {
            enum: ['United States of America', 'Canada', 'Netherlands'],
          },
        },
        allOf: [
          {
            if: {
              properties: { country: { const: 'United States of America' } },
            },
            then: {
              properties: { postal_code: { pattern: '[0-9]{5}(-[0-9]{4})?' } },
            },
          },
          {
            if: {
              properties: { country: { const: 'Canada' } },
            },
            then: {
              properties: { postal_code: { pattern: '[A-Z][0-9][A-Z] [0-9][A-Z][0-9]' } },
            },
          },
          {
            if: {
              properties: { country: { const: 'Netherlands' } },
            },
            then: {
              properties: { postal_code: { pattern: '[0-9]{4} [A-Z]{2}' } },
            },
          },
        ],
      });

      assert.isTrue(root.validate({
        street_address: '1600 Pennsylvania Avenue NW',
        country: 'United States of America',
        postal_code: '20500',
      }), 'a valid us postal code');
      assert.isTrue(root.validate({
        street_address: '24 Sussex Drive',
        country: 'Canada',
        postal_code: 'K1M 1M4',
      }), 'a valid canadian postal code');
      assert.isTrue(root.validate({
        street_address: 'Adriaan Goekooplaan',
        country: 'Netherlands',
        postal_code: '2517 JX',
      }), 'a valid dutch postal code');
      assert.isFalse(root.validate({
        street_address: '24 Sussex Drive',
        country: 'Canada',
        postal_code: '10000',
      }), 'an invalid canadian postal code');
    });

  });

  describe('#ifelse()', function () {
    it('should conditionally validate with if-else', function () {
      const root = compileSchemaValidator({
        $id: 'https://example.com/conditional-validation-if-else.schema.json',
        title: 'Conditional Validation with If-Else',
        type: 'object',
        properties: {
          isMember: {
            type: 'boolean',
          },
          membershipNumber: {
            type: 'string',
          },
        },
        required: ['isMember'],
        if: {
          properties: {
            isMember: {
              const: true,
            },
          },
        },
        then: {
          properties: {
            membershipNumber: {
              type: 'string',
              minLength: 10,
              maxLength: 10,
            },
          },
        },
        else: {
          properties: {
            membershipNumber: {
              type: 'string',
              minLength: 15,
            },
          },
        },
      });


      assert.isTrue(root.validate({
        isMember: true,
        membershipNumber: '1234567890',
      }), 'ismember is true and membershipNumber has 10 chars');

      assert.isTrue(root.validate({
        isMember: false,
        membershipNumber: 'GUEST1234567890',
      }), 'ismember is false and membershipNumber length is gte 15');

    });
  });


});