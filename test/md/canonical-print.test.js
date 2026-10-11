//@ts-check
/**
 * Canonical Markdown keeps what it printed. A link whose text is its own
 * relative destination (`[CHANGELOG.md](CHANGELOG.md)`) used to print as
 * `<CHANGELOG.md>`, which is not an autolink and read back as text — or,
 * for `<foo>`, as raw HTML — so the link was gone. Strong around an
 * emphasis that is all of its content printed `***x***`, which reads back
 * as emphasis around strong. And an info string holding a backslash
 * before punctuation, or something shaped like a character reference,
 * printed as it stood and read back decoded.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, toMarkdown } from '@jarenjs/md';

/**
 * Print, re-parse, and require the same AST and a stable canonical text.
 * @param {string} source @returns {string} the canonical text
 */
function canonical(source) {
  const doc = parseMarkdown(source);
  const text = toMarkdown(doc);
  const again = parseMarkdown(text);
  assert.deepEqual(again.ast, doc.ast, `AST drift for ${JSON.stringify(source)} printed ${JSON.stringify(text)}`);
  assert.equal(toMarkdown(again), text);
  return text;
}

describe('toMarkdown — a link prints as an autolink only where an autolink parses', function () {
  it('keeps a relative link whose text is its destination', () => {
    assert.equal(canonical('[CHANGELOG.md](CHANGELOG.md)'), '[CHANGELOG.md](CHANGELOG.md)\n');
    assert.equal(canonical('[docs/a.md](docs/a.md)'), '[docs/a.md](docs/a.md)\n');
    assert.equal(canonical('[foo](foo)'), '[foo](foo)\n');
    assert.equal(canonical('[a@b.co](a@b.co)'), '[a@b.co](a@b.co)\n');
  });

  it('still prints a real autolink bare', () => {
    assert.equal(canonical('<https://x.y>'), '<https://x.y>\n');
    assert.equal(canonical('<a@b.co>'), '<a@b.co>\n');
    assert.equal(canonical('[a@b.co](mailto:a@b.co)'), '<a@b.co>\n');
  });

  it('keeps a destination the angle brackets would cut short', () => {
    assert.equal(canonical('[x](https://x.y/a>b)'), '[x](https://x.y/a>b)\n');
  });
});

describe('toMarkdown — strong around a whole emphasis keeps its nesting', function () {
  it('prints strong(emphasis) with an underscore inside', () => {
    assert.equal(canonical('**_foo_**'), '**_foo_**\n');
    assert.equal(canonical('__*e*__'), '**_e_**\n');
  });

  it('leaves emphasis around strong, and strong with other content, alone', () => {
    assert.equal(canonical('***foo***'), '***foo***\n');
    assert.equal(canonical('_**foo**_'), '***foo***\n');
    assert.equal(canonical('**a *b* c**'), '**a *b* c**\n');
    assert.equal(canonical('***a* b**'), '***a* b**\n');
  });
});

describe('toMarkdown — an info string is escaped the way it is read', function () {
  it('escapes a backslash before punctuation and a reference-shaped ampersand', () => {
    assert.equal(canonical('~~~a\\\\*b\ncode\n~~~'), '```a\\\\*b\ncode\n```\n');
    assert.equal(canonical('~~~\\&amp;\nx\n~~~'), '```\\&amp;\nx\n```\n');
  });

  it('leaves a backslash before an ordinary character and a bare ampersand alone', () => {
    assert.equal(canonical('```c\\d\nx\n```'), '```c\\d\nx\n```\n');
    assert.equal(canonical('```a&b\nx\n```'), '```a&b\nx\n```\n');
    assert.equal(canonical('```js title="a b"\nx\n```'), '```js title="a b"\nx\n```\n');
  });
});
