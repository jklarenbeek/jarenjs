//@ts-check
/**
 * @file A validation that throws leaves no anchor in the dynamic scope. A
 * `$ref` into a resource registers that resource's `$dynamicAnchor`s one by
 * one, building each anchor's validator on first use; where a later one
 * does not build, the refusal is thrown with the earlier ones registered.
 * They stayed in scope for every later call of the validator, so a
 * `$dynamicRef` of that name in another resource was answered by the
 * abandoned resource's schema. No call stack is involved: the frame
 * restores the scope it found however it ends.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

const D20 = 'https://json-schema.org/draft/2020-12/schema';

/** @param {object} [options] */
const compile = (options) => new JarenValidator(options)
  // entering this resource registers `node` (a string), then fails to build `other`
  .addSchema({ $schema: D20, $id: 'urn:scope:broken', type: 'object',
    $defs: { a: { $dynamicAnchor: 'node', type: 'string' }, b: { $dynamicAnchor: 'other', pattern: '[' } } })
  // a tree of integers that recurses through its own `node`
  .addSchema({ $schema: D20, $id: 'urn:scope:tree', $dynamicAnchor: 'node', type: 'object',
    properties: { v: { type: 'integer' }, child: { $dynamicRef: '#node' } } })
  .compile({ $schema: D20, properties: { bad: { $ref: 'urn:scope:broken' }, good: { $ref: 'urn:scope:tree' } } });

/** @param {any} result */
const verdict = (result) => (typeof result === 'boolean' ? result : result.valid);

describe('the dynamic scope after a validation that threw', () => {
  for (const [mode, options] of /** @type {[string, object|undefined][]} */ ([['first failure', undefined], ['collectErrors', { collectErrors: true }]])) {
    it(`holds no anchor of the abandoned resource (the tree's child was then read as a string): ${mode}`, () => {
      const tree = { good: { v: 1, child: { v: 2 } } };
      const wrong = { good: { v: 1, child: { v: 'x' } } };
      const validate = compile(options);
      assert.throws(() => validate({ bad: {} }), { name: 'SchemaCompileError', code: 'JK0014' });
      assert.deepEqual([verdict(validate(tree)), verdict(validate(wrong))], [true, false]);
      // the refusal is the same on a second call, and the scope as clean after it
      assert.throws(() => validate({ bad: {} }), { name: 'SchemaCompileError', code: 'JK0014' });
      assert.deepEqual([verdict(validate(tree)), verdict(validate(wrong))], [true, false]);
      // as a validator that never met the broken resource answers
      const fresh = compile(options);
      assert.deepEqual([verdict(fresh(tree)), verdict(fresh(wrong))], [true, false]);
    });
  }
});
