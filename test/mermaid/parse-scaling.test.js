//@ts-check
/**
 * State-diagram parsing stays linear in hostile nesting. Deciding whether a
 * declared state was its own ancestor walked the whole parent chain for
 * every declaration, so N nested openers cost N squared: 20,000 lines
 * (about 300 KB) held the thread for seconds. The test compares two input
 * sizes, so it asserts a growth ratio and not a wall time.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid } from '@jarenjs/mermaid';

/** @param {string} source @returns {number} best of three, in ms */
function best(source) {
  let low = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    parseMermaid(source);
    low = Math.min(low, performance.now() - t);
  }
  return low;
}

const nested = (/** @type {number} */ n) => 'stateDiagram-v2\n' + Array.from({ length: n }, (_, i) => `state S${i} {`).join('\n');
const redeclared = (/** @type {number} */ n) => nested(n) + '\n' + Array.from({ length: n }, () => 'state S0 {').join('\n');

/** An ancestor near the root re-declared and closed again and again from the deepest state. */
const revisited = (/** @type {number} */ n) => nested(n) + '\n' + Array.from({ length: n }, () => 'state S1 {\n}').join('\n');

describe('stateDiagram — nested states parse in linear time', function () {
  for (const [name, make] of [['nested openers', nested], ['an outer state re-declared at depth', redeclared], ['an ancestor revisited from the deepest state', revisited]]) {
    it(`${name}: quadrupling the input costs far less than sixteen times`, () => {
      const small = Math.max(best(make(4000)), 0.5);
      const large = best(make(16000));
      // linear is about 4x, quadratic about 16x; allow for timer noise
      assert.ok(large / small < 9, `${name}: ${small.toFixed(1)} ms -> ${large.toFixed(1)} ms`);
    });
  }

  it('a chain deeper than any real diagram is never re-parented into a cycle', () => {
    const doc = parseMermaid(redeclared(3000));
    const parent = new Map(doc.ast.states.map((/** @type {any} */ s) => [s.id, s.parent]));
    for (const id of ['S0', 'S1500', 'S2999']) {
      const seen = new Set();
      for (let at = id; at !== undefined; at = parent.get(at)) {
        assert.equal(seen.has(at), false, id);
        seen.add(at);
      }
    }
  });
});
