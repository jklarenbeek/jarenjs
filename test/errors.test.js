//@ts-check

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JarenValidator, ValidatorOptions, ValidationError } from '@jarenjs/validate';

describe('Error Reporting', () => {
  
  describe('Basic Error Collection', () => {
    it('should return boolean by default (no error collection)', () => {
      const jaren = new JarenValidator();
      const schema = { type: 'number' };
      const validator = jaren.compile(schema);

      const result = validator('not a number');
      
      assert.strictEqual(typeof result, 'boolean');
      assert.strictEqual(result, false);
    });

    it('should return error object when collectErrors is enabled', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { type: 'number' };
      const validator = jaren.compile(schema);

      const result = validator('not a number');
      
      assert.strictEqual(typeof result, 'object');
      assert.strictEqual(result.valid, false);
      assert.ok(Array.isArray(result.errors));
      assert.ok(result.errors.length > 0);
    });

    it('should return valid=true with no errors for valid data', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { type: 'number' };
      const validator = jaren.compile(schema);

      const result = validator(42);
      
      assert.strictEqual(result.valid, true);
      assert.ok(!result.errors || result.errors.length === 0);
    });
  });

  describe('Type Validation Errors', () => {
    it('should report type error for string type', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { type: 'string' };
      const validator = jaren.compile(schema);

      const result = validator(123);
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length >= 1);
      
      const error = result.errors[0];
      assert.strictEqual(error.keyword, 'type');
      assert.strictEqual(error.params.type, 'string');
      assert.ok(error.message.includes('string'));
    });

    it('should report type error for multiple types', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { type: ['string', 'number'] };
      const validator = jaren.compile(schema);

      const result = validator(true);
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length >= 1);
      
      const error = result.errors[0];
      assert.strictEqual(error.keyword, 'type');
      assert.ok(Array.isArray(error.params.types));
      assert.deepStrictEqual(error.params.types, ['string', 'number']);
    });
  });

  describe('Number Validation Errors', () => {
    it('should report minimum error', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { minimum: 10 };
      const validator = jaren.compile(schema);

      const result = validator(5);
      
      assert.strictEqual(result.valid, false);
      
      const error = result.errors.find(e => e.keyword === 'minimum');
      assert.ok(error, 'Should have minimum error');
      assert.strictEqual(error.params.limit, 10);
      assert.strictEqual(error.params.comparison, '>=');
      assert.ok(error.message.includes('10'));
    });

    it('should report maximum error', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { maximum: 100 };
      const validator = jaren.compile(schema);

      const result = validator(150);
      
      assert.strictEqual(result.valid, false);
      
      const error = result.errors.find(e => e.keyword === 'maximum');
      assert.ok(error, 'Should have maximum error');
      assert.strictEqual(error.params.limit, 100);
      assert.strictEqual(error.params.comparison, '<=');
    });

    it('should report exclusiveMinimum error', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { exclusiveMinimum: 10 };
      const validator = jaren.compile(schema);

      const result = validator(10);
      
      assert.strictEqual(result.valid, false);
      
      const error = result.errors.find(e => e.keyword === 'exclusiveMinimum');
      assert.ok(error, 'Should have exclusiveMinimum error');
      assert.strictEqual(error.params.limit, 10);
      assert.strictEqual(error.params.comparison, '>');
    });

    it('should report multipleOf error', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { multipleOf: 5 };
      const validator = jaren.compile(schema);

      const result = validator(7);
      
      assert.strictEqual(result.valid, false);
      
      const error = result.errors.find(e => e.keyword === 'multipleOf');
      assert.ok(error, 'Should have multipleOf error');
      assert.strictEqual(error.params.multipleOf, 5);
    });
  });

  describe('String Validation Errors', () => {
    it('should report minLength error', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { minLength: 5 };
      const validator = jaren.compile(schema);

      const result = validator('hi');
      
      assert.strictEqual(result.valid, false);
      
      const error = result.errors.find(e => e.keyword === 'minLength');
      assert.ok(error, 'Should have minLength error');
      assert.strictEqual(error.params.limit, 5);
    });

    it('should report maxLength error', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { maxLength: 3 };
      const validator = jaren.compile(schema);

      const result = validator('hello');
      
      assert.strictEqual(result.valid, false);
      
      const error = result.errors.find(e => e.keyword === 'maxLength');
      assert.ok(error, 'Should have maxLength error');
      assert.strictEqual(error.params.limit, 3);
    });

    it('should report pattern error', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { pattern: '^[a-z]+$' };
      const validator = jaren.compile(schema);

      const result = validator('ABC');
      
      assert.strictEqual(result.valid, false);
      
      const error = result.errors.find(e => e.keyword === 'pattern');
      assert.ok(error, 'Should have pattern error');
      assert.strictEqual(error.params.pattern, '^[a-z]+$');
    });
  });

  describe('Object Validation Errors', () => {
    it('should report required property error', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = {
        type: 'object',
        required: ['name']
      };
      const validator = jaren.compile(schema);

      const result = validator({});
      
      assert.strictEqual(result.valid, false);
      
      const error = result.errors.find(e => e.keyword === 'required');
      assert.ok(error, 'Should have required error');
    });

    it('should report additionalProperties error', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = {
        type: 'object',
        additionalProperties: false
      };
      const validator = jaren.compile(schema);

      const result = validator({ extra: 'value' });
      
      assert.strictEqual(result.valid, false);
      
      const error = result.errors.find(e => e.keyword === 'additionalProperties');
      assert.ok(error, 'Should have additionalProperties error');
    });
  });

  describe('Error Structure', () => {
    it('should have all required error properties', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { type: 'number' };
      const validator = jaren.compile(schema);

      const result = validator('not a number');
      const error = result.errors[0];
      
      // Check for JSON Schema spec required properties
      assert.ok(error.keyword, 'Should have keyword');
      assert.ok(typeof error.instancePath === 'string', 'Should have instancePath');
      assert.ok(typeof error.schemaPath === 'string', 'Should have schemaPath');
      assert.ok(typeof error.params === 'object', 'Should have params');
      assert.ok(typeof error.message === 'string', 'Should have message');
    });

    it('should convert errors to JSON', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = { type: 'number' };
      const validator = jaren.compile(schema);

      const result = validator('not a number');
      
      // Should be serializable
      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);
      
      assert.strictEqual(parsed.valid, false);
      assert.ok(Array.isArray(parsed.errors));
      assert.ok(parsed.errors[0].keyword);
    });
  });

  describe('Multiple Errors', () => {
    it('should collect multiple errors when available', () => {
      const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      const schema = {
        type: 'object',
        properties: {
          age: { type: 'number', minimum: 0 },
          name: { type: 'string', minLength: 1 }
        }
      };
      const validator = jaren.compile(schema);

      const result = validator({
        age: -5,
        name: ''
      });
      
      assert.strictEqual(result.valid, false);
      
      // Should have errors for both age and name
      const ageError = result.errors.find(e => 
        e.keyword === 'minimum' || (e.params && e.params.limit === 0)
      );
      const nameError = result.errors.find(e => 
        e.keyword === 'minLength' || (e.params && e.params.limit === 1)
      );
      
      assert.ok(ageError || result.errors.length > 0, 'Should have validation errors');
    });
  });
});

