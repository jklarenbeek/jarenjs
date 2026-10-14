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
import { growthRatio } from '../lib/growth.js';

const nested = (/** @type {number} */ n) => 'stateDiagram-v2\n' + Array.from({ length: n }, (_, i) => `state S${i} {`).join('\n');
const redeclared = (/** @type {number} */ n) => nested(n) + '\n' + Array.from({ length: n }, () => 'state S0 {').join('\n');

/** An ancestor near the root re-declared and closed again and again from the deepest state. */
const revisited = (/** @type {number} */ n) => nested(n) + '\n' + Array.from({ length: n }, () => 'state S1 {\n}').join('\n');

describe('stateDiagram — nested states parse in linear time', function () {
  for (const [name, make] of [['nested openers', nested], ['an outer state re-declared at depth', redeclared], ['an ancestor revisited from the deepest state', revisited]]) {
    it(`${name}: eight times the input costs far less than sixty-four times`, () => {
      // linear is about 8x, quadratic about 64x; the limit sits near their
      // geometric mean, so a host the gate loads in parallel cannot reach it
      const ratio = growthRatio(parseMermaid, make(2000), make(16000), { limit: 24 });
      assert.ok(ratio < 24, `${name}: eight times the input multiplied the time by ${ratio.toFixed(1)}`);
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
