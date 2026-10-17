//@ts-check
/**
 * @file A plain-name reference is typed by the target the validator reaches:
 * a fragment-only `$id` (`$id: '#foo'`, the draft-07 spelling of an anchor)
 * names its schema object as an `$anchor` does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emitTypeScript } from '@jarenjs/emit/typescript';
import { JarenValidator } from '@jarenjs/validate';

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

describe('emit — a fragment-only $id as a reference target', () => {
  it('types the member by its target (typed unknown)', () => {
    const schema = { $schema: DRAFT_07, definitions: { a: { $id: '#foo', type: 'integer' } }, properties: { y: { $ref: '#foo' } } };
    const validate = new JarenValidator().compile(schema);
    assert.deepEqual([validate({ y: 1 }), validate({ y: '1' })], [true, false]);
    const source = emitTypeScript(schema);
    // the target is the declared definition `a`, typed by its name
    assert.match(source, /export type Root = \{ y\?: A; \[key: string\]: unknown; \}/);
    assert.match(source, /export type A = number;/);
  });
});
