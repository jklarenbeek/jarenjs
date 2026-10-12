//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCsvStreamReader } from '@jarenjs/josl';

/** Best of three: feed `text` to a repairing reader in pieces of `size` characters. */
function best(/** @type {string} */ text, /** @type {number} */ size) {
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
  // starts over at the quote on each chunk reads the whole tail again per chunk,
  // so at a fixed chunk size its work grows with the square of the input.
  const stray = (/** @type {number} */ n) => '"a"' + 'b'.repeat(n);

  it('grows with the input at a fixed chunk size, not with its square', () => {
    const small = Math.max(best(stray(512 * 1024), 4096), 0.5);
    const large = best(stray(4 * 1024 * 1024), 4096);
    // eight times the bytes: linear is about 8x, a rescan per chunk about 64x
    assert.ok(large / small < 24, `8x the bytes took ${(large / small).toFixed(1)}x`);
  });
});

describe('an open quoted field is read once, not once per chunk', () => {
  // `"` then text with no quote: the field stays open to the end. A reader that
  // joins every chunk onto the pending text and searches it again for the
  // closing quote does work proportional to the whole field on every feed.
  const open = (/** @type {number} */ n) => '"' + 'b'.repeat(n);

  it('grows with the input at a fixed chunk size, not with its square', () => {
    const small = Math.max(best(open(512 * 1024), 4096), 0.5);
    const large = best(open(4 * 1024 * 1024), 4096);
    assert.ok(large / small < 24, `8x the bytes took ${(large / small).toFixed(1)}x`);
  });
});
