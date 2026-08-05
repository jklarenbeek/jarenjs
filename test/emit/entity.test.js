//@ts-check
/**
 * @file The extension seam (EMIT-FORMAT §4.1), proven WITHOUT a
 * database in sight: a form vocabulary rides `options.extensions`
 * onto member nodes verbatim, absent means absent, unlisted keywords
 * still vanish, and a model compiled without the option stays
 * byte-identical — the seam is generic or it is wrong.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileEmitModel } from '@jarenjs/emit';

const FORM_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', 'x-form': { widget: 'text', autofocus: true } },
    rating: { type: 'integer', 'x-form': { widget: 'stars', max: 5 } },
    notes: { type: 'string' },
    secret: { type: 'string', 'x-unlisted': { hidden: true } },
  },
};

const membersOf = (model) =>
  model.declarations.find((d) => d.name === 'Review').type.members;

describe('the extension seam (§4.1)', () => {
  it('listed keywords ride the member verbatim; unlisted ones vanish', () => {
    const model = compileEmitModel(FORM_SCHEMA,
      { name: 'Review', extensions: ['x-form'] });
    const members = membersOf(model);
    assert.deepStrictEqual(
      members.find((m) => m.name === 'title').extensions,
      { 'x-form': { widget: 'text', autofocus: true } });
    assert.deepStrictEqual(
      members.find((m) => m.name === 'rating').extensions,
      { 'x-form': { widget: 'stars', max: 5 } });
    assert.strictEqual(members.find((m) => m.name === 'notes').extensions,
      undefined, 'no listed keyword, no member');
    assert.strictEqual(members.find((m) => m.name === 'secret').extensions,
      undefined, 'an unlisted keyword still vanishes');
  });

  it('the option is inert by default: models stay byte-identical', () => {
    const withOption = compileEmitModel(FORM_SCHEMA, { name: 'Review' });
    const withEmpty = compileEmitModel(FORM_SCHEMA,
      { name: 'Review', extensions: [] });
    assert.strictEqual(JSON.stringify(withEmpty), JSON.stringify(withOption));
    for (const member of membersOf(withOption))
      assert.strictEqual(member.extensions, undefined);
  });

  it('several vocabularies coexist on one member, in listed order', () => {
    const model = compileEmitModel({
      type: 'object',
      properties: {
        when: {
          type: 'string',
          'x-form': { widget: 'date' },
          'x-audit': { pii: false },
        },
      },
    }, { name: 'Row', extensions: ['x-form', 'x-audit'] });
    const member = model.declarations
      .find((d) => d.name === 'Row').type.members[0];
    assert.deepStrictEqual(member.extensions,
      { 'x-form': { widget: 'date' }, 'x-audit': { pii: false } });
    assert.deepStrictEqual(Object.keys(member.extensions),
      ['x-form', 'x-audit'], 'deterministic: the listed order');
  });

  it('the compiler never interprets a preserved keyword', () => {
    // hostile shapes pass through untouched — the seam is a copy
    const model = compileEmitModel({
      type: 'object',
      properties: {
        anything: { type: 'string', 'x-form': [1, null, { deep: ['x'] }] },
      },
    }, { name: 'Row', extensions: ['x-form'] });
    assert.deepStrictEqual(
      model.declarations.find((d) => d.name === 'Row').type.members[0].extensions,
      { 'x-form': [1, null, { deep: ['x'] }] });
  });
});
