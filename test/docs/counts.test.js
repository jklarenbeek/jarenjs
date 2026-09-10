//@ts-check
/**
 * @file The documented-count drift gate. Prose that states how many
 * engines, chart types, locale packs, file kinds, doc sections or
 * benchmark suites exist is quoting a number the code owns. Left
 * unguarded those counts rot silently: the website README claimed
 * fourteen benchmark suites against nineteen on disk and twenty-seven
 * documentation sections against thirty-one.
 *
 * Where a document also ENUMERATES the things it counts, the list is
 * asserted instead of (or as well as) the number — a list says which one
 * is missing, a number only says that one is.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINES } from '@jarenjs/play';
import { KINDS } from '@jarenjs/studio';
import { docsSections } from '../../packages/website/src/app/viewmodel.js';
import { buildSiteContent } from '../../scripts/generate-site-data.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const listDir = (rel) => fs.readdirSync(path.join(ROOT, rel));

/** Number words as the docs spell them; prose says "thirteen", not "13". */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one',
  'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five', 'twenty-six',
  'twenty-seven', 'twenty-eight', 'twenty-nine', 'thirty', 'thirty-one',
  'thirty-two', 'thirty-three', 'thirty-four', 'thirty-five'];

/** The count a sentence states, read back as a number (-1 when absent). */
function statedCount(text, before, after) {
  const pattern = new RegExp(`${before}\\s*([a-z-]+)\\s*${after}`, 'i');
  const match = pattern.exec(text);
  assert.ok(match, `no sentence matching /${before} … ${after}/`);
  return WORDS.indexOf(match[1].toLowerCase());
}

const chartTypes = listDir('components/charts/src/types').filter((f) => f.endsWith('.js'));
// a pack is named by its locale tag, which is what tells it apart from
// the package's shared modules without a growing exclusion list
const localePacks = listDir('packages/locales/src')
  .filter((f) => /^[a-z]{2}(-[a-z]{2})?\.js$/.test(f));
const benchmarkSuites = listDir('packages/website/public/benchmarks')
  .filter((f) => f.endsWith('.json') && f !== 'meta.json');

describe('documented counts match the code', () => {
  it('the website README states the real benchmark-suite and docs-section counts', () => {
    const doc = read('packages/website/README.md');
    assert.strictEqual(statedCount(doc, 'Benchmarks, all', 'suites'), benchmarkSuites.length);
    // the page is the site's own sections PLUS the ones the packages
    // commit in their workspaces, so the claim is counted over the merge
    assert.strictEqual(statedCount(doc, '\\*\\*Docs & Examples\\.\\*\\*', 'documentation sections'),
      docsSections(buildSiteContent()).length);
  });

  it('the play engine count matches the registry, in every document that states it', () => {
    assert.strictEqual(statedCount(read('packages/website/README.md'), ':', 'live engines'),
      Object.keys(ENGINES).length);
    assert.strictEqual(statedCount(read('docs/ROADMAP.md'), 'registry lacks\\*\\* —', 'ship'),
      Object.keys(ENGINES).length);
  });

  it('the chart-type count matches the type modules', () => {
    // anchored to each document's own phrasing: a bare "<word> types"
    // would match whichever sentence happened to come first
    assert.strictEqual(statedCount(read('README.md'), 'pure-vnode SVG,', 'types'), chartTypes.length);
    assert.strictEqual(statedCount(read('components/charts/README.md'), 'chart library\\.', 'types:'),
      chartTypes.length);
    assert.strictEqual(statedCount(read('components/charts/ARCHITECTURE.md'), '\\n', 'types follow the contract'),
      chartTypes.length);
  });

  it('the locale packs are counted AND enumerated correctly', () => {
    const readme = read('README.md');
    assert.strictEqual(statedCount(readme, '', 'ship \\('), localePacks.length);
    // the parenthesised list must name every pack that ships
    const match = /\bship \(([^)]+)\)/.exec(readme);
    assert.ok(match, 'the locale README sentence no longer enumerates its packs');
    const listed = match[1].split(',').map((s) => s.trim().replace(/`/g, ''));
    const onDisk = localePacks.map((f) => f.replace('.js', ''));
    // docs spell zh-tw as zhTW; compare case- and separator-insensitively
    const norm = (s) => s.toLowerCase().replace(/-/g, '');
    assert.deepStrictEqual(listed.map(norm).sort(), onDisk.map(norm).sort());
  });

  it('the studio file-kind count matches KINDS', () => {
    assert.strictEqual(statedCount(read('components/studio/README.md'), '`KINDS` lists all', ''), KINDS.length);
  });
});
