//@ts-check
/**
 * @file The benchmark-manifest drift gate. `benchmark/website-data.js`
 * carries three hand-maintained suite lists — the header comment's
 * file manifest, the `--help` skip list, and `SUITE_ORDER` — beside the
 * tracked JSON files under `packages/website/public/benchmarks/`.
 * Nothing kept them in agreement, and by 2026-08-03 the header had
 * silently lost five suites and `--help` two. This gate parses all
 * four sources and fails on any disagreement, naming the drift.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const SOURCE = fs.readFileSync('benchmark/website-data.js', 'utf8');

/** The header comment's `<name>.json  <tool>` manifest lines. */
function headerManifest() {
  const names = new Set();
  for (const match of SOURCE.matchAll(/^ \* {3}(\w[\w-]*)\.json\s/gm)) names.add(match[1]);
  return names;
}

/** The `--help` "Suites:" list (the valid `--skip` names). */
function helpSuites() {
  const match = SOURCE.match(/'Suites: ([^']+)'/);
  assert.ok(match, 'the --help Suites line is missing');
  return new Set(match[1].split(',').map((s) => s.trim()));
}

/** The `SUITE_ORDER` array literal. */
function suiteOrder() {
  const match = SOURCE.match(/const SUITE_ORDER = \[([^\]]+)\]/);
  assert.ok(match, 'SUITE_ORDER is missing');
  return match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s.length > 0);
}

/** The tracked per-suite JSON files (meta.json is run metadata, not a suite). */
function trackedSuites() {
  return new Set(fs.readdirSync('packages/website/public/benchmarks')
    .filter((f) => f.endsWith('.json') && f !== 'meta.json')
    .map((f) => f.slice(0, -'.json'.length)));
}

describe('benchmark suite lists agree', () => {
  const order = suiteOrder();

  it('SUITE_ORDER matches the tracked JSON files exactly', () => {
    assert.deepStrictEqual([...order].sort(), [...trackedSuites()].sort());
  });

  it('the header manifest lists every suite plus meta', () => {
    const header = headerManifest();
    const expected = new Set([...order, 'meta']);
    assert.deepStrictEqual([...header].sort(), [...expected].sort());
  });

  it('the --help skip list covers every suite (qt3 is a legitimate extra)', () => {
    const help = helpSuites();
    for (const suite of order) {
      assert.ok(help.has(suite), `--help omits suite '${suite}'`);
    }
    const extras = [...help].filter((s) => !order.includes(s));
    assert.deepStrictEqual(extras, ['qt3'],
      'the only non-suite skip target is qt3 (it feeds meta.json)');
  });
});
