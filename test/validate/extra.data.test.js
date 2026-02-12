import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
} from '@jarenjs/validate';

// from: https://json-schema.org/learn/miscellaneous-examples#conditional-validation-with-dependentrequired

const compiler = new JarenValidator();

describe('Schema data Keyword Examples', function () {

  describe('#data_minimum()', function () {
    
    it('should validate that B is greater than or equal to A using absolute JSON Pointer', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          A: { type: 'number' },
          B: {
            type: 'number',
            data: {
              minimum: '/A'
            }
          }
        }
      });

      // Passes - B >= A
      assert.isTrue(validate({
        A: 5,
        B: 10
      }));

      assert.isTrue(validate({
        A: 5,
        B: 5
      }));

      // Fails - B < A
      assert.isFalse(validate({
        A: 15,
        B: 10
      }));
    });

    it('should validate that B is greater than A using exclusiveMinimum', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          A: { type: 'number' },
          B: {
            type: 'number',
            data: {
              exclusiveMinimum: '/A'
            }
          }
        }
      });

      // Passes - B > A
      assert.isTrue(validate({
        A: 5,
        B: 10
      }));

      // Fails - B == A
      assert.isFalse(validate({
        A: 5,
        B: 5
      }));

      // Fails - B < A
      assert.isFalse(validate({
        A: 15,
        B: 10
      }));
    });

    it('should validate that B is less than or equal to A using maximum', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          A: { type: 'number' },
          B: {
            type: 'number',
            data: {
              maximum: '/A'
            }
          }
        }
      });

      // Passes - B <= A
      assert.isTrue(validate({
        A: 10,
        B: 5
      }));

      assert.isTrue(validate({
        A: 10,
        B: 10
      }));

      // Fails - B > A
      assert.isFalse(validate({
        A: 5,
        B: 10
      }));
    });

    it('should validate that B is less than A using exclusiveMaximum', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          A: { type: 'number' },
          B: {
            type: 'number',
            data: {
              exclusiveMaximum: '/A'
            }
          }
        }
      });

      // Passes - B < A
      assert.isTrue(validate({
        A: 10,
        B: 5
      }));

      // Fails - B == A
      assert.isFalse(validate({
        A: 10,
        B: 10
      }));

      // Fails - B > A
      assert.isFalse(validate({
        A: 5,
        B: 10
      }));
    });
  });

  describe('#data_enum()', function () {
    
    it('should validate that A is one of the items in B', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          A: {
            data: {
              enum: '/B'
            }
          },
          B: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      });

      // Passes - A is in B
      assert.isTrue(validate({
        A: 'cat',
        B: ['dog', 'cat', 'gerbil']
      }));

      // Fails - A is not in B
      assert.isFalse(validate({
        A: 'giraffe',
        B: ['dog', 'cat', 'gerbil']
      }));
    });

    it('should validate that number is in referenced array', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'number',
            data: {
              enum: '/validValues'
            }
          },
          validValues: {
            type: 'array',
            items: { type: 'number' }
          }
        }
      });

      assert.isTrue(validate({
        value: 42,
        validValues: [1, 42, 100]
      }));

      assert.isFalse(validate({
        value: 99,
        validValues: [1, 42, 100]
      }));
    });
  });

  describe('#data_const()', function () {
    
    it('should validate that value equals referenced value', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'number',
            data: {
              const: '/expected'
            }
          },
          expected: {
            type: 'number'
          }
        }
      });

      assert.isTrue(validate({
        value: 42,
        expected: 42
      }));

      assert.isFalse(validate({
        value: 42,
        expected: 100
      }));
    });
  });

  describe('#data_string_constraints()', function () {
    
    it('should validate minLength from referenced value', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'string',
            data: {
              minLength: '/minLen'
            }
          },
          minLen: {
            type: 'number'
          }
        }
      });

      assert.isTrue(validate({
        value: 'hello',
        minLen: 3
      }));

      assert.isFalse(validate({
        value: 'hi',
        minLen: 3
      }));
    });

    it('should validate maxLength from referenced value', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'string',
            data: {
              maxLength: '/maxLen'
            }
          },
          maxLen: {
            type: 'number'
          }
        }
      });

      assert.isTrue(validate({
        value: 'hi',
        maxLen: 10
      }));

      assert.isFalse(validate({
        value: 'hello world',
        maxLen: 5
      }));
    });

    it('should validate pattern from referenced value', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'string',
            data: {
              pattern: '/pattern'
            }
          },
          pattern: {
            type: 'string'
          }
        }
      });

      assert.isTrue(validate({
        value: 'hello123',
        pattern: '^[a-z]+[0-9]+$'
      }));

      assert.isFalse(validate({
        value: 'HELLO',
        pattern: '^[a-z]+$'
      }));
    });
  });

  describe('#data_array_constraints()', function () {
    
    it('should validate minItems from referenced value', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          items: {
            type: 'array',
            data: {
              minItems: '/minCount'
            }
          },
          minCount: {
            type: 'number'
          }
        }
      });

      assert.isTrue(validate({
        items: [1, 2, 3],
        minCount: 2
      }));

      assert.isFalse(validate({
        items: [1],
        minCount: 2
      }));
    });

    it('should validate maxItems from referenced value', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          items: {
            type: 'array',
            data: {
              maxItems: '/maxCount'
            }
          },
          maxCount: {
            type: 'number'
          }
        }
      });

      assert.isTrue(validate({
        items: [1, 2],
        maxCount: 5
      }));

      assert.isFalse(validate({
        items: [1, 2, 3, 4, 5, 6],
        maxCount: 5
      }));
    });
  });

  describe('#data_object_constraints()', function () {
    
    it('should validate minProperties from referenced value', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          obj: {
            type: 'object',
            data: {
              minProperties: '/minProps'
            }
          },
          minProps: {
            type: 'number'
          }
        }
      });

      assert.isTrue(validate({
        obj: { a: 1, b: 2, c: 3 },
        minProps: 2
      }));

      assert.isFalse(validate({
        obj: { a: 1 },
        minProps: 2
      }));
    });

    it('should validate maxProperties from referenced value', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          obj: {
            type: 'object',
            data: {
              maxProperties: '/maxProps'
            }
          },
          maxProps: {
            type: 'number'
          }
        }
      });

      assert.isTrue(validate({
        obj: { a: 1, b: 2 },
        maxProps: 3
      }));

      assert.isFalse(validate({
        obj: { a: 1, b: 2, c: 3, d: 4 },
        maxProps: 3
      }));
    });
  });

  describe('#data_multipleOf()', function () {
    
    it('should validate multipleOf from referenced value', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'number',
            data: {
              multipleOf: '/factor'
            }
          },
          factor: {
            type: 'number'
          }
        }
      });

      assert.isTrue(validate({
        value: 10,
        factor: 5
      }));

      assert.isTrue(validate({
        value: 12,
        factor: 3
      }));

      assert.isFalse(validate({
        value: 10,
        factor: 3
      }));
    });
  });

  describe('#data_nested_paths()', function () {
    
    it('should handle nested JSON Pointer paths', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          child: {
            type: 'object',
            properties: {
              value: {
                type: 'number',
                data: {
                  minimum: '/limits/min'
                }
              }
            }
          },
          limits: {
            type: 'object'
          }
        }
      });

      assert.isTrue(validate({
        child: { value: 10 },
        limits: { min: 5 }
      }));

      assert.isFalse(validate({
        child: { value: 3 },
        limits: { min: 5 }
      }));
    });

    it('should handle array index in JSON Pointer', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'number',
            data: {
              minimum: '/limits/0'
            }
          },
          limits: {
            type: 'array'
          }
        }
      });

      assert.isTrue(validate({
        value: 10,
        limits: [5, 15]
      }));

      assert.isFalse(validate({
        value: 3,
        limits: [5, 15]
      }));
    });
  });

  describe('#data_special_keys()', function () {
    
    it('should handle keys with special characters', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'number',
            data: {
              minimum: '/a~0b'  // ~0 decodes to ~
            }
          },
          'a~b': {
            type: 'number'
          }
        }
      });

      assert.isTrue(validate({
        value: 10,
        'a~b': 5
      }));

      assert.isFalse(validate({
        value: 3,
        'a~b': 5
      }));
    });

    it('should handle keys with slash characters', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'number',
            data: {
              minimum: '/a~1b'  // ~1 decodes to /
            }
          },
          'a/b': {
            type: 'number'
          }
        }
      });

      assert.isTrue(validate({
        value: 10,
        'a/b': 5
      }));

      assert.isFalse(validate({
        value: 3,
        'a/b': 5
      }));
    });
  });

  describe('#data_edge_cases()', function () {
    
    it('should pass validation when referenced value is not found', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'number',
            data: {
              minimum: '/nonexistent'
            }
          }
        }
      });

      // When reference is not found, validation passes (no constraint)
      assert.isTrue(validate({
        value: 10
      }));
    });

    it('should pass validation when referenced value has wrong type', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'number',
            data: {
              minimum: '/minStr'
            }
          },
          minStr: {
            type: 'string'
          }
        }
      });

      // When reference is a string (not number), validation passes (no constraint)
      assert.isTrue(validate({
        value: 10,
        minStr: 'hello'
      }));
    });

    it('should handle empty data object', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'number',
            data: {}
          }
        }
      });

      assert.isTrue(validate({
        value: 10
      }));
    });

    it('should ignore non-string references in data', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          value: {
            type: 'number',
            data: {
              minimum: 5  // static value, should be ignored
            }
          }
        }
      });

      // Non-string references are ignored
      assert.isTrue(validate({
        value: 3
      }));
    });
  });
});

describe('Schema $data Legacy Examples (not yet implemented)', function () {

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
