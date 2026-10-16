//@ts-check
/**
 * @file A root `$id` that is a relative reference names the document by
 * that reference resolved once against the base the schema is read under
 * (the validator's `origin`). A `$ref` inside it resolves against that URI,
 * whether or not the reference has a directory segment.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D2020 = 'https://json-schema.org/draft/2020-12/schema';

/** A document whose member `a` refers to a string definition beside it. @param {string} id @param {string} [defs] @param {string} [ref] */
function document(id, defs = '$defs', ref = `#/${defs}/s`) {
  return { $id: id, type: 'object', properties: { a: { $ref: ref } }, [defs]: { s: { type: 'string' } } };
}

/** @param {(value: unknown) => unknown} validate */
const answers = (validate) => [validate({ a: 'x' }), validate({ a: 1 })];

describe('a relative root $id with a directory segment', () => {
  it('compiles and answers in every draft, with $defs or definitions', () => {
    for (const schema of [
      document('sub/s.json'), document('sub/s.json', 'definitions'), document('a/b/s.json'),
      { $schema: D07, ...document('sub/s.json', 'definitions') }, { $schema: D2020, ...document('sub/s.json') },
    ]) assert.deepEqual(answers(new JarenValidator().compile(schema)), [true, false], JSON.stringify(schema));
  });

  it('resolves a reference that names the document itself, relative to it', () => {
    assert.deepEqual(answers(new JarenValidator().compile(document('sub/s.json', '$defs', 's.json#/$defs/s'))), [true, false]);
    assert.deepEqual(answers(new JarenValidator().compile(document('sub/s.json', '$defs', '../sub/s.json#/$defs/s'))), [true, false]);
  });

  it('compiles through compileAsync without loading anything', async () => {
    const asked = [];
    const validate = await compileAsync(new JarenValidator(), document('sub/s.json'),
      { loadSchema: async (/** @type {string} */ uri) => { asked.push(uri); throw new Error(`no document at ${uri}`); } });
    assert.deepEqual({ asked, answers: answers(validate) }, { asked: [], answers: [true, false] });
  });

  it('loads a document its reference names relative to it, as the compile reads it', async () => {
    const asked = [];
    const validate = await compileAsync(new JarenValidator(), { $id: 'sub/s.json', properties: { a: { $ref: 'other.json' } } },
      { loadSchema: async (/** @type {string} */ uri) => { asked.push(uri); return { type: 'string' }; } });
    assert.deepEqual({ asked, answers: answers(validate) }, { asked: ['https://github.com/jklarenbeek/sub/other.json'], answers: [true, false] });
  });

  it('derives a strict profile', () => {
    assert.deepEqual(deriveStrictProfile(document('sub/s.json')).schema, {
      type: 'object', properties: { a: { anyOf: [{ $ref: '#/$defs/s' }, { type: 'null' }] } }, required: ['a'],
      additionalProperties: false, $defs: { s: { type: 'string' } },
    });
  });

  it('leaves the readings that answered before as they were', () => {
    for (const schema of [
      document('s.json'), document('./s.json'), document('../s.json'), document('urn:x'), document('https://x.test/s.json'),
      { $id: 'https://x.test/a/root.json', properties: { a: { $ref: 'sub/n.json' } }, $defs: { n: { $id: 'sub/n.json', type: 'string' } } },
      { $schema: D07, $id: 'https://x.test/s.json', $ref: '#/definitions/d', definitions: { d: { type: 'object', properties: { a: { type: 'string' } } } } },
    ]) assert.deepEqual(answers(new JarenValidator().compile(schema)), [true, false], JSON.stringify(schema));
  });
});
