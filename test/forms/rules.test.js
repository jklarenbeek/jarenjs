import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

// Engine-side tests of the `x-form` rules: this file must never import
// @jarenjs/validate - rules using schema literals go through a STUB
// compileTypeTest hook (QUERY-FORMAT.md section 8.11, same pattern as
// test/json/query/schema-ops.test.js); the validate-side round trip of
// formRulesToQueryAssertions lives in test/validate/.

import {
  buildFormModel,
  compileFormRules,
  evaluateFormRules,
  formRulesToQueryAssertions,
  setValueAtPointer,
} from '@jarenjs/forms';

function compiledFor(schema, options) {
  return compileFormRules(buildFormModel(schema), options);
}

const signupSchema = {
  type: 'object',
  properties: {
    company: { type: 'string' },
    vatId: {
      type: 'string',
      'x-form': {
        visible: { $ne: ['$.company', ''] },
        assert: { $or: [{ $eq: ['$.company', ''] }, { $ne: ['$.vatId', ''] }] },
        message: 'VAT id is required for companies',
      },
    },
  },
};

describe('Form Rules (x-form)', function () {
  describe('#buildFormModel() rules extraction', function () {
    it('should extract the raw x-form object onto field.rules', function () {
      const model = buildFormModel(signupSchema);
      const vatId = model.children.find((f) => f.key === 'vatId');
      assert.isTrue(vatId.rules === signupSchema.properties.vatId['x-form'], 'raw annotation, by reference');
      assert.isTrue(model.children.find((f) => f.key === 'company').rules === null);
    });
  });

  describe('#evaluateFormRules() visibility & enablement', function () {
    it('should toggle visibility on sibling values', function () {
      const compiled = compiledFor(signupSchema);
      assert.isTrue(evaluateFormRules(compiled, { company: 'ACME', vatId: 'NL1' })['/vatId'].visible === true);
      assert.isTrue(evaluateFormRules(compiled, { company: '' })['/vatId'].visible === false);
    });

    it('should evaluate enabled rules', function () {
      const compiled = compiledFor({
        type: 'object',
        properties: {
          premium: { type: 'boolean' },
          discount: { type: 'number', 'x-form': { enabled: { $eq: ['$.premium', true] } } },
        },
      });
      assert.isTrue(evaluateFormRules(compiled, { premium: true })['/discount'].enabled === true);
      assert.isTrue(evaluateFormRules(compiled, { premium: false })['/discount'].enabled === false);
      assert.isTrue(evaluateFormRules(compiled, {})['/discount'].enabled === false, 'absent sibling: empty sequence never equals');
    });

    it('should accept a bare JSONPath string as a degenerate rule (EBV of the member)', function () {
      const compiled = compiledFor({
        type: 'object',
        properties: {
          approved: { type: 'boolean' },
          notes: { type: 'string', 'x-form': { visible: '$.approved' } },
        },
      });
      assert.isTrue(evaluateFormRules(compiled, { approved: true })['/notes'].visible === true);
      assert.isTrue(evaluateFormRules(compiled, { approved: false })['/notes'].visible === false);
      assert.isTrue(evaluateFormRules(compiled, {})['/notes'].visible === false, 'absent member: EBV of empty is false');
    });

    it('should only report the rules a field declares', function () {
      const compiled = compiledFor(signupSchema);
      const result = evaluateFormRules(compiled, { company: 'ACME', vatId: 'NL1' });
      assert.isTrue(result['/company'] === undefined, 'no rules, no entry');
      assert.isTrue(result['/vatId'].enabled === undefined);
      assert.isTrue(result['/vatId'].computed === undefined);
      assert.isTrue(result['/vatId'].errors === undefined, 'satisfied assert reports nothing');
    });
  });

  describe('#evaluateFormRules() computed values', function () {
    const invoiceSchema = {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: { type: 'object', properties: { amount: { type: 'number' } } },
        },
        total: { type: 'number', 'x-form': { computed: { $sum: '$.lines[*].amount' } } },
      },
    };

    it('should compute the invoice total and recompute after setValueAtPointer', function () {
      const compiled = compiledFor(invoiceSchema);
      let data = { lines: [{ amount: 12.5 }, { amount: 7.5 }] };
      assert.isTrue(evaluateFormRules(compiled, data)['/total'].computed === 20);

      data = setValueAtPointer(data, '/lines/0/amount', 10);
      assert.isTrue(evaluateFormRules(compiled, data)['/total'].computed === 17.5);

      assert.isTrue(evaluateFormRules(compiled, {})['/total'].computed === 0, '$sum over the empty sequence is 0');
    });
  });

  describe('#evaluateFormRules() assertions', function () {
    it('should report assert failures with the declared message', function () {
      const compiled = compiledFor(signupSchema);

      const failing = evaluateFormRules(compiled, { company: 'ACME', vatId: '' });
      assert.deepEqual(failing['/vatId'].errors,
        [{ keyword: 'x-form/assert', params: { pointer: '/vatId' }, msgid: 'x-form/assert',
          message: 'VAT id is required for companies' }]);

      assert.isTrue(evaluateFormRules(compiled, { company: '', vatId: '' })['/vatId'].errors === undefined);
      assert.isTrue(evaluateFormRules(compiled, { company: 'ACME', vatId: 'NL1' })['/vatId'].errors === undefined);
    });

    it('should fall back to a default message', function () {
      const compiled = compiledFor({
        type: 'object',
        properties: {
          end: { type: 'string', 'x-form': { assert: { $le: ['$.start', '$.end'] } } },
          start: { type: 'string' },
        },
      });
      const result = evaluateFormRules(compiled, { start: '2026-12-31', end: '2026-01-01' });
      assert.isTrue(result['/end'].errors[0].keyword === 'x-form/assert');
      assert.isTrue(typeof result['/end'].errors[0].message === 'string');
      assert.isTrue(result['/end'].errors[0].message.length > 0);
    });
  });

  describe('rule query context ($, $value, $pointer)', function () {
    it('should bind $value to the field value and $pointer to its pointer', function () {
      const compiled = compiledFor({
        type: 'object',
        properties: {
          nick: {
            type: 'string',
            'x-form': {
              computed: '$pointer',
              assert: { $ne: ['$value', 'root'] },
            },
          },
        },
      });
      const result = evaluateFormRules(compiled, { nick: 'root' });
      assert.isTrue(result['/nick'].computed === '/nick');
      assert.isTrue(result['/nick'].errors.length === 1);
      assert.isTrue(evaluateFormRules(compiled, { nick: 'joe' })['/nick'].errors === undefined);
    });

    it('should bind $value to null for an absent field', function () {
      const compiled = compiledFor({
        type: 'object',
        properties: {
          maybe: { type: 'string', 'x-form': { computed: { $eq: ['$value', null] } } },
        },
      });
      assert.isTrue(evaluateFormRules(compiled, {})['/maybe'].computed === true);
      assert.isTrue(evaluateFormRules(compiled, { maybe: 'x' })['/maybe'].computed === false);
    });

    it('should reject any external other than value/pointer at compile time', function () {
      assert.throws(() => compiledFor({
        type: 'object',
        properties: {
          a: { type: 'string', 'x-form': { visible: { $eq: ['$other', 1] } } },
        },
      }), (e) => e.message.includes("external 'other'") && e.message.includes('/a'));
    });

    it('should prepend the field pointer to compile errors', function () {
      assert.throws(() => compiledFor({
        type: 'object',
        properties: {
          a: { type: 'string', 'x-form': { visible: { $nope: [1] } } },
        },
      }), (e) => e.message.startsWith('/a x-form/visible:'));
    });
  });

  describe('array item templates', function () {
    const linesSchema = {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            'x-form': { computed: '$pointer' },
            properties: {
              amount: {
                type: 'number',
                'x-form': { assert: { $gt: ['$value', 0] }, message: 'Amount must be positive' },
              },
            },
          },
        },
      },
    };

    it('should evaluate a template rule once per element, binding value and pointer per index', function () {
      const compiled = compiledFor(linesSchema);
      const result = evaluateFormRules(compiled, {
        lines: [{ amount: 5 }, { amount: 0 }, { amount: 3 }],
      });

      assert.isTrue(result['/lines/0'].computed === '/lines/0', 'pointer binding per element');
      assert.isTrue(result['/lines/2'].computed === '/lines/2', 'pointer binding /lines/2');

      assert.isTrue(result['/lines/0/amount'].errors === undefined);
      assert.deepEqual(result['/lines/1/amount'].errors,
        [{ keyword: 'x-form/assert', params: { pointer: '/lines/1/amount' }, msgid: 'x-form/assert',
          message: 'Amount must be positive' }]);
      assert.isTrue(result['/lines/2/amount'].errors === undefined);
      assert.isTrue(result['/lines/3'] === undefined, 'expansion follows the actual array length');
    });

    it('should expand to nothing when the array is absent', function () {
      const compiled = compiledFor(linesSchema);
      assert.deepEqual(evaluateFormRules(compiled, {}), {});
    });
  });

  describe('schema literals in rules (compileTypeTest hook)', function () {
    // A minimal structural stub - forms never imports @jarenjs/validate;
    // apps pass createTypeTestCompiler() from @jarenjs/validate/query here.
    function stubHook(schemaJson) {
      return (value) => (schemaJson.type === 'number' ? typeof value === 'number' : true);
    }

    it('should pass compileTypeTest through to the query compiler', function () {
      const compiled = compiledFor({
        type: 'object',
        properties: {
          age: { 'x-form': { visible: { $valid: ['$value', { type: 'number' }] } } },
        },
      }, { compileTypeTest: stubHook });
      assert.isTrue(evaluateFormRules(compiled, { age: 42 })['/age'].visible === true);
      assert.isTrue(evaluateFormRules(compiled, { age: 'x' })['/age'].visible === false);
    });

    it('should surface JQ0008 for schema operators without a hook', function () {
      assert.throws(() => compiledFor({
        type: 'object',
        properties: {
          age: { 'x-form': { visible: { $valid: ['$value', { type: 'number' }] } } },
        },
      }), (e) => e.message.includes('JQ0008') && e.message.startsWith('/age x-form/visible:'));
    });
  });

  describe('EBV runtime error policy', function () {
    // '$.nums[*]' selects two items; its EBV is runtime error JQ2003
    const schema = {
      type: 'object',
      properties: {
        nums: { type: 'array', items: { type: 'number' } },
        broken: {
          type: 'string',
          'x-form': { visible: '$.nums[*]', enabled: '$.nums[*]', assert: '$.nums[*]' },
        },
      },
    };

    it('should fail open on visible/enabled and closed on assert', function () {
      const compiled = compiledFor(schema);
      const result = evaluateFormRules(compiled, { nums: [1, 2] })['/broken'];
      assert.isTrue(result.visible === true, 'a broken rule must never hide data');
      assert.isTrue(result.enabled === true, 'a broken rule must never lock a control');
      assert.isTrue(result.errors.length === 1, 'an uncomputable assertion is not satisfied');
    });

    it('should stay well-behaved when the same rules evaluate cleanly', function () {
      const compiled = compiledFor(schema);
      const result = evaluateFormRules(compiled, { nums: [7] })['/broken'];
      assert.isTrue(result.visible === true);
      assert.isTrue(result.errors === undefined);
    });
  });

  describe('#formRulesToQueryAssertions()', function () {
    it('should copy a single assert into its own allOf branch with rebound value/pointer and message', function () {
      const out = formRulesToQueryAssertions(signupSchema);
      assert.isTrue(out.allOf.length === 1);
      assert.deepEqual(out.allOf[0], {
        $query: {
          $let: { value: "$['vatId']", pointer: { $const: '/vatId' } },
          $return: signupSchema.properties.vatId['x-form'].assert,
        },
        errorMessage: {
          $query: {
            message: 'VAT id is required for companies',
            params: { pointer: '/vatId' },
          },
        },
      });
      assert.isTrue(signupSchema.allOf === undefined, 'input schema is not mutated');
      assert.isTrue(out.properties === signupSchema.properties, 'untouched subtrees are shared');
    });

    it('should emit one allOf branch per assert, each carrying its pointer', function () {
      const out = formRulesToQueryAssertions({
        type: 'object',
        properties: {
          a: { 'x-form': { assert: { $ne: ['$value', 1] } } },
          b: { 'x-form': { assert: { $ne: ['$value', 2] } } },
        },
      });
      assert.isTrue(out.allOf.length === 2);
      assert.deepEqual(out.allOf[0].$query.$let.pointer, { $const: '/a' });
      assert.deepEqual(out.allOf[1].$query.$let.pointer, { $const: '/b' });
      // a rule without a message gets the catalog default, pointer included
      assert.deepEqual(out.allOf[0].errorMessage,
        { $query: { $msgid: 'x-form/assert', params: { pointer: '/a' } } });
    });

    it('should quantify item-template asserts with $every', function () {
      const out = formRulesToQueryAssertions({
        type: 'object',
        properties: {
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                amount: { 'x-form': { assert: { $gt: ['$value', 0] } } },
              },
            },
          },
        },
      });
      assert.deepEqual(out.allOf[0].$query, {
        $every: { value: "$['lines'][*]['amount']" },
        $satisfies: {
          $let: { pointer: { $const: '/lines/-/amount' } },
          $return: { $gt: ['$value', 0] },
        },
      });
      assert.deepEqual(out.allOf[0].errorMessage.$query.params, { pointer: '/lines/-/amount' });
    });

    it('should preserve an existing root $query untouched', function () {
      const out = formRulesToQueryAssertions({
        type: 'object',
        $query: '$.approved',
        properties: { a: { 'x-form': { assert: { $ne: ['$value', 1] } } } },
      });
      assert.isTrue(out.$query === '$.approved');
      assert.isTrue(out.allOf.length === 1);
      assert.deepEqual(out.allOf[0].$query.$let.pointer, { $const: '/a' });
    });

    it('should return the input unchanged when there is nothing to copy', function () {
      const schema = { type: 'object', properties: { a: { type: 'string' } } };
      assert.isTrue(formRulesToQueryAssertions(schema) === schema);
      assert.isTrue(formRulesToQueryAssertions(true) === true);
    });

    it('should escape pointer and path metacharacters in property names', function () {
      const out = formRulesToQueryAssertions({
        type: 'object',
        properties: {
          "a/b's": { 'x-form': { assert: { $ne: ['$value', ''] } } },
        },
      });
      assert.isTrue(out.allOf[0].$query.$let.value === "$['a/b\\'s']");
      assert.deepEqual(out.allOf[0].$query.$let.pointer, { $const: '/a~1b\'s' });
    });
  });
});
