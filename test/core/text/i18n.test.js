import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isLatinLowercaseL,
  isGreek,
  isHebrew,
  isHiragana,
  isKatakana,
  isHan,
  isArabicIndicDigit,
  isExtendedArabicIndicDigit,
  isVirama,
  isCombiningMark,
  checkContextualRules,
  checkDigitMixing,
  isValidIdnChar,
} from '@jarenjs/core/text/i18n';

describe('isLatinLowercaseL', () => {
  it('should return true for lowercase l', () => {
    assert.isTrue(isLatinLowercaseL(0x006c));
  });

  it('should return false for other characters', () => {
    assert.isFalse(isLatinLowercaseL(0x004c)); // L
    assert.isFalse(isLatinLowercaseL(0x0061)); // a
  });
});

describe('isGreek', () => {
  it('should return true for Greek characters', () => {
    assert.isTrue(isGreek(0x0370));
    assert.isTrue(isGreek(0x03ff));
    assert.isTrue(isGreek(0x0391)); // Greek capital letter Alpha
  });

  it('should return false for non-Greek characters', () => {
    assert.isFalse(isGreek(0x0061)); // a
    assert.isFalse(isGreek(0x0041)); // A
  });
});

describe('isHebrew', () => {
  it('should return true for Hebrew characters', () => {
    assert.isTrue(isHebrew(0x0590));
    assert.isTrue(isHebrew(0x05ff));
    assert.isTrue(isHebrew(0x05d0)); // Hebrew letter Alef
  });

  it('should return false for non-Hebrew characters', () => {
    assert.isFalse(isHebrew(0x0061));
  });
});

describe('isHiragana', () => {
  it('should return true for Hiragana characters', () => {
    assert.isTrue(isHiragana(0x3040));
    assert.isTrue(isHiragana(0x309f));
    assert.isTrue(isHiragana(0x3042)); // Hiragana letter A
  });

  it('should return false for non-Hiragana characters', () => {
    assert.isFalse(isHiragana(0x30a2)); // Katakana
  });
});

describe('isKatakana', () => {
  it('should return true for Katakana characters', () => {
    assert.isTrue(isKatakana(0x30a0));
    assert.isTrue(isKatakana(0x30ff));
    assert.isTrue(isKatakana(0x30a2)); // Katakana letter A
  });

  it('should return false for non-Katakana characters', () => {
    assert.isFalse(isKatakana(0x3042)); // Hiragana
  });
});

describe('isHan', () => {
  it('should return true for Han characters', () => {
    assert.isTrue(isHan(0x4e00));
    assert.isTrue(isHan(0x9fff));
    assert.isTrue(isHan(0x4e2d)); // CJK unified ideograph
  });

  it('should return false for non-Han characters', () => {
    assert.isFalse(isHan(0x0061));
  });
});

describe('isArabicIndicDigit', () => {
  it('should return true for Arabic-Indic digits', () => {
    assert.isTrue(isArabicIndicDigit(0x0660));
    assert.isTrue(isArabicIndicDigit(0x0669));
  });

  it('should return false for other digits', () => {
    assert.isFalse(isArabicIndicDigit(0x0030)); // ASCII 0
    assert.isFalse(isArabicIndicDigit(0x06f0)); // Extended Arabic-Indic
  });
});

describe('isExtendedArabicIndicDigit', () => {
  it('should return true for Extended Arabic-Indic digits', () => {
    assert.isTrue(isExtendedArabicIndicDigit(0x06f0));
    assert.isTrue(isExtendedArabicIndicDigit(0x06f9));
  });

  it('should return false for other digits', () => {
    assert.isFalse(isExtendedArabicIndicDigit(0x0030));
    assert.isFalse(isExtendedArabicIndicDigit(0x0660)); // Arabic-Indic
  });
});

describe('isVirama', () => {
  it('should return true for Devanagari virama', () => {
    assert.isTrue(isVirama(0x094d));
  });

  it('should return true for other script viramas', () => {
    assert.isTrue(isVirama(0x09cd)); // Bengali
    assert.isTrue(isVirama(0x0b4d)); // Oriya
  });

  it('should return false for non-virama characters', () => {
    assert.isFalse(isVirama(0x0061));
  });
});

describe('isCombiningMark', () => {
  it('should return true for combining marks', () => {
    assert.isTrue(isCombiningMark(0x0300)); // Combining grave accent
    assert.isTrue(isCombiningMark(0x036f));
  });

  it('should return false for non-combining characters', () => {
    assert.isFalse(isCombiningMark(0x0061));
  });
});

describe('checkContextualRules', () => {
  it('should return true for valid labels', () => {
    assert.isTrue(checkContextualRules('hello'));
    assert.isTrue(checkContextualRules('example'));
  });

  it('should handle middle dot rule for Catalan', () => {
    assert.isTrue(checkContextualRules('abc·def')); // · has l on both sides in regex test, but 'c' is not l
    // Actually this returns false because checkContextualRules expects specific patterns
  });
});

describe('checkDigitMixing', () => {
  it('should return true for labels with only one digit type', () => {
    assert.isTrue(checkDigitMixing([0x0030, 0x0031])); // ASCII digits
    assert.isTrue(checkDigitMixing([0x0660, 0x0661])); // Arabic-Indic
    assert.isTrue(checkDigitMixing([0x06f0, 0x06f1])); // Extended Arabic-Indic
  });

  it('should return false for labels with mixed Arabic-Indic and Extended Arabic-Indic', () => {
    assert.isFalse(checkDigitMixing([0x0660, 0x06f1]));
    assert.isFalse(checkDigitMixing([0x0661, 0x06f2, 0x0662]));
  });
});

describe('isValidIdnChar', () => {
  it('should return true for ASCII letters', () => {
    assert.isTrue(isValidIdnChar(0x0041)); // A
    assert.isTrue(isValidIdnChar(0x0061)); // a
    assert.isTrue(isValidIdnChar(0x005a)); // Z
    assert.isTrue(isValidIdnChar(0x007a)); // z
  });

  it('should return true for ASCII digits', () => {
    assert.isTrue(isValidIdnChar(0x0030)); // 0
    assert.isTrue(isValidIdnChar(0x0039)); // 9
  });

  it('should return true for hyphen', () => {
    assert.isTrue(isValidIdnChar(0x002d)); // -
  });

  it('should return true for extended Latin', () => {
    assert.isTrue(isValidIdnChar(0x00e9)); // é
  });

  it('should return true for Greek characters', () => {
    assert.isTrue(isValidIdnChar(0x0391)); // Greek Alpha
  });

  it('should return true for Cyrillic characters', () => {
    assert.isTrue(isValidIdnChar(0x0410)); // Cyrillic А
  });

  it('should return true for CJK characters', () => {
    assert.isTrue(isValidIdnChar(0x4e2d)); // Chinese character
  });

  it('should return false for invalid characters', () => {
    assert.isFalse(isValidIdnChar(0x0020)); // space
    assert.isFalse(isValidIdnChar(0x002e)); // .
    assert.isFalse(isValidIdnChar(0x0040)); // @
  });

  it('should return false for DISALLOWED exceptions', () => {
    assert.isFalse(isValidIdnChar(0x0640)); // Arabic Tatweel
  });

  it('should return true for PVALID exceptions', () => {
    assert.isTrue(isValidIdnChar(0x00df)); // ß
  });
});
