import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashContent } from '@jarenjs/core/string';
import { previewTextEdits } from '../../scripts/preview-text-edits.js';

test('file proposal preview awaits syntax validation, leaves original untouched and returns a reviewable diff', async () => {
  const text = 'export const answer = 1;\n', files = [{ path: 'answer.js', text, hash: hashContent(text) }];
  const edit = { op: 'replace_section', path: 'answer.js', anchor: text, baseHash: files[0].hash, replacement: 'export const answer = 2;\n' };
  const result = await previewTextEdits(files, [edit]);
  assert.equal(result.valid, true); assert.match(result.plan.diff, /\+export const answer = 2/);
  assert.equal(files[0].text, text);
  const refused = await previewTextEdits(files, [{ ...edit, replacement: 'export const = ;\n' }]);
  assert.equal(refused.valid, false); assert.equal(refused.errors[0].code, 'SYNTAX');
  assert.equal((await previewTextEdits(files, [{ ...edit, baseHash: 'stale' }])).valid, false);
});
