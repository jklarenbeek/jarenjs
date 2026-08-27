//@ts-check
/**
 * @file The docs gate for PENS-FORMAT.md: every ```js fence of a pen
 * section is executed — written as a module beside the workspace's
 * `node_modules` so `@jarenjs/linq/schema` resolves as it does for a
 * consumer — and the ```json fence that follows it must be the document
 * the fence's one export emits. The prose is what the pen writes, never
 * a copy of it.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { schemaOf } from '@jarenjs/linq/schema';

const DOC = new URL('../../packages/linq/docs/PENS-FORMAT.md', import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const CACHE = path.join(ROOT, 'node_modules', '.cache-pens-format');

/** The (js, json) fence pairs of one `### N.M` subsection, in order. */
function fencePairs(markdown, heading) {
  const start = markdown.indexOf(`\n### ${heading}`);
  assert.notStrictEqual(start, -1, `section '${heading}' exists`);
  const next = markdown.indexOf('\n#', start + 1);
  const section = markdown.slice(start, next === -1 ? undefined : next);
  const fences = [...section.matchAll(/```(js|json)\n([\s\S]*?)```/g)]
    .map((m) => ({ lang: m[1], body: m[2] }));
  const pairs = [];
  for (let i = 0; i < fences.length; i++) {
    if (fences[i].lang !== 'js') continue;
    assert.strictEqual(fences[i + 1]?.lang, 'json', 'every js fence is followed by its json fence');
    pairs.push({ js: fences[i].body, json: fences[i + 1].body });
  }
  return pairs;
}

describe('PENS-FORMAT §2 — the worked examples are what the pen emits', () => {
  const markdown = fs.readFileSync(DOC, 'utf8');
  const pairs = fencePairs(markdown, '2.2 Worked examples');
  fs.mkdirSync(CACHE, { recursive: true });

  it('has worked examples to run', () => {
    assert.ok(pairs.length >= 5, `${pairs.length} fence pairs`);
  });

  pairs.forEach((pair, i) => {
    it(`example ${i + 1} emits its json fence`, async () => {
      const file = path.join(CACHE, `schema-example-${i + 1}.mjs`);
      fs.writeFileSync(file, pair.js);
      const mod = await import(`${file}?${Date.now()}`);
      const names = Object.keys(mod);
      assert.strictEqual(names.length, 1, `one export per fence, got ${names.join(', ')}`);
      assert.deepStrictEqual(schemaOf(mod[names[0]]), JSON.parse(pair.json));
    });
  });
});

describe('PENS-FORMAT §1.3 — the code table is the code', () => {
  it('lists exactly the JL01xx codes LINQ_CODES carries, each with a condition', async () => {
    const { LINQ_CODES } = await import('@jarenjs/linq');
    const markdown = fs.readFileSync(DOC, 'utf8');
    const documented = [...markdown.matchAll(/^\| `(JL01\d\d)` \|/gm)].map((m) => m[1]);
    const carried = Object.keys(LINQ_CODES).filter((code) => /^JL01/.test(code));
    assert.deepStrictEqual(documented, carried);
  });
});
