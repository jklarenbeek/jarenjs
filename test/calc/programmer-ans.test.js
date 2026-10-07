//@ts-check
/**
 * In programmer mode the display shows the result truncated and wrapped to
 * the word, and `ans` must be that same word: it used to keep the
 * unwrapped float, so after `7/2` showed `3` the next `ans*2` answered 7,
 * and after `0xFF+1` showed `0` on an 8-bit word `ans` was 256.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { evaluate, programmerEnv } from '@jarenjs/calc';
import { calcEditEffects } from '../../components/calc/src/component/index.js';

/**
 * Run the `=` effect on `entry` and return what it commits.
 * @param {string} entry @param {any} props
 * @returns {{ value: number, display: string, entry: string }}
 */
function commit(entry, props) {
  /** @type {any[]} */
  const seen = [];
  calcEditEffects['calc-eval']({ entry, base: 'DEC', ...props }, (name, payload) => seen.push([name, payload]));
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'calc/commit');
  return seen[0][1];
}

describe('#calc programmer ans is the word the display shows', function () {
  it('truncates a fraction and wraps an overflow, signed and unsigned, at every word size', () => {
    /** @type {[string, number, boolean, number, string][]} */
    const CASES = [
      ['7/2', 8, false, 3, '3'],
      ['0xFF+1', 8, false, 0, '0'],
      ['0x7F+1', 8, true, -128, '-128'],
      ['-7/2', 8, true, -3, '-3'],
      ['0xFFFF+2', 16, false, 1, '1'],
      ['0x8000', 16, true, -32768, '-32768'],
      ['0xFFFFFFFF+1', 32, false, 0, '0'],
      ['-1', 32, false, 4294967295, '4294967295'],
      ['7/2', 64, false, 3, '3'],
      ['-1', 64, true, -1, '-1'],
    ];
    for (const [entry, wordBits, signed, value, display] of CASES) {
      const committed = commit(entry, { mode: 'programmer', wordBits, signed });
      assert.deepEqual([committed.value, committed.display, committed.entry], [value, display, display],
        `${entry} on a ${signed ? 'signed' : 'unsigned'} ${wordBits}-bit word`);
    }
  });

  it('so the next calculation uses what the user saw', () => {
    const first = commit('7/2', { mode: 'programmer', wordBits: 8, signed: false });
    const next = evaluate('ans*2', { wordBits: 8, signed: false, ans: first.value }, { env: programmerEnv() });
    assert.equal(next.value, 6);
  });

  it('leaves a value with no word, and every other mode, as it was', () => {
    const infinite = commit('1/0', { mode: 'programmer', wordBits: 8, signed: false });
    assert.equal(infinite.value, Infinity);
    assert.equal(infinite.display, '—');
    assert.equal(commit('7/2', { mode: 'standard' }).value, 3.5);
  });
});
