//@ts-check
/**
 * @file A pie's title reads where Mermaid reads it: on the header line
 * (`pie title Pets`, Mermaid's own docs example) as on a line of its own,
 * with a later title replacing an earlier one, and `showData` read only
 * before the header's title; a `%%` comment ends a title and may follow a
 * slice. Each expectation is what Mermaid 11 reads for the same source.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid } from '@jarenjs/mermaid';

/** @param {string} source */
const read = (source) => {
  const { title, showData, slices } = /** @type {any} */ (parseMermaid(source).ast);
  return { title, showData, slices: slices.map((/** @type {any} */ s) => [s.label, s.value]) };
};

describe('a pie title on the header line', () => {
  it("reads Mermaid's docs example", () => {
    assert.deepEqual(read('pie title Pets adopted by volunteers\n    "Dogs" : 386\n    "Cats" : 85\n    "Rats" : 15'),
      { title: 'Pets adopted by volunteers', showData: false, slices: [['Dogs', 386], ['Cats', 85], ['Rats', 15]] });
  });

  it('reads the text after the keyword as written, past a showData', () => {
    const cases = [
      ['pie showData title Key elements', 'Key elements', true],
      ['pie   title   Pets  ', 'Pets', false],
      ['pie\ttitle Tabbed', 'Tabbed', false],
      ['pie title Pets: adopted', 'Pets: adopted', false],
      ['pie title "Pets"', '"Pets"', false],
      ['pie title Pets showData', 'Pets showData', false],
      ['pie showData title', null, true],
      ['pie title', null, false],
    ];
    for (const [header, title, showData] of cases) {
      assert.deepEqual(read(`${header}\n "Dogs" : 1`), { title, showData, slices: [['Dogs', 1]] }, String(header));
    }
  });

  it('reads no title from a header without the keyword', () => {
    for (const header of ['pie', 'pie showData', 'pie titled']) {
      assert.equal(read(`${header}\n "Dogs" : 1`).title, null, header);
    }
    assert.equal(read('pie showData\n "Dogs" : 1').showData, true);
  });
});

describe('a pie title on its own line', () => {
  it('reads as before, a tab after the keyword too', () => {
    assert.equal(read('pie\n title Pets\n "Dogs" : 1').title, 'Pets');
    assert.equal(read('pie\n title\tTabbed own line\n "Dogs" : 1').title, 'Tabbed own line');
    assert.equal(read('pie\n title : 5\n "Dogs" : 1').title, ': 5');
    assert.deepEqual(read('pie\n titled X\n "Dogs" : 1'), { title: null, showData: false, slices: [['Dogs', 1]] });
  });

  it('replaces a title read before it, and a blank one leaves none', () => {
    assert.equal(read('pie title Pets\n title Other\n "Dogs" : 1').title, 'Other');
    assert.equal(read('pie title A\n title\n "Dogs" : 1').title, null);
  });
});

describe('a %% comment after a pie statement', () => {
  it('ends a title in either place, quoted or not', () => {
    assert.equal(read('pie title Pets %% a comment\n "Dogs" : 1').title, 'Pets');
    assert.equal(read('pie\n title Pets %% c\n "Dogs" : 1').title, 'Pets');
    assert.equal(read('pie title A "b %% c"\n "Dogs" : 1').title, 'A "b');
    assert.equal(read('pie\n title %% c\n "Dogs" : 1').title, null);
  });

  it('keeps the slice it follows, and a quoted label keeps its own %%', () => {
    assert.deepEqual(read('pie\n "Dogs" : 1 %% c\n "Cats" : 2').slices, [['Dogs', 1], ['Cats', 2]]);
    assert.deepEqual(read('pie\n "Dogs" : 1%%c').slices, [['Dogs', 1]]);
    assert.deepEqual(read('pie\n "50%% off" : 3').slices, [['50%% off', 3]]);
    assert.equal(read('pie showData %% c\n "Dogs" : 1').showData, true);
  });
});

describe('printing a header-line title', () => {
  it('prints it on its own line, which reads back the same', () => {
    const source = 'pie showData title Key elements\n "Calcium" : 42.96\n "Iron" : 5';
    const text = toMermaid(parseMermaid(source));
    assert.equal(text, 'pie showData\ntitle Key elements\n"Calcium" : 42.96\n"Iron" : 5\n');
    assert.deepEqual(read(text), read(source));
  });
});
