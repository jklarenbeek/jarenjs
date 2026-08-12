//@ts-check
/**
 * @file `@jarenjs/core/chunk` — the four ways the suite cuts something
 * down to size, and the properties every caller of them relies on.
 *
 * These are small functions with large consequences: `sizeOf` is what an
 * agent's history budget is spent in, `excerpt` is what a slot's
 * metadata shows of a megabyte, `truncate` is where an oversized tool
 * result stops, and `chunkText` decides what an address points at. Each
 * one is tested for the property its callers assume rather than for its
 * happy path.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { sizeOf, excerpt, truncate, chunkText } from '@jarenjs/core/chunk';

describe('core/chunk — sizeOf', function () {
  it('measures a string as itself and anything else as its JSON', function () {
    assert.strictEqual(sizeOf('abc'), 3);
    assert.strictEqual(sizeOf({ role: 'user', content: 'hi' }),
      JSON.stringify({ role: 'user', content: 'hi' }).length);
    assert.strictEqual(sizeOf([1, 2, 3]), 7);
    assert.strictEqual(sizeOf(42), 2);
  });

  it('is total: undefined and null both cost the four characters they send', function () {
    assert.strictEqual(sizeOf(undefined), 4);
    assert.strictEqual(sizeOf(null), 4);
  });

  it('is exact, which is what makes a budget hold', function () {
    const message = { role: 'tool', content: 'x'.repeat(1000) };
    assert.strictEqual(sizeOf(message), JSON.stringify(message).length);
  });
});

describe('core/chunk — excerpt and truncate', function () {
  it('excerpt collapses whitespace, trims and marks the cut', function () {
    assert.strictEqual(excerpt('  a \n\t b  ', 40), 'a b');
    assert.strictEqual(excerpt('abcdef', 3), 'abc…');
    assert.strictEqual(excerpt('abc', 3), 'abc', 'an exact fit is not a cut');
  });

  it('excerpt is total over what a store or a provider may not have', function () {
    assert.strictEqual(excerpt(undefined, 10), '');
    assert.strictEqual(excerpt(null, 10), '');
    assert.strictEqual(excerpt(1234, 2), '12…');
  });

  it('truncate keeps newlines and says it cut', function () {
    assert.strictEqual(truncate('a\nb', 10), 'a\nb');
    assert.strictEqual(truncate('abcdef', 3), 'abc… [truncated]');
    assert.strictEqual(truncate('abcdef', 3, '…'), 'abc…', 'the marker is the caller\'s');
  });
});

describe('core/chunk — chunkText', function () {
  const text = Array.from({ length: 20 }, (unused, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');

  it('splits by size into pieces that reassemble into the original', function () {
    const pieces = chunkText(text, { strategy: 'size', size: 100 });
    assert.ok(pieces.length > 3);
    assert.strictEqual(pieces.map((piece) => piece.text).join(''), text,
      'nothing is lost and nothing is repeated');
    for (const piece of pieces) {
      assert.strictEqual(text.slice(piece.start, piece.end), piece.text,
        'the offsets locate the piece in its source');
    }
  });

  it('is deterministic — the same input names the same pieces', function () {
    assert.deepStrictEqual(chunkText(text, { size: 100 }), chunkText(text, { size: 100 }));
  });

  it('never splits a line under the line strategy', function () {
    const pieces = chunkText(text, { strategy: 'line', size: 90 });
    for (const piece of pieces) {
      const inner = piece.text.replace(/\n$/, '');
      for (const line of inner.split('\n')) {
        assert.match(line, /^line \d+ x*$/, 'a piece holds whole lines');
      }
    }
    assert.strictEqual(pieces.map((piece) => piece.text).join(''), text);
  });

  it('gives an oversized unit its own piece rather than cutting it', function () {
    const long = `short\n${'y'.repeat(500)}\nshort`;
    const pieces = chunkText(long, { strategy: 'line', size: 50 });
    const big = pieces.find((piece) => piece.text.includes('y'.repeat(500)));
    assert.ok(big !== undefined, 'the long line survives whole');
    assert.ok(big.text.length > 50, 'even though it is over the size');
    assert.strictEqual(pieces.map((piece) => piece.text).join(''), long);
  });

  it('groups separator-delimited units and keeps their separators', function () {
    const paragraphs = ['one', 'two', 'three', 'four'].map((w) => `${w} ${'z'.repeat(30)}`).join('\n\n');
    const pieces = chunkText(paragraphs, { strategy: 'separator', size: 80 });
    assert.ok(pieces.length >= 2);
    assert.strictEqual(pieces.map((piece) => piece.text).join(''), paragraphs);
  });

  it('overlaps on request, so a match spanning a cut is whole somewhere', function () {
    const plain = chunkText(text, { size: 100 });
    const lapped = chunkText(text, { size: 100, overlap: 20 });
    assert.ok(lapped.length > plain.length, 'overlap costs pieces');
    assert.strictEqual(lapped[1].start, lapped[0].end - 20);
    assert.ok(lapped.at(-1).end === text.length, 'and it still reaches the end exactly once');
  });

  it('answers an empty text with no pieces at all', function () {
    assert.deepStrictEqual(chunkText('', { size: 10 }), []);
    assert.deepStrictEqual(chunkText(null, { size: 10 }), []);
  });

  it('survives a degenerate size instead of looping forever', function () {
    const pieces = chunkText('abcdef', { size: 0 });
    assert.strictEqual(pieces.length, 6, 'a size below one is one');
    assert.strictEqual(chunkText('abcdef', { size: 3, overlap: 99 }).at(-1).end, 6,
      'an overlap at or beyond the size cannot stall the walk');
  });
});
