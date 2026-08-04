//@ts-check
/**
 * @file Item 5 of the health pass: forms' private `resolveLocalRef` was
 * a strictly weaker re-implementation of the exported
 * `resolveSameDocumentRef` — it resolved only `#/pointer` fragments, so
 * a form schema using `$ref: "#"` (the document root) or `#anchor` (a
 * plain `$anchor`) silently rendered its field as `unknown`. These
 * tests were written FAILING against that behaviour and pin the fix:
 * forms now resolves the same three fragment forms the validator does,
 * through the validator's own exported resolver.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildFormModel } from '@jarenjs/forms';

describe('forms resolve the same $ref forms the validator does', () => {
  it('a pointer fragment resolves (the behaviour that always worked)', () => {
    const model = buildFormModel({
      type: 'object',
      $defs: { name: { type: 'string', title: 'Name' } },
      properties: { name: { $ref: '#/$defs/name' } },
    });
    assert.strictEqual(model.children[0].kind, 'string');
  });

  it('an $anchor fragment resolves instead of rendering unknown', () => {
    const model = buildFormModel({
      type: 'object',
      $defs: { street: { $anchor: 'street', type: 'string', title: 'Street' } },
      properties: { street: { $ref: '#street' } },
    });
    assert.strictEqual(model.children[0].kind, 'string');
    assert.strictEqual(model.children[0].label, 'Street');
  });

  it('the root fragment (#) resolves instead of rendering unknown', () => {
    const model = buildFormModel({
      type: 'object',
      properties: {
        name: { type: 'string' },
        self: { $ref: '#' },
      },
    });
    assert.strictEqual(model.children[0].kind, 'string');
    // The self-reference resolves to the root object shape (and its
    // descent is depth-capped, not infinite).
    assert.strictEqual(model.children[1].kind, 'object');
    assert.strictEqual(model.children[1].children[0].kind, 'string');
  });

  it('an anchor inside an embedded $id scope stays out of reach (validator scope rules)', () => {
    const model = buildFormModel({
      type: 'object',
      $defs: {
        embedded: { $id: 'https://example.test/inner', $anchor: 'hidden', type: 'string' },
      },
      properties: { field: { $ref: '#hidden' } },
    });
    // The validator's same-document scope does not descend into an
    // embedded resource, so this stays unresolvable — and unknown.
    assert.strictEqual(model.children[0].kind, 'unknown');
  });
});
