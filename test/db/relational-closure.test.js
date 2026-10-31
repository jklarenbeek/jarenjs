//@ts-check
/**
 * @file The modules Node loads for `@jarenjs/db/relational`. The model's
 * entity walk resolves `$ref` and merges `allOf` through
 * `@jarenjs/validate/references`, which loads no validator; validation
 * arrives only through the injected `compileSchema` hook.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { loadedAmong, loadedBy } from '../lib/module-closure.js';

describe('the modules @jarenjs/db/relational loads', () => {
  it('loads neither the validator nor the normalizer', () => {
    const loaded = loadedBy('@jarenjs/db/relational');
    assert.deepStrictEqual(loadedAmong(loaded, ['packages/validate/src/index.js', 'packages/validate/src/normalize.js']), []);
  });
});
