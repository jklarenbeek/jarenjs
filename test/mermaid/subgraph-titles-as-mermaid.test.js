//@ts-check
/**
 * A bare subgraph title (and the id before a bracketed one) as Mermaid's
 * lexer reads it: a `"` that starts a word opens a string, which only the
 * first word may be, an empty `""` is dropped, a `"` inside a word is text;
 * a string after the first word, or one never closed, is refused.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid } from '@jarenjs/mermaid';

const sub = (/** @type {string} */ header) => /** @type {any} */ (parseMermaid(`flowchart LR\nsubgraph ${header}\n  x\nend`).ast)
  .subgraphs.map((/** @type {any} */ g) => [g.id, g.label]);

describe('flowchart — a bare subgraph title holding a quote', () => {
  it('reads as Mermaid reads it', () => {
    /** @type {[string, [string, string]][]} */
    const cases = [
      ['"a"b', ['ab', 'ab']],
      ['"a" b', ['subGraph0', 'a b']],
      ['"a"b c', ['subGraph0', 'ab c']],
      ['"a b"c d', ['subGraph0', 'a bc d']],
      ['"a"b"c', ['ab"c', 'ab"c']],
      ['"a"b"c"', ['ab"c"', 'ab"c"']],
      ['s ""', ['subGraph0', 's']],
      ['a ""', ['subGraph0', 'a']],
      ['a "" b', ['subGraph0', 'a  b']],
      ['"" a', ['subGraph0', 'a']],
      ['a """"', ['subGraph0', 'a']],
      ['"a"""', ['a', 'a']],
      ['"""a"', ['a', 'a']],
    ];
    for (const [header, expected] of cases) assert.deepEqual(sub(header), [expected], header);
  });

  it('still reads a quote inside a word as text, and a title quoted whole', () => {
    /** @type {[string, [string, string]][]} */
    const cases = [
      ['a"b', ['a"b', 'a"b']], ['a"b"', ['a"b"', 'a"b"']], ['a""b', ['a""b', 'a""b']], ['x"y"z', ['x"y"z', 'x"y"z']],
      ['a b"', ['subGraph0', 'a b"']], ['a"b c', ['subGraph0', 'a"b c']], ['6a', ['6a', '6a']], ['-"x"', ['-"x"', '-"x"']],
      ['a-"x"', ['a-"x"', 'a-"x"']], ['a."x"', ['a."x"', 'a."x"']], ['a&"x"', ['a&"x"', 'a&"x"']], ['a_"x"', ['a_"x"', 'a_"x"']],
      ['a/"x"', ['a/"x"', 'a/"x"']], ['a!"x"', ['a!"x"', 'a!"x"']], ['"a"', ['a', 'a']], ['"a b"', ['subGraph0', 'a b']],
      ['6in" pipes', ['subGraph0', '6in" pipes']],
    ];
    for (const [header, expected] of cases) assert.deepEqual(sub(header), [expected], header);
  });

  it('reads the id before a bracketed title the same way', () => {
    assert.deepEqual(sub('"a"b [t]'), [['ab', 't']]);
    assert.deepEqual(sub('"a" [t]'), [['a', 't']]);
    assert.deepEqual(sub('"" a [t]'), [['a', 't']]);
    assert.deepEqual(sub('"a b" [t]'), [['a b', 't']]);
    assert.deepEqual(sub('a"b [t]'), [['a"b', 't']]);
  });

  it('refuses a string after the first word, or one never closed, as Mermaid refuses it', () => {
    for (const header of ['6" pipes', 'a "b" c', 's "x"', 'a "b"', 'a "b', '"a" "b"', '"" "a"', 'a "" "b"', '6"x"',
      'a:"x"', 'a,"x"', 'é"x"', 'aé "x"', 'a "b" ', '6"x" [t]', 'a "b" [t]']) {
      assert.throws(() => parseMermaid(`flowchart LR\nsubgraph ${header}\n  x\nend`), (/** @type {any} */ error) => {
        assert.deepEqual([error.msgid, error.line], ['mermaid/flowchart/quote-in-title', 2], header);
        return true;
      });
    }
  });
});
