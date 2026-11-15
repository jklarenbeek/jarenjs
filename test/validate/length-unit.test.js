import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator, ValidatorOptions, ValidationOptions } from '@jarenjs/validate';

// Each unit's count comes from an oracle independent of the package: the
// platform's segmenter, the string iterator (one step per code point, a lone
// surrogate one step) and the code-unit length.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ORACLE = {
  grapheme: (s) => [...segmenter.segment(s)].length,
  codepoint: (s) => [...s].length,
  utf16: (s) => s.length,
};
// Written as escapes: a literal could be normalized by an editor.
const CORPUS = [
  '', 'abc', 'ééé', 'a\r\nb', '\u{1F600}\u{1F600}\u{1F600}',
  '\u{1F468}‍\u{1F469}‍\u{1F467}', 'a\u{10348}b', '\u{1F1F3}\u{1F1F1}', '가',
  'a\uD800b', '\uDC00', '\uD83D', 'été',
];
const SHAPES = {
  'minLength alone': (n) => ({ minLength: n }),
  'maxLength alone': (n) => ({ maxLength: n }),
  'type and maxLength': (n) => ({ type: 'string', maxLength: n }),
  'type and minLength': (n) => ({ type: 'string', minLength: n }),
  'type, minLength and maxLength': (n) => ({ type: 'string', minLength: n, maxLength: n }),
  'minLength and maxLength': (n) => ({ minLength: n, maxLength: n }),
  'maxLength beside a pattern': (n) => ({ type: 'string', maxLength: n, pattern: '^' }),
  'minLength beside a pattern': (n) => ({ minLength: n, pattern: '^' }),
};
const accepts = (result) => (typeof result === 'boolean' ? result : result.valid);

function agreesWith(unit, options) {
  for (const mode of [{}, { collectErrors: true }, { collectErrors: true, skipErrors: true }]) {
    const v = new JarenValidator({ ...options, ...mode });
    for (const s of CORPUS) {
      const n = ORACLE[unit](s);
      for (const [name, shape] of Object.entries(SHAPES)) {
        const at = (m) => accepts(v.compile(shape(m))(s));
        const label = `${unit} ${JSON.stringify(mode)} ${name} ${JSON.stringify(s)} n=${n}`;
        assert.equal(at(n), true, label);
        if (/max/.test(name) && !/min/.test(name) && n > 0) assert.equal(at(n - 1), false, `${label} n-1`);
        if (/min/.test(name)) assert.equal(at(n + 1), false, `${label} n+1`);
      }
    }
  }
}

describe('the validator\'s string length unit', () => {
  it('counts code points under lengthUnit: codepoint, on every compile path and in every result mode', () => {
    agreesWith('codepoint', { lengthUnit: 'codepoint' });
  });

  it('counts grapheme clusters by default and under lengthUnit: grapheme', () => {
    agreesWith('grapheme', {});
    agreesWith('grapheme', { lengthUnit: 'grapheme' });
    agreesWith('grapheme', { useGrapheme: true });
  });

  it('counts UTF-16 code units under lengthUnit: utf16 and its alias useGrapheme: false', () => {
    agreesWith('utf16', { lengthUnit: 'utf16' });
    agreesWith('utf16', { useGrapheme: false });
  });

  it('the three units answer apart on the same string', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 1 cluster, 5 code points, 8 code units
    const at = (options, n) => new JarenValidator(options).compile({ maxLength: n })(family);
    assert.deepEqual([1, 4, 5, 7, 8].map((n) => at({}, n)), [true, true, true, true, true]);
    assert.deepEqual([1, 4, 5, 7, 8].map((n) => at({ lengthUnit: 'codepoint' }, n)), [false, false, true, true, true]);
    assert.deepEqual([1, 4, 5, 7, 8].map((n) => at({ lengthUnit: 'utf16' }, n)), [false, false, false, false, true]);
  });

  it('lengthUnit wins over useGrapheme when both are given', () => {
    const astral = '\u{1F600}\u{1F600}'; // 2 code points, 4 code units
    const v = (options) => new JarenValidator(options).compile({ maxLength: 2 })(astral);
    assert.equal(v({ useGrapheme: false }), false);
    assert.equal(v({ useGrapheme: false, lengthUnit: 'grapheme' }), true);
    assert.equal(v({ useGrapheme: false, lengthUnit: 'codepoint' }), true);
    assert.equal(v({ useGrapheme: true, lengthUnit: 'utf16' }), false);
    // useGrapheme is read for truth, as every length site read it before lengthUnit
    assert.equal(v({ useGrapheme: 0 }), false);
    assert.equal(v({ useGrapheme: '' }), false);
    assert.equal(v({ useGrapheme: 1 }), true);
  });

  it('reaches the compile through every way of passing options', () => {
    const astral = '\u{1F600}\u{1F600}';
    const schema = { maxLength: 3 };
    // the option alone, with no other validation option beside it
    assert.equal(new JarenValidator({ lengthUnit: 'utf16' }).compile(schema)(astral), false);
    assert.equal(new JarenValidator(new ValidatorOptions({ lengthUnit: 'utf16' })).compile(schema)(astral), false);
    const positional = new ValidationOptions(true, true, false, null, 7, true, null, true, 'ignore', false,
      'handrews-01', 256, undefined, 128, 'utf16');
    assert.equal(positional.lengthUnit, 'utf16');
    assert.equal(new JarenValidator({ validation: positional }).compile(schema)(astral), false);
    assert.equal(new ValidationOptions().lengthUnit, undefined, 'unset: useGrapheme decides');
  });

  it('holds at a place another $schema governs', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: { d7: { $id: 'urn:length-unit:d7', $schema: 'http://json-schema.org/draft-07/schema#', maxLength: 3 } },
      $ref: 'urn:length-unit:d7',
    };
    const astral = '\u{1F600}\u{1F600}';
    assert.equal(new JarenValidator({ lengthUnit: 'utf16' }).compile(schema)(astral), false);
    assert.equal(new JarenValidator({ lengthUnit: 'codepoint' }).compile(schema)(astral), true);
  });

  it('a $data bound counts in the same unit as a static one', () => {
    for (const lengthUnit of ['grapheme', 'codepoint', 'utf16']) {
      const v = new JarenValidator({ lengthUnit });
      for (const keyword of ['minLength', 'maxLength']) {
        const dynamic = v.compile({ properties: { value: { [keyword]: { $data: '1/limit' } } } });
        for (const value of CORPUS) {
          for (const limit of [0, 1, 2, 3, 5, 8]) {
            assert.equal(dynamic({ value, limit }), v.compile({ [keyword]: limit })(value),
              `${lengthUnit} ${keyword} ${JSON.stringify(value)} ${limit}`);
          }
        }
      }
    }
  });

  it('refuses a unit it does not know when a schema compiles', () => {
    for (const lengthUnit of ['bytes', 'code-point', 'UTF16', true, 1, null]) {
      if (lengthUnit === null) {
        // null is "unset", like every other option of the plain-object form
        assert.equal(new JarenValidator({ lengthUnit }).compile({ maxLength: 1 })('\u{1F600}'), true);
        continue;
      }
      const v = new JarenValidator({ lengthUnit });
      assert.throws(() => v.compile({ maxLength: 1 }), (error) => error instanceof TypeError
        && /lengthUnit must be 'grapheme', 'codepoint' or 'utf16'/.test(error.message), String(lengthUnit));
    }
  });
});
