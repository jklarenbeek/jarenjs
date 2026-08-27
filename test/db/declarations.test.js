//@ts-check
/**
 * @file The shipped declarations equal the runtime, subpath by subpath.
 * `@jarenjs/db` hand-authors its `.d.ts` files (no generation step), so
 * nothing but a test can notice a runtime export the declarations do
 * not carry, or a declared name that does not exist — and both had
 * happened: twenty-seven exports were undeclared, `collectEntityRoots`
 * was declared and not exported, and the wasm subpath's two helpers
 * the website builds on were invisible to a consumer's `tsc`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { diffDeclarations } from '../lib/declarations-diff.js';

const SUBPATHS = [
  ['@jarenjs/db', 'packages/db/types/index.d.ts'],
  ['@jarenjs/db/node', 'packages/db/types/node.d.ts'],
  ['@jarenjs/db/bun', 'packages/db/types/bun.d.ts'],
  ['@jarenjs/db/wasm', 'packages/db/types/wasm.d.ts'],
  ['@jarenjs/db/typed', 'packages/db/types/typed.d.ts'],
  ['@jarenjs/db/app', 'packages/db/types/app.d.ts'],
];

describe('the declarations equal the runtime', () => {
  for (const [specifier, file] of SUBPATHS) {
    it(`${specifier} declares every runtime export and nothing else`, async () => {
      const { undeclared, phantom } = await diffDeclarations(specifier, file);
      assert.deepStrictEqual(undeclared, [], `exported at runtime, undeclared in ${file}`);
      assert.deepStrictEqual(phantom, [], `declared in ${file}, absent at runtime`);
    });
  }
});
