//@ts-check
/**
 * @file The jaren-contract-port frame grammar artifact: the draft-07
 * twin is the mechanical downlevel of the 2020-12 source, the source
 * stays in the draft-neutral subset, every frame shape the binding
 * emits validates under both drafts, and the malformed shapes the
 * binding classifies (`JC2073`) or ignores fail the grammar.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';
import {
  downlevelDraft07,
  draftNeutralSubsetViolations,
  mapRefs,
} from '../json/schema-artifact-helpers.js';
import { load } from './helpers.js';

const schema = load('../../packages/contract/schemas/jaren-contract-port.schema.json');
const schema07 = load('../../packages/contract/schemas/jaren-contract-port.draft-07.schema.json');

/** @param {any} artifact */
function compileGrammar(artifact) {
  return new JarenValidator().addFormats(jsonFormats).compile(artifact);
}

describe('the jaren-contract-port schema artifact', () => {
  it('stays in the draft-neutral subset and its draft-07 twin is in sync', () => {
    assert.deepStrictEqual(draftNeutralSubsetViolations(schema), []);
    assert.deepStrictEqual(schema07, mapRefs(downlevelDraft07(schema)),
      'regenerate the committed twin from the canonical artifact');
    assert.strictEqual(schema.$id, 'https://jarenjs.dev/schemas/jaren-contract-port/0.1');
    assert.strictEqual(schema07.$id, 'https://jarenjs.dev/schemas/jaren-contract-port/0.1/draft-07');
  });

  const positives = [
    ['a request', { jaren: 'contract/0.1', id: 'c0ffee:1', op: 'data.rows', input: { collection: 'notes' } }],
    ['an input-less request', { jaren: 'contract/0.1', id: 'c0ffee:2', op: 'ping', input: null }],
    ['a request with the reserved members', { jaren: 'contract/0.1', id: 'c0ffee:3', op: 'a.b', input: {}, attempt: 7, key: 'k-1' }],
    ['a success response', { jaren: 'contract/0.1', id: 'c0ffee:1', ok: true, value: [1, 2], trace: 't-1' }],
    ['a null-valued success', { jaren: 'contract/0.1', id: 'c0ffee:1', ok: true, value: null, trace: 't-1' }],
    ['a declared-error response', { jaren: 'contract/0.1', id: 'c0ffee:1', ok: false, error: { code: 'conflict', message: 'm', details: { current: 1 }, retryable: false }, trace: 't-1' }],
    ['a taxonomy-error response', { jaren: 'contract/0.1', id: 'c0ffee:1', ok: false, error: { code: 'JC2071', message: 'm', retryable: false }, trace: 't-1' }],
    ['a cancel', { jaren: 'contract/0.1', cancel: 'c0ffee:1' }],
  ];

  const negatives = [
    ['no marker', { id: 'c:1', op: 'a', input: null }],
    ['a wrong version', { jaren: 'contract/0.2', id: 'c:1', op: 'a', input: null }],
    ['an unscoped id', { jaren: 'contract/0.1', id: 'r1', op: 'a', input: null }],
    ['a zero sequence', { jaren: 'contract/0.1', id: 'c:0', op: 'a', input: null }],
    ['two colons', { jaren: 'contract/0.1', id: 'a:b:1', op: 'a', input: null }],
    ['an uppercase op', { jaren: 'contract/0.1', id: 'c:1', op: 'Data.Rows', input: null }],
    ['a missing input', { jaren: 'contract/0.1', id: 'c:1', op: 'a' }],
    ['an unknown request member', { jaren: 'contract/0.1', id: 'c:1', op: 'a', input: null, extra: 1 }],
    ['a success without value', { jaren: 'contract/0.1', id: 'c:1', ok: true, trace: 't' }],
    ['an error without trace', { jaren: 'contract/0.1', id: 'c:1', ok: false, error: { code: 'x', message: 'm' } }],
    ['both value and error', { jaren: 'contract/0.1', id: 'c:1', ok: true, value: 1, error: { code: 'x', message: 'm' }, trace: 't' }],
    ['ok false with value', { jaren: 'contract/0.1', id: 'c:1', ok: false, value: 1, trace: 't' }],
    ['a non-boolean ok', { jaren: 'contract/0.1', id: 'c:1', ok: 'yes', value: 1, trace: 't' }],
    ['an empty trace', { jaren: 'contract/0.1', id: 'c:1', ok: true, value: 1, trace: '' }],
    ['an error without code', { jaren: 'contract/0.1', id: 'c:1', ok: false, error: { message: 'm' }, trace: 't' }],
    ['an error code of the wrong shape', { jaren: 'contract/0.1', id: 'c:1', ok: false, error: { code: 'JC207', message: 'm' }, trace: 't' }],
    ['an uppercase declared code', { jaren: 'contract/0.1', id: 'c:1', ok: false, error: { code: 'Conflict', message: 'm' }, trace: 't' }],
    ['a cancel of an unscoped id', { jaren: 'contract/0.1', cancel: 'r1' }],
    ['a cancel with extras', { jaren: 'contract/0.1', cancel: 'c:1', id: 'c:1' }],
    ['the website ping', { ping: 'token' }],
  ];

  it('accepts every frame shape the binding emits, under both drafts', () => {
    const validate = compileGrammar(schema);
    const validate07 = compileGrammar(schema07);
    for (const [what, frame] of positives) {
      assert.strictEqual(validate(frame), true, `2020-12 must accept ${what}`);
      assert.strictEqual(validate07(frame), true, `draft-07 must accept ${what}`);
    }
  });

  it('refuses the malformed shapes the binding classifies or ignores, under both drafts', () => {
    const validate = compileGrammar(schema);
    const validate07 = compileGrammar(schema07);
    for (const [what, frame] of negatives) {
      assert.strictEqual(validate(frame), false, `2020-12 must refuse ${what}`);
      assert.strictEqual(validate07(frame), false, `draft-07 must refuse ${what}`);
    }
  });
});
