//@ts-check
/**
 * @file The drift gates of bounded iteration, in one place: every
 * page-producing path drains the one page implementation with BOTH its
 * bounds spelled, so a future page cannot be added without `limit` and
 * `maxBytes`; exactly one cursor interface and one `item_too_large`
 * refusal exist; and the streamable iteration paths never materialise
 * (the C1 gate lives beside the cursor suite in
 * `test/linq/async-cursor.test.js`, and is repeated here by reference so
 * a reader finds the three together).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const sources = () => fs.readdirSync('packages/db/src').filter((name) => name.endsWith('.js'));

describe('the page-bound gate', () => {
  it('every page-producing path drains the shared page with both limit and maxBytes', () => {
    const drains = [];
    for (const file of sources()) {
      const source = read(`packages/db/src/${file}`);
      let at = source.indexOf('drainPage(cursor, {');
      while (at >= 0) {
        const call = source.slice(at, source.indexOf('})', at));
        drains.push({ file, call });
        at = source.indexOf('drainPage(cursor, {', at + 1);
      }
    }
    assert.deepStrictEqual(drains.map((drain) => drain.file).sort(), ['capture.js', 'query.js'],
      'the entity page and the change page — and no page anywhere else');
    for (const { file, call } of drains) {
      assert.match(call, /\blimit\b/, `${file}: the page passes its row bound`);
      assert.match(call, /\bmaxBytes\b/, `${file}: the page passes its byte bound`);
      assert.match(call, /\bsizeOf\b/, `${file}: the page measures its items`);
    }
    // and the drain itself is defined exactly once, applying both bounds
    const cursor = read('packages/db/src/cursor.js');
    assert.strictEqual((cursor.match(/export function drainPage\(/g) ?? []).length, 1);
    assert.match(cursor, /items\.length >= limit/);
    assert.match(cursor, /bytes \+ size > maxBytes/);
  });
});

describe('the one-implementation gate', () => {
  it('exactly one QueryCursor interface, one cursor mechanism, one item_too_large refusal', () => {
    const declared = read('packages/db/types/index.d.ts');
    assert.strictEqual((declared.match(/interface QueryCursor</g) ?? []).length, 1);
    assert.strictEqual(sources().filter((file) => /export function createCursor\(/.test(read(`packages/db/src/${file}`))).length, 1);
    const sites = sources().filter((file) => read(`packages/db/src/${file}`).includes("'JD2074'"));
    assert.deepStrictEqual(sites, ['cursor.js']);
    // every engine reads its rows through that one cursor
    for (const file of ['query.js', 'capture.js']) {
      assert.match(read(`packages/db/src/${file}`), /createCursor\(\{/, `${file} builds its cursor on the mechanism`);
    }
  });
});

describe('the C1 gate, by reference', () => {
  it('the cursor suite holds the streamable branches to no .all() and no toArray()', () => {
    const suite = read('test/linq/async-cursor.test.js');
    assert.match(suite, /the streamable provider branch names no toArray and pushes no window/);
    assert.match(suite, /the cursor module knows neither \.all\(\) nor toArray\(\)/);
    const graph = read('test/linq/db-graph.test.js');
    assert.match(graph, /the graph cursor path calls no \.all\(\) and no toArray\(\)/);
  });
});
