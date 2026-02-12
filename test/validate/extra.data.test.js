import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
} from '@jarenjs/validate';

import {
  stringFormats
} from '@jarenjs/formats';

// from: https://json-schema.org/learn/miscellaneous-examples#conditional-validation-with-dependentrequired

const compiler = new JarenValidator();
compiler.addFormats(stringFormats);

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

describe('Schema $data Keyword (Ajv-style)', function () {

  describe('#$data_basic()', function () {
    
    it('should validate that smaller <= larger using $data reference', function () {
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

      // Passes - smaller <= larger
      assert.isTrue(validate({
        smaller: 5,
        larger: 7,
      }));

      assert.isTrue(validate({
        smaller: 7,
        larger: 7,
      }));

      // Fails - smaller > larger
      assert.isFalse(validate({
        smaller: 10,
        larger: 7,
      }));
    });

    it('should validate format using property name via $data', function () {
      const validate = compiler.compile({
        additionalProperties: {
          type: 'string',
          format: { $data: '0#' },
        },
      });

      assert.isTrue(validate({
        'date-time': '1963-06-19T08:30:06.283185Z',
        'email': 'joe.bloggs@example.com',
      }));
    });
  });

  describe('#$data_number_constraints()', function () {

    it('should validate minimum using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            type: 'number',
            minimum: { $data: '1/min' },
          },
          min: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ value: 10, min: 5 }));
      assert.isTrue(validate({ value: 5, min: 5 }));
      assert.isFalse(validate({ value: 3, min: 5 }));
    });

    it('should validate maximum using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            type: 'number',
            maximum: { $data: '1/max' },
          },
          max: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ value: 5, max: 10 }));
      assert.isTrue(validate({ value: 10, max: 10 }));
      assert.isFalse(validate({ value: 15, max: 10 }));
    });

    it('should validate exclusiveMinimum using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            type: 'number',
            exclusiveMinimum: { $data: '1/min' },
          },
          min: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ value: 10, min: 5 }));
      assert.isFalse(validate({ value: 5, min: 5 })); // Equal is not allowed
      assert.isFalse(validate({ value: 3, min: 5 }));
    });

    it('should validate exclusiveMaximum using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            type: 'number',
            exclusiveMaximum: { $data: '1/max' },
          },
          max: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ value: 5, max: 10 }));
      assert.isFalse(validate({ value: 10, max: 10 })); // Equal is not allowed
      assert.isFalse(validate({ value: 15, max: 10 }));
    });

    it('should validate multipleOf using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            type: 'number',
            multipleOf: { $data: '1/factor' },
          },
          factor: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ value: 10, factor: 5 }));
      assert.isTrue(validate({ value: 12, factor: 3 }));
      assert.isFalse(validate({ value: 10, factor: 3 }));
    });
  });

  describe('#$data_string_constraints()', function () {

    it('should validate minLength using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            type: 'string',
            minLength: { $data: '1/minLen' },
          },
          minLen: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ value: 'hello', minLen: 3 }));
      assert.isTrue(validate({ value: 'hi', minLen: 2 }));
      assert.isFalse(validate({ value: 'hi', minLen: 3 }));
    });

    it('should validate maxLength using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            type: 'string',
            maxLength: { $data: '1/maxLen' },
          },
          maxLen: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ value: 'hi', maxLen: 10 }));
      assert.isTrue(validate({ value: 'hello', maxLen: 5 }));
      assert.isFalse(validate({ value: 'hello world', maxLen: 5 }));
    });

    it('should validate pattern using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            type: 'string',
            pattern: { $data: '1/pattern' },
          },
          pattern: {
            type: 'string',
          },
        },
      });

      assert.isTrue(validate({ value: 'hello123', pattern: '^[a-z]+[0-9]+$' }));
      assert.isFalse(validate({ value: 'HELLO', pattern: '^[a-z]+$' }));
    });

    it('should validate format using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            type: 'string',
            format: { $data: '1/fmt' },
          },
          fmt: {
            type: 'string',
          },
        },
      });

      assert.isTrue(validate({ value: 'joe@example.com', fmt: 'email' }));
      assert.isFalse(validate({ value: 'not-an-email', fmt: 'email' }));
    });
  });

  describe('#$data_array_constraints()', function () {

    it('should validate minItems using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          items: {
            type: 'array',
            minItems: { $data: '1/minCount' },
          },
          minCount: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ items: [1, 2, 3], minCount: 2 }));
      assert.isFalse(validate({ items: [1], minCount: 2 }));
    });

    it('should validate maxItems using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          items: {
            type: 'array',
            maxItems: { $data: '1/maxCount' },
          },
          maxCount: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ items: [1, 2], maxCount: 5 }));
      assert.isFalse(validate({ items: [1, 2, 3, 4, 5, 6], maxCount: 5 }));
    });
  });

  describe('#$data_object_constraints()', function () {

    it('should validate minProperties using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          obj: {
            type: 'object',
            minProperties: { $data: '1/minProps' },
          },
          minProps: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ obj: { a: 1, b: 2, c: 3 }, minProps: 2 }));
      assert.isFalse(validate({ obj: { a: 1 }, minProps: 2 }));
    });

    it('should validate maxProperties using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          obj: {
            type: 'object',
            maxProperties: { $data: '1/maxProps' },
          },
          maxProps: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ obj: { a: 1, b: 2 }, maxProps: 3 }));
      assert.isFalse(validate({ obj: { a: 1, b: 2, c: 3, d: 4 }, maxProps: 3 }));
    });

    it('should validate required using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          obj: {
            type: 'object',
            required: { $data: '1/requiredProps' },
          },
          requiredProps: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      });

      assert.isTrue(validate({ obj: { a: 1, b: 2 }, requiredProps: ['a'] }));
      assert.isTrue(validate({ obj: { a: 1, b: 2 }, requiredProps: ['a', 'b'] }));
      assert.isFalse(validate({ obj: { a: 1 }, requiredProps: ['a', 'b'] }));
    });
  });

  describe('#$data_enum_const()', function () {

    it('should validate enum using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            enum: { $data: '1/validValues' },
          },
          validValues: {
            type: 'array',
          },
        },
      });

      assert.isTrue(validate({ value: 'cat', validValues: ['dog', 'cat', 'gerbil'] }));
      assert.isFalse(validate({ value: 'giraffe', validValues: ['dog', 'cat', 'gerbil'] }));
    });

    it('should validate const using $data reference', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            const: { $data: '1/expected' },
          },
          expected: {},
        },
      });

      assert.isTrue(validate({ value: 42, expected: 42 }));
      assert.isFalse(validate({ value: 42, expected: 100 }));
    });
  });

  describe('#$data_relative_pointers()', function () {

    it('should handle "0" pointer (current value)', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            type: 'number',
            // "0" refers to the current value itself
            minimum: { $data: '0' },
          },
        },
      });

      // Value must be >= itself (always true)
      assert.isTrue(validate({ value: 10 }));
      assert.isTrue(validate({ value: -5 }));
    });

    it('should handle "0/prop" pointer (property of current)', function () {
      // Note: When validating a property value, the current location is the value itself
      // So "0" would refer to the value, not the parent object
      // To access a sibling property, we need to go up 1 level to the parent
      const validate = compiler.compile({
        type: 'object',
        properties: {
          limits: {
            type: 'object',
            properties: {
              value: {
                type: 'number',
                minimum: { $data: '1/min' },  // Go up 1 level to limits, then to min
              },
              min: {
                type: 'number',
              },
            },
          },
        },
      });

      assert.isTrue(validate({ limits: { value: 10, min: 5 } }));
      assert.isFalse(validate({ limits: { value: 3, min: 5 } }));
    });

    it('should handle "1" pointer (parent value)', function () {
      const validate = compiler.compile({
        properties: {
          child: {
            type: 'object',
            properties: {
              value: {
                type: 'number',
                minimum: { $data: '2/parentMin' },  // Go up 2 levels: child -> root -> parentMin
              },
            },
          },
          parentMin: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ child: { value: 10 }, parentMin: 5 }));
      assert.isFalse(validate({ child: { value: 3 }, parentMin: 5 }));
    });

    it('should handle "0#" pointer (property name)', function () {
      const validate = compiler.compile({
        additionalProperties: {
          type: 'string',
          minLength: 5,
        },
      });

      // Additional properties with string values of minLength 5
      assert.isTrue(validate({ 'longname': 'hello world' }));
      assert.isFalse(validate({ 'longname': 'hi' }));
    });

    it('should handle "2" pointer (grandparent)', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          config: {
            type: 'object',
            properties: {
              settings: {
                type: 'object',
                properties: {
                  value: {
                    type: 'number',
                    maximum: { $data: '3/globalMax' },  // Go up 3 levels to root
                  },
                },
              },
            },
          },
          globalMax: {
            type: 'number',
          },
        },
      });

      assert.isTrue(validate({ config: { settings: { value: 50 } }, globalMax: 100 }));
      assert.isFalse(validate({ config: { settings: { value: 150 } }, globalMax: 100 }));
    });
  });

  describe('#$data_edge_cases()', function () {

    it('should pass validation when $data reference is not found', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            type: 'number',
            minimum: { $data: '1/nonexistent' },
          },
        },
      });

      // When reference is not found, validation passes (no constraint)
      assert.isTrue(validate({ value: 10 }));
    });

    it('should pass validation when $data reference has wrong type', function () {
      const validate = compiler.compile({
        properties: {
          value: {
            type: 'number',
            minimum: { $data: '1/minStr' },
          },
          minStr: {
            type: 'string',
          },
        },
      });

      // When reference is a string (not number), validation passes (no constraint)
      assert.isTrue(validate({ value: 10, minStr: 'hello' }));
    });

    it('should work with nested objects', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          limits: {
            type: 'object',
            properties: {
              min: { type: 'number' },
              max: { type: 'number' },
            },
          },
          value: {
            type: 'number',
            minimum: { $data: '1/limits/min' },  // Go up 1 level from value, then limits/min
            maximum: { $data: '1/limits/max' },
          },
        },
      });

      assert.isTrue(validate({ limits: { min: 10, max: 100 }, value: 50 }));
      assert.isFalse(validate({ limits: { min: 10, max: 100 }, value: 5 }));
      assert.isFalse(validate({ limits: { min: 10, max: 100 }, value: 150 }));
    });

    it('should work with arrays', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          limits: {
            type: 'array',
            items: { type: 'number' },
          },
          value: {
            type: 'number',
            minimum: { $data: '1/limits/0' },  // Go up 1 level from value, then limits/0
            maximum: { $data: '1/limits/1' },
          },
        },
      });

      assert.isTrue(validate({ limits: [10, 100], value: 50 }));
      assert.isFalse(validate({ limits: [10, 100], value: 5 }));
    });
  });

  describe('#$data_comparison_with_data_keyword()', function () {

    it('should demonstrate difference between data keyword (absolute) and $data (relative)', function () {
      // json-everything style: absolute JSON Pointer from root
      const validateData = compiler.compile({
        type: 'object',
        properties: {
          A: { type: 'number' },
          B: {
            type: 'number',
            data: {
              minimum: '/A',  // Absolute: starts from root
            },
          },
        },
      });

      // Ajv style: relative JSON Pointer from current location
      const validateDollarData = compiler.compile({
        type: 'object',
        properties: {
          A: { type: 'number' },
          B: {
            type: 'number',
            minimum: { $data: '1/A' },  // Relative: go up 1 level from B to parent, then to A
          },
        },
      });

      // Both should validate B >= A
      assert.isTrue(validateData({ A: 5, B: 10 }));
      assert.isTrue(validateDollarData({ A: 5, B: 10 }));

      assert.isFalse(validateData({ A: 15, B: 10 }));
      assert.isFalse(validateDollarData({ A: 15, B: 10 }));
    });
  });
});
