//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator, compileMessageCatalog, localizeErrors, messagesEn } from '@jarenjs/validate';
import { flagOutput, basicOutput, detailedOutput, verboseOutput, listOutput, hierarchicalOutput } from '@jarenjs/validate/output';
import { nl, fr } from '@jarenjs/locales';

/** The recording formats by their specification names. @type {Record<string, any>} */
const FORMATS = { basic: basicOutput, detailed: detailedOutput, verbose: verboseOutput, list: listOutput, hierarchical: hierarchicalOutput };
const S = 'https://json-schema.org/draft/2020-12/schema';
const NL = compileMessageCatalog(nl);
const FR = compileMessageCatalog(fr);
const EN = compileMessageCatalog(messagesEn);

/**
 * Compile `schema` for one output format and validate `data`.
 * @param {string} format @param {any} schema @param {unknown} data @param {object} [options]
 * @returns {any}
 */
const output = (format, schema, data, options = {}) =>
  new JarenValidator(/** @type {any} */ ({ outputFormat: FORMATS[format], ...options })).compile(schema)(data);

/**
 * Every text of an output, in document order: a 2020-12 unit's `error`, and
 * each entry of a `list`/`hierarchical` unit's `errors`.
 * @param {any} unit
 * @returns {string[]}
 */
function textsOf(unit) {
  /** @type {string[]} */
  const texts = [];
  const visit = (/** @type {any} */ node) => {
    if (typeof node.error === 'string') texts.push(node.error);
    if (node.errors !== undefined && !Array.isArray(node.errors)) texts.push(...Object.values(/** @type {Record<string, string>} */ (node.errors)));
    for (const key of ['errors', 'annotations', 'details']) if (Array.isArray(node[key])) node[key].forEach(visit);
  };
  visit(unit);
  return texts;
}

/** One schema, one instance: five collected errors, an anyOf whose branches both fail. */
const SCHEMA = {
  $schema: S, type: 'object',
  properties: { name: { type: 'string', minLength: 2 }, age: { type: 'integer', minimum: 0 } }, required: ['name', 'age'],
  anyOf: [{ properties: { name: { const: 'ok' } } }, { properties: { age: { maximum: -5 } } }],
};
const INSTANCE = { name: 'x', age: -1 };

