//@ts-check

/**
 * Folding at 75 octets: a fuzz over 4-byte characters (and 2- and 3-byte
 * ones) at every offset of a line, in every TEXT property. The reader
 * holds every physical line to 75 octets and decodes each one on its own
 * with a fatal decoder, so a split code point fails; unfolded and
 * unescaped, every text comes back whole.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { stringifyIcal } from '@jarenjs/josl/ical';
import { mulberry32 } from '@jarenjs/core/random';
import { readIcal, physicalLines, unescapeText, prop } from './ical-reader.js';

const PIECES = ['😀', '𝄞', '𠀋', 'é', 'ß', '中', '€', 'a', ',', ';', '\n', String.fromCharCode(92), ' '];

/**
 * Write one event whose three text members are `text`, and read it back.
 * @param {string} text
 */
function writeText(text) {
  const out = stringifyIcal({
    prodId: '-//Example//Fold//EN',
    components: [{ type: 'event', uid: `u${text.replace(/\n/g, ' ')}`, dtstamp: 0, start: { kind: 'date', date: '2026-03-02' }, summary: text, description: text, location: text }],
  });
  return { out, vevent: readIcal(out).children[0] };
}

describe('ical: folding at 75 octets', () => {
  it('a 4-byte character at every offset of the first and the continuation lines', () => {
    for (let offset = 0; offset < 160; offset++) {
      const text = `${'a'.repeat(offset)}😀${'b'.repeat(80)}😀😀😀`;
      const { out, vevent } = writeText(text);
      const lines = physicalLines(out);
      assert.ok(lines.some((line) => line.startsWith(' ')), 'the line is folded');
      for (const name of ['SUMMARY', 'DESCRIPTION', 'LOCATION'])
        assert.strictEqual(unescapeText(prop(vevent, name)?.value ?? ''), text, `${name} at offset ${offset}`);
    }
  });

  it('a run of 4-byte characters after every prefix length fills each line to 72-75 octets', () => {
    for (let offset = 0; offset < 8; offset++) {
      const text = `${'x'.repeat(offset)}${'😀'.repeat(200)}`;
      const { out, vevent } = writeText(text);
      const encoder = new TextEncoder();
      /** @type {string[][]} */
      const groups = [];
      for (const line of physicalLines(out)) {
        if (line.startsWith(' '))
          groups[groups.length - 1].push(line);
        else
          groups.push([line]);
      }
      for (const group of groups.filter((g) => g.length > 1)) {
        for (const line of group.slice(0, -1)) {
          const octets = encoder.encode(line).length;
          assert.ok(octets <= 75 && octets >= 72, `${octets} octets`);
        }
      }
      assert.strictEqual(unescapeText(prop(vevent, 'SUMMARY')?.value ?? ''), text);
    }
  });

  it('a seeded fuzz of mixed widths and escapes', () => {
    const random = mulberry32(5545);
    for (let round = 0; round < 300; round++) {
      const length = Math.floor(random() * 400);
      let text = '';
      for (let i = 0; i < length; i++)
        text += PIECES[Math.floor(random() * PIECES.length)];
      const { vevent } = writeText(text);
      assert.strictEqual(unescapeText(prop(vevent, 'SUMMARY')?.value ?? ''), text, JSON.stringify(text));
      assert.strictEqual(unescapeText(prop(vevent, 'UID')?.value ?? ''), `u${text.replace(/\n/g, ' ')}`);
    }
  });

  it('a line of exactly 75 octets is not folded, and 76 is', () => {
    // 'SUMMARY:' is 8 octets
    const at75 = writeText('s'.repeat(67)).out.split('\r\n');
    assert.ok(at75.includes(`SUMMARY:${'s'.repeat(67)}`));
    const at76 = writeText('s'.repeat(68)).out.split('\r\n');
    assert.ok(at76.includes(`SUMMARY:${'s'.repeat(67)}`) && at76.includes(' s'));
  });
});
