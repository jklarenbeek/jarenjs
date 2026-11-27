//@ts-check
/**
 * A composite state's `{` on a line after `state X`, as Mermaid reads it
 * once it has removed its `%%` comments (each with the blank lines just
 * before it): an empty line between them leaves the `{` opening no state,
 * which is refused; a line of blanks or a comment between them reads.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid } from '@jarenjs/mermaid';

const S = (/** @type {string} */ between) => `stateDiagram-v2\nstate X\n${between}{\n  a --> b\n}`;

describe('stateDiagram — a `{` on a line after `state X`', () => {
  it('is refused past an empty line, as Mermaid refuses it', () => {
    for (const between of ['\n', '\n\n', '\n\n \n', '\n \n\n', '\n\n\t\n', '%% c\n\n', '\n\n%% c\n\n', '\n%% c\n%% d\n\n']) {
      const source = S(between);
      const braceLine = source.split('\n').findIndex((line) => line.startsWith('{')) + 1;
      assert.throws(() => parseMermaid(source), (/** @type {any} */ error) => {
        assert.deepEqual([error.msgid, error.line], ['mermaid/state/brace-unopened', braceLine], JSON.stringify(between));
        return true;
      });
    }
    assert.throws(() => parseMermaid('stateDiagram-v2\n  state X\n\n  {\n  a --> b\n  }'), { msgid: 'mermaid/state/brace-unopened', line: 4 });
  });

  it('opens the state past a line of blanks, or blank lines a comment follows, as Mermaid reads it', () => {
    for (const between of ['', ' \n', '\t\n', '%% c\n', '\n%% c\n', '%% c\n%% d\n', '\n %% c \n', ' \n\n%% c\n']) {
      const { ast } = /** @type {any} */ (parseMermaid(S(between)));
      assert.deepEqual(ast.states.map((/** @type {any} */ s) => [s.id, s.parent ?? null]), [['X', null], ['a', 'X'], ['b', 'X']], JSON.stringify(between));
    }
  });
});
