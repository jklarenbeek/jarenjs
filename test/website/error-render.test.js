//@ts-check
/**
 * @file T4 of the health pass: the website shows one error one way.
 * Both studios route error text through the single `errorMessage`
 * normalizer in lib/nodes.js, so an identical failure renders
 * identically on both pages — and a coded error's code is never
 * printed twice (the composed message already carries it; the old
 * Flow-studio hand prefix is gone).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { errorMessage, error } from '../../packages/website/src/lib/nodes.js';
import { AppCompileError } from '@jarenjs/app';
import { FlowCompileError } from '@jarenjs/flow';
import { JsonQueryCompileError } from '@jarenjs/json/query';

/** Count non-overlapping occurrences. @param {string} hay @param {string} needle */
const count = (hay, needle) => hay.split(needle).length - 1;

describe('website error rendering (one normalizer, no double code)', () => {
  const coded = [
    new AppCompileError('JA0005', 'the "subs" member must be an array of subscription entries', '/subs'),
    new FlowCompileError('JF0006', "transition 0 leaves the undeclared state 'nope'", '/transitions/0/from'),
    new JsonQueryCompileError('JQ0002', "unknown operator '$frobnicate'", '/a'),
  ];

  for (const err of coded) {
    it(`${err.name}: the code appears exactly once in the display string`, () => {
      const text = errorMessage(err);
      assert.strictEqual(text, err.message);
      assert.strictEqual(count(text, /** @type {any} */ (err).code), 1);
      assert.strictEqual(text.startsWith(`${/** @type {any} */ (err).code}: `), true);
    });

    it(`${err.name}: the error block repeats nothing the message already says`, () => {
      const block = error(/** @type {any} */ (err));
      assert.strictEqual(block.message, err.message);
      // code and docPath live in the message; the detail line must not
      // repeat them (it exists for fields the message does not carry).
      assert.strictEqual(block.detail, null);
      assert.strictEqual(block.title, /** @type {any} */ (err).code);
    });
  }

  it('a non-coded error still gets its fields in the detail line', () => {
    const err = /** @type {any} */ (Object.assign(new Error('plain'), {
      code: 'X1', docPath: '/p',
    }));
    // no `reason` → not the coded contract → fields belong in detail
    const block = error(err);
    assert.strictEqual(block.detail, 'code: X1 · docPath: /p');
  });

  it('errorMessage is total over non-errors', () => {
    assert.strictEqual(errorMessage('boom'), 'boom');
    assert.strictEqual(errorMessage(undefined), 'undefined');
    assert.strictEqual(errorMessage(null), 'null');
  });
});