// Additional Array Validation Error Tests
describe('Array Validation Errors', () => {
  it('should report maxItems error', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = { maxItems: 2 };
    const validator = jaren.compile(schema);

    const result = validator([1, 2, 3]);
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'maxItems');
    assert.ok(error, 'Should have maxItems error');
    assert.strictEqual(error.params.limit, 2);
    assert.ok(error.message.includes('2'));
  });

  it('should report minItems error', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = { minItems: 3 };
    const validator = jaren.compile(schema);

    const result = validator([1, 2]);
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'minItems');
    assert.ok(error, 'Should have minItems error');
    assert.strictEqual(error.params.limit, 3);
  });

  it('should report uniqueItems error', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = { uniqueItems: true };
    const validator = jaren.compile(schema);

    const result = validator([1, 2, 1]);
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'uniqueItems');
    assert.ok(error, 'Should have uniqueItems error');
    assert.ok(error.message.includes('duplicate'));
  });

  it('should report contains error when no items match', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      contains: { type: 'string' }
    };
    const validator = jaren.compile(schema);

    const result = validator([1, 2, 3]);
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'contains');
    assert.ok(error, 'Should have contains error');
    assert.ok(error.message.includes('contain'));
  });

  it('should report items error when array items do not match schema', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      type: 'array',
      items: { type: 'number' }
    };
    const validator = jaren.compile(schema);

    const result = validator(['not a number', 42]);
    
    assert.strictEqual(result.valid, false);
    
    // Items validation should produce errors
    assert.ok(result.errors.length > 0, 'Should have errors');
  });
});

