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

describe('a field fed in chunks that each hold a quote is read once, not once per chunk', () => {
  // A chunk that holds a quote may move the cutter, so it is buffered; a buffer
  // searched or copied again from the start of the pending record on every such
  // chunk does work proportional to the whole record per feed. Each shape feeds
  // chunks of about 8 KB, then ends the record.
  const run = 'b'.repeat(4000);
  const shapes = /** @type {[string, string, () => string, string][]} */ ([
    ['an unquoted field with a quote in the middle', 'a', () => run + '"' + run, '\n'],
    ['a quoted field with a lone quote in the middle', '"', () => run + '"' + run, '"\n'],
    ['a quoted field whose chunks end on a run of quotes', '"', () => run + run + '"""', '"\n'],
    ['a quoted field whose chunks end on a quote and text', '"', () => run + run + '"x', '\n'],
    ['a quoted field with a doubled quote at the end', '"', () => run + run + '""', '"\n'],
  ]);

  /** @param {string} head @param {number} chunks @param {() => string} piece @param {string} tail */
  function feedTime(head, chunks, piece, tail) {
    let fastest = Infinity;
    for (let n = 0; n < 3; n++) {
      const start = performance.now();
      const reader = createCsvStreamReader({ repair: true });
      reader.feed(head);
      for (let i = 0; i < chunks; i++) reader.feed(piece());
      reader.feed(tail);
      reader.end();
      fastest = Math.min(fastest, performance.now() - start);
    }
    return fastest;
  }

  for (const [name, head, piece, tail] of shapes) {
    it(`grows with the input at a fixed chunk size for ${name}`, () => {
      const small = Math.max(feedTime(head, 128, piece, tail), 0.5);
      const large = feedTime(head, 1024, piece, tail);
      assert.ok(large / small < 24, `8x the chunks took ${(large / small).toFixed(1)}x`);
    });
  }

  it('reads the field the whole document holds', () => {
    const together = createCsvStreamReader({ repair: true });
    together.feed('"');
    for (let i = 0; i < 3; i++) together.feed(run + '""');
    together.feed('"\nx\n');
    assert.deepEqual(together.end(), [[(run + '"').repeat(3)], ['x']]);

    const halves = createCsvStreamReader({ repair: true });
    halves.feed('"' + run + '"');
    for (let i = 0; i < 2; i++) halves.feed('"' + run + '"');
    halves.feed('\nx\n');
    assert.deepEqual(halves.end(), [[(run + '"').repeat(2) + run], ['x']]);
  });
});
