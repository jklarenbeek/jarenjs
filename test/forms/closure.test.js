//@ts-check
/**
 * @file The modules Node loads for `@jarenjs/forms`. Forms never runs the
 * validator: it reads a schema's same-document references and its `pattern`
 * strings through `@jarenjs/validate/references`, which loads neither the
 * validator, the normalizer nor `@jarenjs/json`'s query compiler.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { loadedAmong, loadedBy } from '../lib/module-closure.js';

describe('the modules @jarenjs/forms loads', () => {
  it('loads neither the validator nor the normalizer', () => {
    const loaded = loadedBy('@jarenjs/forms');
    assert.deepStrictEqual(loadedAmong(loaded, ['packages/validate/src/index.js', 'packages/validate/src/normalize.js']), []);
  });
});