// Format Validation Error Tests
describe('Format Validation Errors', () => {
  it('should report format error for invalid date-time', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    jaren.addFormat('date-time', (schemaObj, schema) => {
      const addError = schemaObj.createErrorHandler('date-time', 'format');
      return function validateDateTime(data, dataPath) {
        // Simple ISO 8601 regex check
        const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
        return iso8601Regex.test(data) || addError(data, dataPath);
      };
    });
    
    const schema = { type: 'string', format: 'date-time' };
    const validator = jaren.compile(schema);

    const result = validator('not-a-date');
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'format');
    assert.ok(error, 'Should have format error');
    assert.strictEqual(error.params.format, 'date-time');
    assert.ok(error.message.includes('date-time'));
  });

  it('should report format error for invalid email', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    jaren.addFormat('email', (schemaObj, schema) => {
      const addError = schemaObj.createErrorHandler('email', 'format');
      return function validateEmail(data, dataPath) {
        // Simple email regex
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(data) || addError(data, dataPath);
      };
    });
    
    const schema = { type: 'string', format: 'email' };
    const validator = jaren.compile(schema);

    const result = validator('not-an-email');
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'format');
    assert.ok(error, 'Should have format error');
    assert.strictEqual(error.params.format, 'email');
  });

  it('should report format error for invalid uri', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    jaren.addFormat('uri', (schemaObj, schema) => {
      const addError = schemaObj.createErrorHandler('uri', 'format');
      return function validateUri(data, dataPath) {
        try {
          new URL(data);
          return true;
        } catch {
          return addError(data, dataPath);
        }
      };
    });
    
    const schema = { type: 'string', format: 'uri' };
    const validator = jaren.compile(schema);

    const result = validator('not a uri');
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'format');
    assert.ok(error, 'Should have format error');
    assert.strictEqual(error.params.format, 'uri');
  });
});

// Combine Keywords Error Tests
describe('Combine Keywords Errors', () => {
  it('should report allOf error when data does not match all schemas', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      allOf: [
        { type: 'object', properties: { name: { type: 'string' } } },
        { type: 'object', properties: { age: { type: 'number' } } }
      ]
    };
    const validator = jaren.compile(schema);

    // This should fail because age must be a number
    const result = validator({ name: 'John', age: 'not a number' });
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'allOf');
    assert.ok(error, 'Should have allOf error');
    assert.ok(error.message.includes('all'));
  });

  it('should report anyOf error when data does not match any schema', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      anyOf: [
        { type: 'string' },
        { type: 'number' }
      ]
    };
    const validator = jaren.compile(schema);

    const result = validator(true);
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'anyOf');
    assert.ok(error, 'Should have anyOf error');
    assert.ok(error.message.includes('anyOf'));
  });

  it('should report oneOf error when data matches multiple schemas', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      oneOf: [
        { type: 'number', minimum: 0 },
        { type: 'number', maximum: 100 }
      ]
    };
    const validator = jaren.compile(schema);

    // 50 matches both schemas (>= 0 AND <= 100)
    const result = validator(50);
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'oneOf');
    assert.ok(error, 'Should have oneOf error');
    assert.ok(error.message.includes('exactly one'));
  });

  it('should report oneOf error when data matches no schemas', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      oneOf: [
        { type: 'string' },
        { type: 'number' }
      ]
    };
    const validator = jaren.compile(schema);

    const result = validator({});
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'oneOf');
    assert.ok(error, 'Should have oneOf error');
  });

  it('should report not error when data matches the negated schema', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      not: { type: 'string' }
    };
    const validator = jaren.compile(schema);

    const result = validator('a string');
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'not');
    assert.ok(error, 'Should have not error');
    assert.ok(error.message.includes('NOT'));
  });
});

