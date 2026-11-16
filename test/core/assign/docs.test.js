//@ts-check
/**
 * The docs gate for docs/ASSIGN.md: every ```js fence is run as printed,
 * as a module beside the workspace's node_modules so
 * `@jarenjs/core/assign` resolves as it does for a consumer, and a
 * ```json fence right after one must be the JSON of the fence's one
 * export. The prose shows what the engine answers, never a copy of it.
 * The code table is held to ASSIGN_CODES by test/errors/code-tables.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fencesOf } from '../../../scripts/check-documents.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOC = path.join(ROOT, 'packages/core/docs/ASSIGN.md');

/** @param {string} code @returns {Promise<Record<string, unknown>>} */
async function run(code) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-assign-docs-'));
  try {
    const file = path.join(dir, 'example.mjs');
    fs.writeFileSync(file, code);
    return await import(pathToFileURL(file).href);
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('docs/ASSIGN.md', () => {
  const fences = fencesOf(fs.readFileSync(DOC, 'utf8'));
  const examples = fences.map((fence, i) => ({ fence, next: fences[i + 1] })).filter(({ fence }) => fence.lang === 'js');

  it('has examples, and every one shown with its answer exports one value', () => {
    assert.ok(examples.length >= 6, `${examples.length} js fences`);
    assert.ok(examples.filter(({ next }) => next?.lang === 'json').length >= 5);
  });

  for (const { fence, next } of examples) {
    it(`the example at line ${fence.line} runs as printed${next?.lang === 'json' ? ' and answers the JSON after it' : ''}`, async () => {
      const module = await run(fence.body);
      if (next?.lang !== 'json') return;
      const values = Object.values(module);
      assert.strictEqual(values.length, 1, 'one export');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(values[0])), JSON.parse(next.body));
    });
  }
});
