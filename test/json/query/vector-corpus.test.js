//@ts-check
/**
 * @file The vector corpus, run through the JavaScript engine.
 *
 * `test/json/fixtures/vector-corpus.json` is the vector ORACLE: every
 * case carries the answer this engine gives, so a second executor —
 * the same k-nearest document planned against a store, the same query
 * in a browser tab — can assert it returns exactly the same thing and a
 * divergence names which executor moved. That only works if the
 * recorded answers stay true of the engine that recorded them, which is
 * what this file checks on every run.
 *
 * The fixture is generated, never hand-typed:
 * `node scripts/generate-vector-corpus.js --write` rewrites it and the
 * same script without `--write` fails on drift. An entry carries
 * `expected`, `empty: true` or `error` — JSON cannot spell the empty
 * sequence, `null` is a real answer that has to stay distinguishable
 * from "no answer", and a refused operand is a third outcome a second
 * executor must reproduce as a refusal rather than as a value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { queryJson, JsonQueryRuntimeError } from '@jarenjs/json/query';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GENERATOR = path.join(ROOT, 'scripts/generate-vector-corpus.js');
const FIXTURE = path.join(ROOT, 'test/json/fixtures/vector-corpus.json');

const CORPUS = JSON.parse(readFileSync(FIXTURE, 'utf8'));
/** @type {Array<any>} */
const ENTRIES = CORPUS.entries;

describe('the vector corpus', () => {
  it('should be a well-formed oracle', () => {
    assert.ok(ENTRIES.length >= 30, `only ${ENTRIES.length} entries`);
    assert.ok(Number.isInteger(CORPUS.seed), 'the corpus does not record its seed');
    assert.ok(Array.isArray(CORPUS.externals.query),
      'the corpus does not record the query vector its entries are asked with');
    const names = new Set();
    const malformed = [];
    for (const entry of ENTRIES) {
      if (names.has(entry.name))
        malformed.push(`${entry.name}: duplicate name`);
      names.add(entry.name);
      if (typeof entry.name !== 'string' || entry.name.length === 0)
        malformed.push('an entry with no name');
      if (entry.query === undefined)
        malformed.push(`${entry.name}: no query`);
      if (entry.data === undefined)
        malformed.push(`${entry.name}: no data`);
      // exactly one of the three answer shapes
      const shapes = ['expected' in entry, entry.empty === true, 'error' in entry]
        .filter(Boolean).length;
      if (shapes !== 1)
        malformed.push(`${entry.name}: carries ${shapes} answer shapes, not exactly one`);
      // an entry whose data is a LIST is a COLLECTION case: its data is
      // a set of documents and its query a phrase over them, which is
      // what lets a relational executor store the rows and plan the
      // query as written instead of wrapping one document
      if ((entry.collection === true) !== Array.isArray(entry.data))
        malformed.push(`${entry.name}: the collection flag and the data shape disagree`);
    }
    assert.deepStrictEqual(malformed, []);
  });

  it('should still get the answer it recorded, for every entry', () => {
    const moved = [];
    let ran = 0;
    for (const entry of ENTRIES) {
      ran += 1;
      if ('error' in entry) {
        try {
          const actual = queryJson(entry.query, entry.data, CORPUS.externals);
          moved.push(`engine disagreed on ${entry.name}: recorded ${entry.error}, answered ${JSON.stringify(actual)}`);
        }
        catch (e) {
          if (!(e instanceof JsonQueryRuntimeError) || e.code !== entry.error)
            moved.push(`engine disagreed on ${entry.name}: recorded ${entry.error}, threw ${/** @type {any} */ (e).code ?? e}`);
        }
        continue;
      }
      const actual = queryJson(entry.query, entry.data, CORPUS.externals);
      if (entry.empty === true) {
        if (actual !== undefined)
          moved.push(`engine disagreed on ${entry.name} — query ${JSON.stringify(entry.query)}: recorded the empty sequence, answered ${JSON.stringify(actual)}`);
        continue;
      }
      try {
        assert.deepStrictEqual(actual, entry.expected);
      }
      catch {
        moved.push(`engine disagreed on ${entry.name} — query ${JSON.stringify(entry.query)}: recorded ${JSON.stringify(entry.expected)}, answered ${JSON.stringify(actual)}`);
      }
    }
    assert.deepStrictEqual(moved, [],
      'regenerate with scripts/generate-vector-corpus.js --write and read the diff');
    // the count, not the absence of failures: a runner that quietly ran
    // nothing passes every per-entry check above
    assert.ok(ENTRIES.length > 0, 'nothing to run');
    assert.strictEqual(ran, ENTRIES.length, 'the engine ran fewer entries than the corpus carries');
  });

  it('should cover the operator, all three outcomes and the k-nearest shapes', () => {
    const documents = ENTRIES.map((entry) => JSON.stringify(entry.query));
    const idle = ENTRIES.filter((entry, i) => !documents[i].includes('$similarity'));
    assert.deepStrictEqual(idle.map((entry) => entry.name), [],
      'a corpus entry that does not exercise the operator');
    // all three answer shapes are represented, or the runner's three
    // branches are not all proven
    for (const shape of ['expected', 'empty', 'error']) {
      const held = ENTRIES.filter((entry) => shape === 'empty'
        ? entry.empty === true
        : shape in entry);
      assert.ok(held.length > 0, `no entry answers with '${shape}'`);
    }
    // the composition QUERY-FORMAT §8.15 publishes as k-nearest, at
    // several k, plus the two cases only a PLAN can get wrong
    const ranked = ENTRIES.filter((entry) => JSON.stringify(entry.query).includes('$orderby'));
    assert.ok(ranked.length >= 5, `only ${ranked.length} ranking entries`);
    const windowed = ranked.filter((entry) => JSON.stringify(entry.query).includes('$subsequence'));
    assert.ok(windowed.length >= 4, `only ${windowed.length} windowed entries`);
    const names = ENTRIES.map((entry) => entry.name);
    for (const required of ['knn/ties-survive-input-order', 'knn/top-3']) {
      assert.ok(names.includes(required), `the corpus lost '${required}'`);
    }
    // every collection case reads the member a store declares a vector
    // column over, so a later executor stores rows rather than rewriting
    // the corpus
    for (const entry of ENTRIES.filter((e) => e.collection === true)) {
      assert.ok(JSON.stringify(entry.query).includes('embedding'),
        `${entry.name}: a collection case that does not read 'embedding'`);
    }
  });
});

describe('the vector corpus generator', () => {
  it('is deterministic: two runs into a temp dir are byte-identical, and so is the committed fixture', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vector-corpus-'));
    try {
      const run = (name) => {
        const out = path.join(dir, name);
        const result = spawnSync(process.execPath, [GENERATOR, '--write', '--out', out],
          { cwd: ROOT, encoding: 'utf8' });
        assert.strictEqual(result.status, 0, result.stderr);
        return readFileSync(out);
      };
      const first = run('a.json');
      const second = run('b.json');
      assert.ok(first.equals(second), 'the second run differs from the first');
      assert.ok(first.equals(readFileSync(FIXTURE)),
        'the committed fixture differs from the generator — run node scripts/generate-vector-corpus.js --write and read the diff');
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
