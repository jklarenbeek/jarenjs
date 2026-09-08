//@ts-check
/** Canonical ids, placeholder parity and locale renderer compatibility, without serializing code. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as p from '@jarenjs/linq/messages';
import { compileMessageTemplate, compileMessageCatalog } from '@jarenjs/core/message';
import { messagesEn, JarenValidator } from '@jarenjs/validate';
import { formsMessagesEn } from '@jarenjs/forms';
import { contractMessagesEn } from '@jarenjs/contract';
import * as locales from '@jarenjs/locales';
import { catalogParameters, messagePenArtifacts } from '../../scripts/generate-message-pen.js';

const english = { validate: messagesEn, forms: formsMessagesEn, contract: contractMessagesEn };
const all = Object.assign({}, ...Object.values(english));
const keys = Object.keys(all);
const packs = Object.entries(locales).filter(([, value]) => value && typeof value === 'object' && keys.every((id) => Object.hasOwn(value, id)));
const onlyStrings = (values) => Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string'));
const grammar = (ids, complete = false) => new JarenValidator().compile({ type: 'object', propertyNames: { enum: ids }, additionalProperties: { type: 'string' }, ...(complete ? { required: ids } : {}) });
const params = { type: 'integer', types: ['string', 'number'], missingProperty: 'name', additionalProperty: 'extra', comparison: '>=', limit: 2,
  multipleOf: 3, pattern: 'abc', format: 'email', code: 'JQ2001', docPath: '/a', constValue: 'x', enumValues: ['a', 'b'], len: 1,
  op: 'load', allow: 'GET', media: 'json', kind: 'in-flight', header: 'x-id', name: 'Error', status: 500, id: 'shop',
  server: '2', client: '1', ms: 100, attempts: 3, lastCode: 'JC2051' };

describe('messages pen', () => {
  it('derives every key and parameter from English and gates both generated artifacts', () => {
    assert.deepEqual(Object.values(english).map((catalog) => Object.keys(catalog).length), [30, 21, 37]);
    assert.equal(keys.length, 88);
    for (const [source, catalog] of Object.entries(english)) assert.deepEqual(p.CATALOGS[source], catalogParameters(catalog));
    const out = messagePenArtifacts();
    assert.equal(readFileSync(new URL('../../packages/linq/src/messages/vocabulary.js', import.meta.url), 'utf8'), out.vocabulary);
    assert.equal(readFileSync(new URL('../../packages/linq/types/message-vocabulary.d.ts', import.meta.url), 'utf8'), out.declarations);
    assert.ok(Object.isFrozen(p.CATALOGS.forms['form/minLength']));
  });
  it('reads placeholders through the render compiler, including duplicates and escaped/unclosed braces', () => {
    const render = compileMessageTemplate('{{name} {n} {n} {unfinished');
    assert.deepEqual(render.parameters, ['n']);
    assert.equal(render({ n: 3 }), '{name} 3 3 {unfinished');
    assert.deepEqual(compileMessageTemplate('literal').parameters, []);
    assert.throws(() => { render.parameters.push('other'); }, TypeError);
    assert.throws(() => { render.parameters = []; }, TypeError);
  });
  it('does not guess parameter contracts for opaque render closures', () => {
    assert.throws(() => catalogParameters({ x: (p) => JSON.stringify(p) }), /opaque/);
    assert.throws(() => catalogParameters({ x: (p) => p[p.key] }), /dynamic/);
  });
  it('emits English template entries exactly and keeps function entries at their renderer boundary', () => {
    const strings = onlyStrings(all);
    const doc = p.catalog('all', 'en').entries(strings).partial();
    assert.equal(JSON.stringify(doc), JSON.stringify(strings));
    assert.equal(grammar(keys)(doc), true);
    const render = compileMessageCatalog(doc);
    for (const id of Object.keys(doc)) assert.equal(render[id](params), compileMessageCatalog(all)[id](params));
  });
  it('censuses every published locale export rather than silently skipping a broken pack', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../packages/locales/package.json', import.meta.url), 'utf8'));
    const exports = Object.keys(manifest.exports).filter((key) => /^\.\/(?:[a-z]{2}|zh-tw)$/.test(key));
    assert.equal(exports.length, 11);
    assert.equal(packs.length, exports.length);
  });
  for (const [locale, pack] of packs) {
    it(`${locale}: required ids, placeholder contracts, exact JSON templates and full renderer compatibility`, () => {
      const selected = Object.fromEntries(keys.map((id) => [id, pack[id]]));
      assert.deepEqual(catalogParameters(selected), catalogParameters(all));
      const strings = onlyStrings(selected);
      const emitted = p.catalog('all', locale).entries(strings).partial();
      assert.equal(JSON.stringify(emitted), JSON.stringify(strings));
      assert.equal(grammar(keys)(emitted), true);
      const compiled = compileMessageCatalog(emitted);
      const original = compileMessageCatalog(pack);
      for (const id of keys) {
        assert.equal(typeof original[id](params), 'string');
        if (Object.hasOwn(compiled, id)) assert.equal(compiled[id](params), original[id](params));
      }
      // Contract catalogs are entirely JSON strings: every locale completes
      // without altering or flattening any plural/number formatting function.
      const contract = Object.fromEntries(Object.keys(contractMessagesEn).map((id) => [id, pack[id]]));
      const complete = p.catalog('contract', locale).entries(contract).complete();
      assert.equal(JSON.stringify(complete), JSON.stringify(contract));
      assert.equal(grammar(Object.keys(contractMessagesEn), true)(complete), true);
    });
  }
  it('can complete every source with deliberate JSON string replacements for function entries', () => {
    for (const [source, original] of Object.entries(english)) {
      const strings = Object.fromEntries(Object.entries(original).map(([id, value]) => [id,
        typeof value === 'string' ? value : p.CATALOGS[source][id].map((name) => `{${name}}`).join(' ')]));
      const doc = p.catalog(source).entries(strings).complete();
      assert.equal(JSON.stringify(doc), JSON.stringify(strings));
      assert.equal(grammar(Object.keys(original), true)(doc), true);
      for (const render of Object.values(compileMessageCatalog(doc))) assert.equal(typeof render(params), 'string');
    }
  });
  it('tracks immutable entries and refuses incomplete drafts even through JSON.stringify', () => {
    const start = p.catalog('contract', 'en');
    const partial = start.entry('contract/not-found', 'No operation');
    assert.deepEqual(start.partial(), {});
    assert.deepEqual(partial.partial(), { 'contract/not-found': 'No operation' });
    assert.throws(() => partial.complete(), /incomplete contract/);
    assert.throws(() => JSON.stringify(partial), /incomplete contract/);
    const complete = start.entries(contractMessagesEn);
    assert.equal(JSON.stringify(complete), JSON.stringify(contractMessagesEn));
    assert.deepEqual(p.from(complete.complete(), { source: 'contract' }).complete(), contractMessagesEn);
    assert.deepEqual(p.from({}).partial(), {});
    const input = { 'form/required': 'Required' };
    const draft = p.catalog('forms').entries(input); input['form/required'] = 'changed';
    assert.throws(() => draft.complete(), /incomplete forms/);
    assert.throws(() => p.catalog('forms').entry(Object.keys(input)[0], 'Required').complete(), /incomplete forms/);
    assert.equal(draft.partial()['form/required'], 'Required');
    assert.equal(Object.isFrozen(input), false);
    assert.ok(Object.isFrozen(draft.partial()));
  });
  it('reports locale, id and missing/extra placeholder before publication', () => {
    assert.throws(() => p.catalog('contract', 'nl').entry('contract/body-too-large', 'Operatie {op}, {limti}'), /nl\/contract\/body-too-large:.*missing \[limit\], extra \[limti\]/);
    assert.throws(() => p.catalog('forms').entry('unknown', 'x'), /unknown message id/);
    assert.throws(() => p.from({ typo: 'x' }).complete(), /unknown message id/);
    assert.throws(() => p.from({ 'contract/body-too-large': '{op}' }).partial(), /missing \[limit\]/);
    assert.throws(() => p.catalog('forms').entries({ 'form/required': () => 'x' }), { code: 'JL0101' });
    for (const make of [() => p.catalog('unknown'), () => p.catalog('forms', ''), () => p.from(null),
      () => p.inline(1), () => p.message('unknown'), () => p.message('minimum', { params: { typo: 1 } }),
      () => p.message('form/required', { params: { typo: 1 } }),
      () => p.message('minimum', { message: '{typo}' }), () => p.message('minimum', { params: [] }),
      () => p.from({ ['__proto__']: 'x' }).partial()]) assert.throws(make, { code: 'JL0101' });
  });
  it('emits the existing structured MessageSpec and runs it through the validator', () => {
    const message = p.message('minimum', { params: { limit: 10 }, message: 'At least {limit}' });
    assert.deepEqual(message, { $msgid: 'minimum', params: { limit: 10 }, message: 'At least {limit}' });
    const validate = new JarenValidator({ collectErrors: true }).compile({ type: 'number', minimum: 5, errorMessage: message });
    const result = validate(1);
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].message, 'must be >= 10');
    const inline = p.inline('Custom {limit}');
    assert.equal(new JarenValidator({ collectErrors: true }).compile({ minimum: 5, errorMessage: inline })(1).errors[0].message, 'Custom 5');
  });
});