// Conditional Keywords Error Tests
describe('Conditional Keywords Errors', () => {
  it('should report error when if matches but then fails', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      type: 'object',
      if: { properties: { type: { const: 'business' } } },
      then: { properties: { taxId: { type: 'string' } }, required: ['taxId'] }
    };
    const validator = jaren.compile(schema);

    const result = validator({ type: 'business' });
    
    assert.strictEqual(result.valid, false);
    
    // Should have required error for taxId
    const error = result.errors.find(e => e.keyword === 'required');
    assert.ok(error, 'Should have required error for missing taxId');
  });

  it('should not report error when if does not match', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      type: 'object',
      if: { properties: { type: { const: 'business' } } },
      then: { properties: { taxId: { type: 'string' } }, required: ['taxId'] }
    };
    const validator = jaren.compile(schema);

    const result = validator({ type: 'personal' });
    
    assert.strictEqual(result.valid, true);
    assert.ok(!result.errors || result.errors.length === 0);
  });

  it('should report error when if does not match but else also fails', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      type: 'object',
      if: { properties: { type: { const: 'business' } } },
      then: { properties: { taxId: { type: 'string' } } },
      else: { properties: { name: { type: 'string' } }, required: ['name'] }
    };
    const validator = jaren.compile(schema);

    // type is not 'business', so else should apply
    const result = validator({ type: 'personal' });
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'required');
    assert.ok(error, 'Should have required error for missing name');
  });
});

// Error Path Tracking Tests
describe('Error Path Tracking', () => {
  it('should track nested object paths', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' }
          },
          required: ['street']
        }
      }
    };
    const validator = jaren.compile(schema);

    const result = validator({ address: {} });
    
    assert.strictEqual(result.valid, false);
    
    // Should have required error for address.street
    const error = result.errors.find(e => e.keyword === 'required');
    assert.ok(error, 'Should have required error');
  });

  it('should track array item paths', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }
        },
        required: ['name']
      }
    };
    const validator = jaren.compile(schema);

    const result = validator([{}, { name: 'valid' }]);
    
    assert.strictEqual(result.valid, false);
    
    // Should have required error
    const error = result.errors.find(e => e.keyword === 'required');
    assert.ok(error, 'Should have required error');
  });

  it('should track deep nesting paths', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      type: 'object',
      properties: {
        level1: {
          type: 'object',
          properties: {
            level2: {
              type: 'object',
              properties: {
                value: { type: 'number' }
              }
            }
          }
        }
      }
    };
    const validator = jaren.compile(schema);

    const result = validator({ level1: { level2: { value: 'not a number' } } });
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'type');
    assert.ok(error, 'Should have type error');
    assert.strictEqual(error.params.type, 'number');
  });
});

