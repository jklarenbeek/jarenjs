import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import {
  formRulesToQueryAssertions, buildFormModel, compileFormRules, evaluateFormRules, buildFormViewModel,
} from '@jarenjs/forms';

// The validate-side round trip of the forms rules synergy: a rule
// authored once as `x-form.assert` (per-keystroke feedback) is copied by
// formRulesToQueryAssertions into a '$query' keyword and enforced by the
// authoritative submit validation. Forms itself never imports the
// validator - this integration is wired caller-side, as here.

describe("forms x-form.assert -> '$query' round trip", () => {

  it('should enforce a copied cross-field assert on submit', () => {
    const schema = {
      type: 'object',
      properties: {
        company: { type: 'string' },
        vatId: {
          type: 'string',
          'x-form': {
            assert: { $or: [{ $eq: ['$.company', ''] }, { $ne: ['$.vatId', ''] }] },
            message: 'VAT id is required for companies',
          },
        },
      },
    };

    const validate = new JarenValidator().compile(formRulesToQueryAssertions(schema));
    assert.strictEqual(validate({ company: '', vatId: '' }), true);
    assert.strictEqual(validate({ company: 'ACME', vatId: 'NL123' }), true);
    assert.strictEqual(validate({ company: 'ACME', vatId: '' }), false);
  });

  it('should bind $value and $pointer inside the copied assert', () => {
    const schema = {
      type: 'object',
      properties: {
        nick: { type: 'string', 'x-form': { assert: { $ne: ['$value', 'root'] } } },
      },
    };

    const validate = new JarenValidator().compile(formRulesToQueryAssertions(schema));
    assert.strictEqual(validate({ nick: 'joe' }), true);
    assert.strictEqual(validate({ nick: 'root' }), false);
    // absent field: bound null, exactly as the keystroke path binds it,
    // so the rule means the same thing on both sides. Absence itself is
    // `required`'s job, not an assert's.
    assert.strictEqual(validate({}), true);
  });

  it('should quantify a copied item-template assert over the actual elements', () => {
    const schema = {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              amount: { type: 'number', 'x-form': { assert: { $gt: ['$value', 0] } } },
            },
          },
        },
      },
    };

    const validate = new JarenValidator().compile(formRulesToQueryAssertions(schema));
    assert.strictEqual(validate({ lines: [{ amount: 5 }, { amount: 3 }] }), true);
    assert.strictEqual(validate({ lines: [{ amount: 5 }, { amount: 0 }] }), false);
    assert.strictEqual(validate({ lines: [] }), true, '$every is vacuously true');
    assert.strictEqual(validate({}), true, 'no array, nothing to assert');
  });

  it('should agree with the keystroke path on absent fields and absent members', () => {
    // The contract of the copy: one authored rule, one meaning. Whatever
    // the per-keystroke evaluation says about a document, submit says too.
    const schema = {
      type: 'object',
      properties: {
        nick: { type: 'string', 'x-form': { assert: { $ne: ['$value', 'root'] } } },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              amount: { type: 'number', 'x-form': { assert: { $gt: ['$value', 0] } } },
            },
          },
        },
      },
    };
    const validate = new JarenValidator().compile(formRulesToQueryAssertions(schema));
    const rules = compileFormRules(buildFormModel(schema));
    const keystrokeOk = (data) => Object.values(evaluateFormRules(rules, data))
      .every((r) => r.errors === undefined);

    const documents = [
      {},
      { nick: 'joe' },
      { nick: 'root' },
      { lines: [] },
      { lines: [{ amount: 5 }] },
      { lines: [{ amount: 0 }] },
      { lines: [{ amount: 5 }, {}] }, // an element with no `amount` at all
      { nick: 'joe', lines: [{}] },
    ];
    for (const data of documents) {
      assert.strictEqual(validate(data), keystrokeOk(data),
        `submit and keystroke disagreed on ${JSON.stringify(data)}`);
    }
  });

  it('should compose with an existing root $query through allOf', () => {
    const schema = {
      type: 'object',
      $query: '$.approved',
      properties: {
        a: { type: 'number', 'x-form': { assert: { $gt: ['$.a', 0] } } },
      },
    };

    const validate = new JarenValidator().compile(formRulesToQueryAssertions(schema));
    assert.strictEqual(validate({ approved: true, a: 1 }), true);
    assert.strictEqual(validate({ approved: false, a: 1 }), false, 'original $query still asserts');
    assert.strictEqual(validate({ approved: true, a: 0 }), false, 'copied assert asserts');
  });

  it('guards descendant assertions with the hidden ancestor value and pointer bindings', () => {
    const schema = {
      type: 'object', properties: {
        group: {
          type: 'object',
          'x-form': { visible: { $and: ['$value.show', { $eq: ['$pointer', '/group'] }] } },
          properties: {
            show: { type: 'boolean' },
            name: { type: 'string', 'x-form': { assert: { $ne: ['$value', ''] } } },
          },
        },
      },
    };
    const model = buildFormModel(schema);
    const rules = compileFormRules(model);
    const validate = new JarenValidator().compile(formRulesToQueryAssertions(schema));
    for (const show of [false, true]) {
      const data = { group: { show, name: '' } };
      const tree = buildFormViewModel(model, data, { rules, session: { initial: data } });
      assert.strictEqual(tree.session.errorCount, show ? 1 : 0);
      assert.strictEqual(validate(data), !show);
    }
    assert.strictEqual(validate({ group: { show: true, name: 'A' } }), true);
    assert.strictEqual(validate({ group: { show: false, name: 7 } }), false,
      'visibility does not suppress the ordinary schema type constraint');
  });

  it('keeps each ancestor visibility bound to its own row in nested arrays', () => {
    const schema = {
      type: 'object', properties: {
        groups: {
          type: 'array', items: {
            type: 'object', 'x-form': { visible: '$value.show' },
            properties: {
              show: { type: 'boolean' },
              rows: {
                type: 'array', items: {
                  type: 'object', 'x-form': { visible: '$value.show' },
                  properties: {
                    show: { type: 'boolean' },
                    name: { type: 'string', 'x-form': { assert: { $ne: ['$value', ''] } } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const model = buildFormModel(schema);
    const rules = compileFormRules(model);
    const validate = new JarenValidator().compile(formRulesToQueryAssertions(schema));
    for (const groupShown of [false, true]) {
      for (const rowShown of [false, true]) {
        const data = { groups: [
          { show: false, rows: [{ show: true, name: '' }] },
          { show: groupShown, rows: [{ show: rowShown, name: '' }, { show: true, name: 'A' }] },
        ] };
        const tree = buildFormViewModel(model, data, { rules, session: { initial: data } });
        const invalid = groupShown && rowShown;
        assert.strictEqual(tree.session.errorCount, invalid ? 1 : 0);
        assert.strictEqual(validate(data), !invalid);
      }
    }
  });
});
