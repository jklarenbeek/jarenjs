//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCsvStreamReader } from '@jarenjs/josl';

/** Best of three: feed `text` in `chunks` equal pieces to a repairing reader. */
function best(/** @type {string} */ text, /** @type {number} */ chunks) {
  const size = Math.ceil(text.length / chunks);
  let fastest = Infinity;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    const reader = createCsvStreamReader({ repair: true });
    for (let i = 0; i < text.length; i += size) reader.feed(text.slice(i, i + size));
    reader.end();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

describe('the lookahead after a closing quote reads each byte once', () => {
  // `"a"` then text with no delimiter, quote or newline: every chunk leaves the
  // reader undecided between "stray text" and "a literal quote". A lookahead that
  // starts over at the quote on each chunk costs a multiple of an open quoted field.
  const stray = (/** @type {number} */ n) => '"a"' + 'b'.repeat(n);
  const open = (/** @type {number} */ n) => '"' + 'b'.repeat(n);

  it('costs about what an open quoted field of the same size costs', () => {
    for (const n of [512 * 1024, 4 * 1024 * 1024]) {
      const ratio = best(stray(n), 512) / best(open(n), 512);
      assert.ok(ratio < 3, `${n} bytes: ${ratio.toFixed(1)}x an open quoted field`);
    }
  });

  it('grows with the size at a fixed number of chunks, not with its square', () => {
    const small = best(stray(512 * 1024), 512);
    const large = best(stray(4 * 1024 * 1024), 512);
    assert.ok(large / small < 24, `8x the bytes took ${(large / small).toFixed(1)}x`);
  });
});