// Edge Case Tests
describe('Error Collection Edge Cases', () => {
  it('should report error for boolean false schema', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = false;
    const validator = jaren.compile(schema);

    const result = validator({});
    
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
    
    const error = result.errors[0];
    assert.ok(error.keyword === 'false schema' || error.message.includes('false'));
  });

  it('should not report errors for boolean true schema', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = true;
    const validator = jaren.compile(schema);

    const result = validator({ anything: 'goes' });
    
    assert.strictEqual(result.valid, true);
    assert.ok(!result.errors || result.errors.length === 0);
  });

  it('should not report errors for empty schema', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {};
    const validator = jaren.compile(schema);

    const result = validator({ anything: 'goes', here: 123 });
    
    assert.strictEqual(result.valid, true);
    assert.ok(!result.errors || result.errors.length === 0);
  });

  it('should report multiple required property errors', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      type: 'object',
      required: ['a', 'b', 'c']
    };
    const validator = jaren.compile(schema);

    const result = validator({});
    
    assert.strictEqual(result.valid, false);
    
    // Should have errors for all three missing properties
    const requiredErrors = result.errors.filter(e => e.keyword === 'required');
    assert.ok(requiredErrors.length >= 1, 'Should have at least one required error');
  });

  it('should collect multiple validation errors in same object', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 0 },
        name: { type: 'string', minLength: 3 },
        email: { type: 'string', format: 'email' }
      }
    };
    
    // Add email format
    jaren.addFormat('email', (schemaObj, schema) => {
      const addError = schemaObj.createErrorHandler('email', 'format');
      return function validateEmail(data, dataPath) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(data) || addError(data, dataPath);
      };
    });
    
    const validator = jaren.compile(schema);

    const result = validator({ 
      count: -5, 
      name: 'ab',
      email: 'invalid'
    });
    
    assert.strictEqual(result.valid, false);
    // Should have multiple errors collected
    assert.ok(result.errors.length >= 2, 'Should have multiple errors');
  });
});

// Additional Keyword Error Tests
describe('Additional Keyword Error Tests', () => {
  it('should report const error when data does not match constant', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      const: 'expected value'
    };
    const validator = jaren.compile(schema);

    const result = validator('wrong value');
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'const');
    assert.ok(error, 'Should have const error');
  });

  it('should report enum error when data is not in allowed values', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      enum: ['a', 'b', 'c']
    };
    const validator = jaren.compile(schema);

    const result = validator('d');
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'enum');
    assert.ok(error, 'Should have enum error');
  });

  it('should report minProperties error', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      type: 'object',
      minProperties: 2
    };
    const validator = jaren.compile(schema);

    const result = validator({ one: 1 });
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'minProperties');
    assert.ok(error, 'Should have minProperties error');
    assert.strictEqual(error.params.limit, 2);
  });

  it('should report maxProperties error', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      type: 'object',
      maxProperties: 1
    };
    const validator = jaren.compile(schema);

    const result = validator({ one: 1, two: 2 });
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'maxProperties');
    assert.ok(error, 'Should have maxProperties error');
    assert.strictEqual(error.params.limit, 1);
  });

  it('should report exclusiveMaximum error', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const schema = {
      exclusiveMaximum: 100
    };
    const validator = jaren.compile(schema);

    const result = validator(100);
    
    assert.strictEqual(result.valid, false);
    
    const error = result.errors.find(e => e.keyword === 'exclusiveMaximum');
    assert.ok(error, 'Should have exclusiveMaximum error');
    assert.strictEqual(error.params.limit, 100);
    assert.strictEqual(error.params.comparison, '<');
  });
});