describe('localizeErrors over the document an output format returned', () => {
  it('renders every text of every recording format again in a catalog, the subschema entry included', () => {
    const collected = new JarenValidator({ collectErrors: true }).compile(SCHEMA)(INSTANCE);
    const dutch = new Set([...localizeErrors(/** @type {any} */ (collected).errors, NL).map((e) => e.message), NL.subschema({})]);
    const english = new Set(textsOf(output('basic', SCHEMA, INSTANCE)));
    let slots = 0;
    for (const format of Object.keys(FORMATS)) {
      const out = output(format, SCHEMA, INSTANCE);
      const before = JSON.stringify(out);
      assert.equal(localizeErrors(out, NL), out, `${format}: the same document`);
      const texts = textsOf(out);
      assert.equal(texts.length, textsOf(JSON.parse(before)).length, format);
      for (const text of texts) {
        assert.ok(dutch.has(text), `${format}: '${text}' is not one of the Dutch messages`);
        assert.ok(!english.has(text), `${format}: '${text}' stayed English`);
      }
      slots += texts.length;
    }
    assert.equal(slots, 27);
    // basic's branch units read the pack's subschema entry
    assert.deepEqual(localizeErrors(output('basic', SCHEMA, INSTANCE), NL).errors.filter((/** @type {any} */ u) => u.keywordLocation === '').map((/** @type {any} */ u) => u.error),
      ['Een subschema bevatte fouten.']);
  });

  it('answers several readers from one validation, and the English catalog gives the output back', () => {
    for (const format of Object.keys(FORMATS)) {
      const out = output(format, SCHEMA, INSTANCE);
      const english = JSON.stringify(out);
      const inDutch = JSON.stringify(localizeErrors(out, NL));
      const inFrench = JSON.stringify(localizeErrors(out, FR));
      assert.notEqual(inDutch, english, format);
      assert.notEqual(inFrench, inDutch, format);
      assert.equal(JSON.stringify(localizeErrors(out, NL)), inDutch, `${format}: again in Dutch`);
      assert.equal(JSON.stringify(localizeErrors(out, EN)), english, `${format}: back in English`);
    }
  });

  it('re-renders each part of a joined text, and joins what renders alike once', () => {
    const app = { $schema: S, required: ['a', 'b'] };
    const missing = compileMessageCatalog({ required: 'mist {missingProperty}' });
    assert.deepEqual(localizeErrors(output('list', app, {}), missing).details[0].errors, { required: 'mist a; mist b' });
    assert.deepEqual(localizeErrors(output('hierarchical', app, {}), missing).errors, { required: 'mist a; mist b' });
    assert.deepEqual(localizeErrors(output('detailed', app, {}), missing).errors.map((/** @type {any} */ u) => u.error), ['mist a', 'mist b']);
    assert.deepEqual(localizeErrors(output('list', app, {}), compileMessageCatalog({ required: 'onvolledig' })).details[0].errors, { required: 'onvolledig' });
  });

  it('re-renders a false subschema\'s unit, keyed by the empty string', () => {
    const app = { $schema: S, additionalProperties: false };
    const catalog = compileMessageCatalog({ additionalProperties: 'kent {additionalProperty} niet', 'false schema': 'nooit' });
    assert.deepEqual(localizeErrors(output('list', app, { x: 1 }), catalog).details.map((/** @type {any} */ u) => u.errors), [{ '': 'kent x niet' }]);
    assert.deepEqual(localizeErrors(output('hierarchical', false, 1), catalog).errors, { '': 'nooit' });
    assert.deepEqual(textsOf(localizeErrors(output('basic', app, { x: 1 }), catalog)), ['kent x niet']);
  });

  it('keeps the precedence errorMessage has for collected errors', () => {
    const schema = {
      $schema: S,
      properties: {
        inline: { type: 'string', errorMessage: 'write text' },
        keyed: { type: 'number', errorMessage: { type: { $msgid: 'checkout.total', message: 'Total must be a number' } } },
        bare: { type: 'number', errorMessage: { type: { $msgid: 'checkout.bare' } } },
      },
    };
    const data = { inline: 1, keyed: 'x', bare: 'x' };
    const catalog = compileMessageCatalog({ type: 'heeft het verkeerde type', 'checkout.total': 'Totaal moet een getal zijn' });
    const collected = /** @type {any} */ (new JarenValidator({ collectErrors: true }).compile(schema)(data)).errors;
    const expected = localizeErrors(collected, catalog).map((/** @type {any} */ e) => e.message);
    assert.deepEqual(expected, ['write text', 'Totaal moet een getal zijn', 'heeft het verkeerde type']);
    for (const format of ['list', 'detailed']) {
      for (const messages of [true, false]) {
        const texts = textsOf(localizeErrors(output(format, schema, data, { messages }), catalog));
        assert.deepEqual(texts.filter((text) => !text.includes('subschema')), expected, `${format}, messages: ${messages}`);
      }
      // a catalog without the msgid keeps the author's fallback text
      assert.deepEqual(textsOf(localizeErrors(output(format, schema, data), compileMessageCatalog({}))), ['write text', 'Total must be a number', 'must be a number'], format);
    }
  });

  it('renders an output validated under messages: false, whose texts stay empty until then', () => {
    for (const format of Object.keys(FORMATS)) {
      const english = output(format, SCHEMA, INSTANCE);
      const quiet = output(format, SCHEMA, INSTANCE, { messages: false });
      assert.ok(textsOf(quiet).every((text) => text === ''), format);
      assert.deepEqual(localizeErrors(quiet, EN), english, format);
      assert.deepEqual(localizeErrors(quiet, NL), localizeErrors(english, NL), format);
    }
  });

  it('keeps the record beside the document: a copy, a spread or a unit of it re-renders nothing', () => {
    for (const format of Object.keys(FORMATS)) {
      const out = output(format, SCHEMA, INSTANCE);
      const english = JSON.stringify(out);
      const unit = out.errors?.[0] ?? out.details[0];
      const unitText = JSON.stringify(unit);
      for (const copy of [JSON.parse(english), structuredClone(out), { ...out }, unit]) localizeErrors(copy, NL);
      assert.equal(JSON.stringify(out), english, format);
      assert.equal(JSON.stringify(unit), unitText, format);
      assert.notEqual(JSON.stringify(localizeErrors(out, NL)), english, format);
    }
  });

  it('adds no member a JSON copy carries, and changes nothing a valid instance or flag answers', () => {
    const out = output('detailed', SCHEMA, INSTANCE);
    const keys = (/** @type {any} */ unit) => [Object.keys(unit), ...(unit.errors ?? []).flatMap(keys)];
    assert.deepEqual(keys(out), keys(JSON.parse(JSON.stringify(out))));
    const passing = output('list', SCHEMA, { name: 'ok', age: 1 });
    assert.equal(passing.valid, true);
    assert.deepEqual(localizeErrors(structuredClone(passing), NL), passing);
    const flag = new JarenValidator({ outputFormat: flagOutput }).compile(SCHEMA)(INSTANCE);
    assert.deepEqual(localizeErrors(flag, NL), { valid: false });
  });
});
