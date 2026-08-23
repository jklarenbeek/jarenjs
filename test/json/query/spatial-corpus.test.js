//@ts-check
/**
 * @file The spatial corpus, run through the JavaScript engine.
 *
 * `test/json/fixtures/spatial-corpus.json` is the spatial ORACLE:
 * every case carries the answer this engine gives, so a second
 * executor — a predicate pushed to SQLite, the same query in a browser
 * tab through the wasm driver — can assert it returns exactly the same
 * thing and a divergence names which executor moved. That only works if
 * the recorded answers stay true of the engine that recorded them,
 * which is what this file checks on every run.
 *
 * The fixture is generated, never hand-typed:
 * `node scripts/generate-spatial-corpus.js --write` rewrites it and
 * the same script without `--write` fails on drift. An entry carries
 * `expected` OR `empty: true` — JSON cannot spell the empty sequence,
 * and `null` is a real answer that has to stay distinguishable from
 * "no answer".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { queryJson } from '@jarenjs/json/query';

/** @type {Array<any>} */
const CORPUS = JSON.parse(
  readFileSync(new URL('../fixtures/spatial-corpus.json', import.meta.url), 'utf8'));

describe('the spatial corpus', () => {
  it('should be a well-formed oracle', () => {
    assert.ok(CORPUS.length >= 60, `only ${CORPUS.length} entries`);
    const names = new Set();
    const malformed = [];
    for (const entry of CORPUS) {
      if (names.has(entry.name))
        malformed.push(`${entry.name}: duplicate name`);
      names.add(entry.name);
      if (typeof entry.name !== 'string' || entry.name.length === 0)
        malformed.push('an entry with no name');
      if (entry.query === undefined)
        malformed.push(`${entry.name}: no query`);
      if (entry.data === undefined)
        malformed.push(`${entry.name}: no data`);
      // exactly one of the two answer shapes
      if ((entry.empty === true) === ('expected' in entry))
        malformed.push(`${entry.name}: carries both an expected value and empty:true, or neither`);
      if (entry.executors !== undefined && !Array.isArray(entry.executors))
        malformed.push(`${entry.name}: executors must be a list`);
    }
    assert.deepStrictEqual(malformed, []);
  });

  it('should still get the answer it recorded, for every entry', () => {
    const moved = [];
    for (const entry of CORPUS) {
      const actual = queryJson(entry.query, entry.data);
      if (entry.empty === true) {
        if (actual !== undefined)
          moved.push(`${entry.name}: recorded the empty sequence, answered ${JSON.stringify(actual)}`);
        continue;
      }
      try {
        assert.deepStrictEqual(actual, entry.expected);
      }
      catch {
        moved.push(`${entry.name}: recorded ${JSON.stringify(entry.expected)}, answered ${JSON.stringify(actual)}`);
      }
    }
    assert.deepStrictEqual(moved, [],
      'regenerate with scripts/generate-spatial-corpus.js --write and read the diff');
  });

  it('should cover every operator of the spatial family', () => {
    const documents = JSON.stringify(CORPUS.map((entry) => entry.query));
    const family = [
      '$bbox', '$area', '$length', '$centroid', '$distance', '$within',
      '$bbox-intersects', '$geohash', '$geo-parse', '$geo-text',
      '$geohash-bounds', '$geohash-neighbours', '$geo-simplify',
    ];
    const uncovered = family.filter((op) => !documents.includes(`"${op}"`));
    assert.deepStrictEqual(uncovered, [], 'a spatial operator with no corpus case');
  });

  it('should mark the entries a second executor cannot answer', () => {
    // A WKT string is text THIS engine writes; a SQL executor asked for
    // the same query has no such spelling. Marking them is what lets a
    // later order skip them on purpose rather than by accident.
    const marked = CORPUS.filter((entry) => entry.executors !== undefined);
    assert.ok(marked.length > 0, 'nothing is marked engine-only');
    for (const entry of marked) {
      assert.deepStrictEqual(entry.executors, ['engine'], entry.name);
      assert.ok(JSON.stringify(entry.query).includes('$geo-text'),
        `${entry.name} is marked engine-only but does not write text`);
    }
    // and nothing else quietly is
    const unmarked = CORPUS.filter((entry) => entry.executors === undefined
      && JSON.stringify(entry.query).includes('$geo-text'));
    assert.deepStrictEqual(unmarked.map((e) => e.name), []);
  });
});
