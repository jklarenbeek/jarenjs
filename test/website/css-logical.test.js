//@ts-check
/**
 * The stylesheets mirror under `dir="rtl"`: a property that means "the
 * start or end of the reading direction" is written logically
 * (margin-inline-start, inset-inline-end, text-align: start, …). A physical
 * left/right stays only where the meaning is physical, each named here with
 * its reason; a new physical property fails this test until it is converted
 * or listed.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;

/** The site's, the exported host tokens' and every component's stylesheets. */
const SHEETS = [
  'packages/website/src/styles.css',
  ...readdirSync(join(ROOT, 'packages/view/styles')).filter((f) => f.endsWith('.css')).map((f) => `packages/view/styles/${f}`),
  ...readdirSync(join(ROOT, 'components')).flatMap((name) => {
    const dir = join(ROOT, 'components', name, 'styles');
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => `components/${name}/styles/${f}`) : [];
  }),
];

/** A physical left/right declaration. */
const PHYSICAL = /(?:^|[\s;{])(?:(?:margin|padding|border)-(?:left|right)(?:-[a-z]+)?|text-align:\s*(?:left|right)|float:\s*(?:left|right)|clear:\s*(?:left|right)|(?:left|right):\s)/;

/** The physical ones that mean physical, each with its reason (a substring of the line). */
const KEPT = [
  ['packages/website/src/styles.css', ':root[dir="rtl"] p[lang="en"]', 'English prose keeps the right-to-left page alignment'],
  ['packages/website/src/styles.css', 'text-align: left;', 'a README path is code (direction: ltr)'],
  ['components/md/styles/md.css', 'text-align: left;', 'diagram source is code (direction: ltr)'],
  ['components/mermaid/styles/mermaid.css', 'text-align: left;', 'a tooltip inside a diagram, a physical drawing'],
  ['components/calc/styles/calc.css', 'text-align: right;', 'a calculator display aligns its number right, as calculators do'],
  ['components/play/styles/play.css', ':root[dir="rtl"] .jplay-ex { text-align: right; }', 'an English example name keeps the right-to-left alignment'],
];

describe('website — the stylesheets mirror under right to left', () => {
  it('every left/right is logical, or listed as physical with its reason', () => {
    /** @type {string[]} */
    const found = [];
    /** @type {Set<number>} */
    const used = new Set();
    for (const sheet of SHEETS) {
      readFileSync(join(ROOT, sheet), 'utf8').split('\n').forEach((line, i) => {
        if (line.trim().startsWith('/*') || !PHYSICAL.test(line)) return;
        const kept = KEPT.findIndex(([file, text]) => file === sheet && line.includes(text));
        if (kept < 0) found.push(`${sheet}:${i + 1}: ${line.trim()}`);
        else used.add(kept);
      });
    }
    assert.deepStrictEqual(found, []);
    assert.deepStrictEqual(KEPT.filter((_, i) => !used.has(i)).map(([file, text]) => `${file}: ${text}`), [], 'every kept entry still exists');
    assert.ok(SHEETS.length >= 12, `${SHEETS.length} stylesheets read`);
  });
});
