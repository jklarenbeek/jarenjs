//@ts-check

/**
 * Forms structured errors, catalogs, MessageSpec rules, the transform
 * message carry, and static-text i18n.
 *
 * Unlike rules.test.js this file MAY import @jarenjs/validate: the
 * keystroke/submit unification test compiles the transformed schema with
 * the real validator (the app-wiring the forms package itself never does).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  buildFormModel,
  validateField,
  validateAllFields,
  compileFormRules,
  evaluateFormRules,
  formRulesToQueryAssertions,
  formsMessagesEn,
  formChromeLabels,
  compileMessageCatalog,
  compileMessageTemplate,
} from '@jarenjs/forms';

import {
  JarenValidator,
  ValidatorOptions,
  localizeErrors,
  compileMessageCatalog as compileValidateCatalog,
} from '@jarenjs/validate';

import { nl } from '@jarenjs/locales';

const nlForms = compileMessageCatalog(nl);
const nlValidate = compileValidateCatalog(nl);

describe('validateField structured errors', () => {
  it('emits keyword, params, msgid and rendered message per branch', () => {
    const model = buildFormModel({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 3, pattern: '^[a-z]+$' },
        age: { type: 'integer', minimum: 18 },
        tags: { type: 'array', minItems: 2, uniqueItems: true },
        currency: { enum: ['EUR', 'USD'] },
        fixed: { const: 42 },
      },
    });
    const [name, age, tags, currency, fixed] = model.children;

    assert.deepStrictEqual(validateField(name, undefined), [{
      keyword: 'required', params: {}, msgid: 'form/required',
      message: 'This field is required',
    }]);

    assert.deepStrictEqual(validateField(name, 'A'), [
      { keyword: 'minLength', params: { limit: 3, len: 1 }, msgid: 'form/minLength',
        message: 'Must be at least 3 characters (currently 1)' },
      { keyword: 'pattern', params: { pattern: '^[a-z]+$' }, msgid: 'form/pattern',
        message: 'Must match pattern ^[a-z]+$' },
    ]);

    assert.deepStrictEqual(validateField(age, 3.5), [
      { keyword: 'type', params: { type: 'integer' }, msgid: 'form/type',
        message: 'Must be an integer' },
      { keyword: 'minimum', params: { limit: 18 }, msgid: 'form/minimum',
        message: 'Must be at least 18' },
    ]);

    assert.deepStrictEqual(validateField(tags, ['a', 'a']), [
      { keyword: 'uniqueItems', params: {}, msgid: 'form/uniqueItems',
        message: 'Items must be unique' },
    ]);

    assert.deepStrictEqual(validateField(currency, 'GBP'), [
      { keyword: 'enum', params: { enumValues: ['EUR', 'USD'] }, msgid: 'form/enum',
        message: 'Must be one of: "EUR", "USD"' },
    ]);

    assert.deepStrictEqual(validateField(fixed, 41), [
      { keyword: 'const', params: { constValue: 42 }, msgid: 'form/const',
        message: 'Must be 42' },
    ]);
  });

  it('renders through a caller catalog with English fallback', () => {
    const model = buildFormModel({
      type: 'object', required: ['name'],
      properties: { name: { type: 'string', minLength: 3 } },
    });
    const name = model.children[0];

    assert.strictEqual(validateField(name, undefined, nlForms)[0].message, 'Dit veld is verplicht');
    assert.strictEqual(validateField(name, 'ab', nlForms)[0].message,
      'Moet ten minste 3 tekens bevatten (nu 2)');

    // a sparse catalog falls back to English per key
    const sparse = compileMessageCatalog({ 'form/required': 'Verplicht!' });
    assert.strictEqual(validateField(name, undefined, sparse)[0].message, 'Verplicht!');
    assert.strictEqual(validateField(name, 'ab', sparse)[0].message,
      'Must be at least 3 characters (currently 2)');
  });

  it('validateAllFields threads the catalog', () => {
    const model = buildFormModel({
      type: 'object', required: ['name'],
      properties: { name: { type: 'string' } },
    });
    const errors = validateAllFields(model, {}, nlForms);
    assert.strictEqual(errors['/name'][0].message, 'Dit veld is verplicht');
  });
});

describe('x-form.message as a MessageSpec', () => {
  function compiledFor(schema) {
    return compileFormRules(buildFormModel(schema));
  }

  it('a plain string stays valid (inline template, params interpolated)', () => {
    const compiled = compiledFor({
      type: 'object',
      properties: {
        a: { 'x-form': { assert: { $ne: ['$value', 1] }, message: 'bad value at {pointer}' } },
      },
    });
    const result = evaluateFormRules(compiled, { a: 1 });
    assert.deepStrictEqual(result['/a'].errors, [{
      keyword: 'x-form/assert', msgid: 'x-form/assert',
      params: { pointer: '/a' },
      message: 'bad value at /a',
    }]);
  });

  it('the $msgid form resolves through the catalog, inline fallback on miss', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { 'x-form': {
          assert: { $ne: ['$value', 1] },
          message: { $msgid: 'myapp.not-one', message: 'may not be one', params: { hint: 'x' } },
        } },
      },
    };
    const compiled = compileFormRules(buildFormModel(schema));

    // no catalog: built-in English lacks the key -> inline fallback
    const en = evaluateFormRules(compiled, { a: 1 });
    assert.deepStrictEqual(en['/a'].errors, [{
      keyword: 'x-form/assert', msgid: 'myapp.not-one',
      params: { hint: 'x', pointer: '/a' },
      message: 'may not be one',
    }]);

    // catalog carrying the key wins
    const catalog = compileMessageCatalog({ 'myapp.not-one': 'mag niet één zijn ({hint})' });
    const localized = evaluateFormRules(compiled, { a: 1 }, catalog);
    assert.strictEqual(localized['/a'].errors[0].message, 'mag niet één zijn (x)');
  });

  it('no message: the x-form/assert catalog default, pointer in params', () => {
    const compiled = compiledFor({
      type: 'object',
      properties: { a: { 'x-form': { assert: { $ne: ['$value', 1] } } } },
    });
    assert.deepStrictEqual(evaluateFormRules(compiled, { a: 1 })['/a'].errors, [{
      keyword: 'x-form/assert', msgid: 'x-form/assert',
      params: { pointer: '/a' },
      message: 'Invalid value',
    }]);
    assert.strictEqual(evaluateFormRules(compiled, { a: 1 }, nlForms)['/a'].errors[0].message,
      'Ongeldige waarde');
  });

  it('rejects malformed message specs at compile time, naming the field', () => {
    assert.throws(() => compiledFor({
      type: 'object',
      properties: { a: { 'x-form': { assert: true, message: 42 } } },
    }), /\/a x-form\/message/);
    assert.throws(() => compiledFor({
      type: 'object',
      properties: { a: { 'x-form': { assert: true, message: { params: {} } } } },
    }), /needs '\$msgid' and\/or 'message'/);
  });
});

describe('keystroke/submit unification (the point of the whole exercise)', () => {
  // ONE schema, ONE rule with a $msgid message; keystroke-time and
  // submit-time must render IDENTICAL strings, in English AND Dutch.
  const appCatalogSrc = {
    'checkout.vat-required': 'A VAT id is required for companies',
  };
  const appCatalogNlSrc = {
    'checkout.vat-required': 'Een btw-nummer is verplicht voor bedrijven',
  };

  const schema = {
    type: 'object',
    properties: {
      company: { type: 'string' },
      vatId: {
        type: 'string',
        'x-form': {
          assert: { $or: [{ $eq: ['$.company', ''] }, { $ne: ['$.vatId', ''] }] },
          message: {
            $msgid: 'checkout.vat-required',
            message: appCatalogSrc['checkout.vat-required'],
          },
        },
      },
    },
  };
  const badData = { company: 'ACME', vatId: '' };

  function submitErrors(catalogLike) {
    const submitSchema = formRulesToQueryAssertions(schema);
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validate = jaren.compile(submitSchema);
    const result = validate(badData);
    assert.strictEqual(result.valid, false);
    if (catalogLike !== undefined) {
      localizeErrors(result.errors, compileValidateCatalog(catalogLike));
    }
    return result.errors.filter(e => e.keyword === '$query');
  }

  it('renders identical strings under English', () => {
    const compiled = compileFormRules(buildFormModel(schema));
    const keystroke = evaluateFormRules(compiled, badData)['/vatId'].errors[0];

    const [submit] = submitErrors(undefined);
    assert.strictEqual(keystroke.message, 'A VAT id is required for companies');
    assert.strictEqual(submit.message, keystroke.message);
    assert.strictEqual(submit.msgid, 'checkout.vat-required');
    assert.strictEqual(keystroke.msgid, 'checkout.vat-required');
  });

  it('renders identical strings under nl', () => {
    const compiled = compileFormRules(buildFormModel(schema));
    const keystroke = evaluateFormRules(compiled, badData,
      compileMessageCatalog({ ...nl, ...appCatalogNlSrc }))['/vatId'].errors[0];

    const [submit] = submitErrors({ ...nl, ...appCatalogNlSrc });
    assert.strictEqual(keystroke.message, 'Een btw-nummer is verplicht voor bedrijven');
    assert.strictEqual(submit.message, keystroke.message);
  });

  it('submit-time $query errors carry the owning field pointer in params', () => {
    const [submit] = submitErrors(undefined);
    assert.strictEqual(submit.params.pointer, '/vatId');
  });

  it('a rule without a message unifies on the x-form/assert default, en + nl', () => {
    const bare = {
      type: 'object',
      properties: {
        a: { type: 'number', 'x-form': { assert: { $gt: ['$value', 0] } } },
      },
    };
    const data = { a: -1 };

    const compiled = compileFormRules(buildFormModel(bare));
    const keystrokeEn = evaluateFormRules(compiled, data)['/a'].errors[0];
    const keystrokeNl = evaluateFormRules(compiled, data, nlForms)['/a'].errors[0];

    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validate = jaren.compile(formRulesToQueryAssertions(bare));
    const result = validate(data);
    assert.strictEqual(result.valid, false);
    const submitEn = result.errors.find(e => e.keyword === '$query');
    assert.strictEqual(submitEn.msgid, 'x-form/assert');
    assert.strictEqual(submitEn.params.pointer, '/a');

    localizeErrors(result.errors, nlValidate);
    assert.strictEqual(keystrokeEn.message, 'Invalid value');
    assert.strictEqual(keystrokeNl.message, 'Ongeldige waarde');
    assert.strictEqual(submitEn.message, keystrokeNl.message);
  });
});

describe('static text i18n (buildFormModel options.t)', () => {
  const schema = {
    type: 'object',
    title: 'Account',
    properties: {
      firstName: { type: 'string', description: 'Given name' },
      country: {
        'x-msgid': 'account.country',
        oneOf: [
          { const: 'nl', title: 'Netherlands' },
          { const: 'be', title: 'Belgium' },
        ],
      },
      size: { enum: ['s', 'm', 'l'] },
    },
  };

  it('default behavior unchanged when no t is passed', () => {
    const model = buildFormModel(schema);
    const [firstName, country, size] = model.children;
    assert.strictEqual(model.label, 'Account');
    assert.strictEqual(firstName.label, 'First Name');
    assert.strictEqual(firstName.description, 'Given name');
    assert.strictEqual(firstName.msgid, '/firstName');
    // oneOf const/title idiom: an enum with per-option labels
    assert.strictEqual(country.kind, 'enum');
    assert.strictEqual(country.control, 'select');
    assert.deepStrictEqual(country.enumValues, ['nl', 'be']);
    assert.deepStrictEqual(country.enumLabels, ['Netherlands', 'Belgium']);
    assert.strictEqual(country.msgid, 'account.country');
    // plain enum: String(value) labels
    assert.deepStrictEqual(size.enumLabels, ['s', 'm', 'l']);
  });

  it('routes every static text through t with role-qualified msgids', () => {
    const seen = [];
    const model = buildFormModel(schema, {
      t: (msgid, fallback) => { seen.push(msgid); return fallback; },
    });
    assert.ok(model);

    // the root field's base is the empty pointer
    assert.ok(seen.includes('#label'));
    assert.ok(seen.includes('/firstName#label'));
    assert.ok(seen.includes('/firstName#description'));
    assert.ok(seen.includes('/firstName#placeholder'));
    // x-msgid overrides the pointer base
    assert.ok(seen.includes('account.country#label'));
    assert.ok(seen.includes('account.country#enum/nl'));
    assert.ok(seen.includes('account.country#enum/be'));
    assert.ok(seen.includes('/size#enum/m'));
  });

  it('t translates labels, descriptions and enum options', () => {
    const staticNl = {
      '/firstName#label': 'Voornaam',
      '/firstName#description': 'Roepnaam',
      'account.country#label': 'Land',
      'account.country#enum/nl': 'Nederland',
      'account.country#enum/be': 'België',
    };
    const model = buildFormModel(schema, {
      t: (msgid, fallback) => staticNl[msgid] ?? fallback,
    });
    const [firstName, country] = model.children;
    assert.strictEqual(firstName.label, 'Voornaam');
    assert.strictEqual(firstName.description, 'Roepnaam');
    assert.strictEqual(country.label, 'Land');
    assert.deepStrictEqual(country.enumLabels, ['Nederland', 'België']);
    // values stay raw for data binding
    assert.deepStrictEqual(country.enumValues, ['nl', 'be']);
  });
});

describe('forms message utilities', () => {
  it('compileMessageTemplate matches the validate-side syntax', () => {
    const render = compileMessageTemplate('at {pointer}: {{literal} {missing}');
    assert.strictEqual(render({ pointer: '/a' }), 'at /a: {literal} {missing}');
  });

  it('formsMessagesEn covers exactly the emitted form keys', () => {
    const expected = [
      'form/required', 'form/type', 'form/const', 'form/enum',
      'form/minLength', 'form/maxLength', 'form/pattern', 'form/format',
      'form/minimum', 'form/maximum', 'form/exclusiveMinimum', 'form/exclusiveMaximum',
      'form/multipleOf', 'form/minItems', 'form/maxItems', 'form/uniqueItems',
      'form/minProperties', 'form/maxProperties', 'x-form/assert',
      // chrome, not validation: the array buttons' accessible names
      'form/addItem', 'form/removeItem',
    ];
    assert.deepStrictEqual(Object.keys(formsMessagesEn).sort(), expected.sort());
  });

  it('formChromeLabels resolves the array buttons through a catalog', () => {
    assert.deepStrictEqual(formChromeLabels(),
      { addItem: 'Add item', removeItem: 'Remove item' });
    // the same keyspace every locale pack has to cover
    const dutch = formChromeLabels(compileMessageCatalog(nl));
    assert.strictEqual(dutch.addItem, 'Item toevoegen');
    assert.strictEqual(dutch.removeItem, 'Item verwijderen');
    // a catalog missing the keys still yields the English chrome
    assert.deepStrictEqual(formChromeLabels(compileMessageCatalog({})),
      { addItem: 'Add item', removeItem: 'Remove item' });
  });
});