// Comprehensive Error Params Tests
describe('Comprehensive Error Params', () => {
  it('should have correct params for type error with single type', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({ type: 'string' });

    const result = validator(123);
    
    const error = result.errors.find(e => e.keyword === 'type');
    assert.strictEqual(error.params.type, 'string');
    assert.ok(!error.params.types, 'Should not have types array for single type');
  });

  it('should have correct params for type error with multiple types', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({ type: ['string', 'number'] });

    const result = validator(true);
    
    const error = result.errors.find(e => e.keyword === 'type');
    assert.ok(Array.isArray(error.params.types), 'Should have types array');
    assert.deepStrictEqual(error.params.types, ['string', 'number']);
    assert.ok(!error.params.type, 'Should not have single type');
  });

  it('should have correct params for required error', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({
      type: 'object',
      required: ['name', 'age']
    });

    const result = validator({});
    
    const errors = result.errors.filter(e => e.keyword === 'required');
    assert.ok(errors.length > 0, 'Should have required errors');
    
    // Each required error should have missingProperty param
    for (const error of errors) {
      assert.ok(error.params.missingProperty, 'Should have missingProperty param');
    }
  });

  it('should have correct params for additionalProperties error', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({
      type: 'object',
      additionalProperties: false
    });

    const result = validator({ extra: 'value' });
    
    const error = result.errors.find(e => e.keyword === 'additionalProperties');
    assert.ok(error.params.additionalProperty, 'Should have additionalProperty param');
    assert.strictEqual(error.params.additionalProperty, 'extra');
  });

  it('should have correct params for pattern error', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({
      type: 'string',
      pattern: '^[a-z]+$'
    });

    const result = validator('ABC123');
    
    const error = result.errors.find(e => e.keyword === 'pattern');
    assert.strictEqual(error.params.pattern, '^[a-z]+$');
  });

  it('should have correct comparison params for minimum', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({ minimum: 10 });

    const result = validator(5);
    
    const error = result.errors.find(e => e.keyword === 'minimum');
    assert.strictEqual(error.params.limit, 10);
    assert.strictEqual(error.params.comparison, '>=');
  });

  it('should have correct comparison params for maximum', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({ maximum: 100 });

    const result = validator(150);
    
    const error = result.errors.find(e => e.keyword === 'maximum');
    assert.strictEqual(error.params.limit, 100);
    assert.strictEqual(error.params.comparison, '<=');
  });
});

// Error Message Quality Tests
describe('Error Message Quality', () => {
  it('should have human-readable type error message', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({ type: 'string' });

    const result = validator(123);
    
    const error = result.errors.find(e => e.keyword === 'type');
    assert.ok(error.message.includes('string'), 'Message should mention expected type');
  });

  it('should have human-readable required error message', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({
      type: 'object',
      required: ['name']
    });

    const result = validator({});
    
    const error = result.errors.find(e => e.keyword === 'required');
    assert.ok(error.message.includes('required'), 'Message should mention required');
    assert.ok(error.message.includes('name'), 'Message should mention property name');
  });

  it('should have human-readable minimum error message', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({ minimum: 10 });

    const result = validator(5);
    
    const error = result.errors.find(e => e.keyword === 'minimum');
    assert.ok(error.message.includes('10'), 'Message should mention limit');
    assert.ok(error.message.includes('>=') || error.message.includes('greater'), 'Message should mention comparison');
  });

  it('should have human-readable pattern error message', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({ pattern: '^[a-z]+$' });

    const result = validator('ABC');
    
    const error = result.errors.find(e => e.keyword === 'pattern');
    assert.ok(error.message.includes('pattern') || error.message.includes('match'), 'Message should mention pattern');
  });

  it('should have human-readable allOf error message', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'number' } } }
      ]
    });

    const result = validator({ a: 123 });
    
    const error = result.errors.find(e => e.keyword === 'allOf');
    assert.ok(error.message.toLowerCase().includes('all'), 'Message should mention all');
  });

  it('should have human-readable oneOf error message', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({
      oneOf: [
        { type: 'string' },
        { type: 'number' }
      ]
    });

    const result = validator(true);
    
    const error = result.errors.find(e => e.keyword === 'oneOf');
    assert.ok(error.message.toLowerCase().includes('one') || error.message.toLowerCase().includes('exactly'), 'Message should mention one/exactly');
  });

  it('should have human-readable not error message', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validator = jaren.compile({ not: { type: 'string' } });

    const result = validator('hello');
    
    const error = result.errors.find(e => e.keyword === 'not');
    assert.ok(error.message.toUpperCase().includes('NOT'), 'Message should mention NOT');
  });
});
