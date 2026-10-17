//@ts-check
/**
 * The printer's output reads back as the document it came from for a run
 * of emphasis and strong however long, wherever the spelling derived from
 * the delimiter rules or the search behind it reaches, and for an HTML
 * block that starts with spaces and stands straight after a list.
 *
 * A run the canonical spelling merges into one delimiter run is spelled
 * from the delimiter rules: each node's delimiter, the literal `*` and `_`
 * beside it that print bare, and the characters beside a run that print
 * as references; content that does not read back so is spelled by a
 * search against the parser, and content neither reads back as is named to
 * `onLossy`. The timing tests compare eight times the input and never a
 * wall clock.
 * An HTML block that begins with as many spaces as the last list item's
 * content is indented by would print inside that item, so a definition that
 * defines nothing ends the list first.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { parseMarkdown, toMarkdown } from '@jarenjs/md';
import { extractExamples } from '../../benchmark/lib/commonmark.js';
import { growthRatio } from '../lib/growth.js';

/**
 * Print, re-parse, and require the same AST and a stable canonical text.
 * @param {string} source @param {{ gfm?: boolean }} [options] @returns {string} the canonical text
 */
function canonical(source, options = {}) {
  const parse = { frontmatter: false, ...options };
  const doc = parseMarkdown(source, parse);
  const text = toMarkdown(doc);
  const again = parseMarkdown(text, parse);
  assert.deepEqual(again.ast, doc.ast, `AST drift for ${JSON.stringify(source)} printed ${JSON.stringify(text)}`);
  assert.equal(toMarkdown(again), text, `not a fixed point for ${JSON.stringify(source)}`);
  return text;
}

/**
 * The sources of a vendored specification's examples.
 * @param {string} name @returns {string[]}
 */
function examplesOf(name) {
  const file = fileURLToPath(new URL(`./fixtures/${name}/spec.txt`, import.meta.url));
  return extractExamples(readFileSync(file, 'utf8')).map((example) => example.markdown);
}

/**
 * A deterministic stream of numbers: the same seed, the same documents.
 * @param {number} seed
 * @returns {{ int: (n: number) => number, pick: <T>(items: T[]) => T }}
 */
function random(seed) {
  let state = seed >>> 0;
  const int = (/** @type {number} */ n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * n);
  };
  return { int, pick: (items) => items[int(items.length)] };
}

/**
 * A printer of each source's document, parsed once: a timing compares the printing.
 * @returns {(source: string) => string}
 */
function printParsed() {
  /** @type {Map<string, any>} */
  const documents = new Map();
  return (source) => {
    let doc = documents.get(source);
    if (doc === undefined) {
      doc = parseMarkdown(source);
      documents.set(source, doc);
    }
    return toMarkdown(doc);
  };
}

/**
 * How many times longer printing forty paragraphs takes than printing forty
 * paragraphs of emphasis and strong that read back at once, each as many
 * characters long as the source of one of the forty. Both documents print
 * about the same number of characters; each timing is several prints in a
 * row, so that the easy one takes milliseconds, and the fastest of several,
 * taken in turn so that a loaded host slows them alike.
 * @param {any[]} hard the forty paragraphs
 * @param {number} length
 * @returns {{ ratio: number, message: string }}
 */
function costAgainstReadingBack(hard, length) {
  const easy = parseMarkdown(Array.from({ length: 40 }, () => '*a **b** c* and '.repeat(7).slice(0, length)).join('\n\n'));
  const time = (/** @type {any} */ doc) => {
    const started = performance.now();
    for (let i = 0; i < 6; i++) toMarkdown(doc);
    return performance.now() - started;
  };
  let hardest = Infinity;
  let easiest = Infinity;
  for (let i = 0; i < 5; i++) {
    hardest = Math.min(hardest, time(hard));
    easiest = Math.min(easiest, time(easy));
  }
  return { ratio: hardest / easiest, message: `${hardest.toFixed(2)} ms against ${easiest.toFixed(2)} ms` };
}

/**
 * A run of delimiters, letters and spaces whose canonical spelling does not
 * read back: most of its emphasis and strong need `_` or runs merged with
 * their neighbours', and some of its literal `*` and `_` print bare.
 */
const UNIT = '.___a_b_1ba 1b_1**ab***__a _.1_b11****__1a **_ b***1*a1b.b b b __*__* * a a1__1*****____._. b**___********';

describe('toMarkdown — a run of emphasis and strong the canonical spelling merges reads back', function () {
  // Each source below is five or more delimiter nodes whose canonical
  // spelling reads back as something else.
  const STUBBORN = [
    ['**a*b***__a***1***__*', '__a*b*__**&#97;_**1**_**\\*\n'],
    ['*a _ab*****a**b***_*__', '*a _a&#98;*****a**b***_*\\_\\_\n'],
    ['**__****1***b***__****', '**__****1**_b_**__**\\*\\*\n'],
    ['******.*__*b**.***', '**__*_._\\_\\__b_*.__*\n'],
    ['*a!a __a.***`c`**_b_** 1****11*`c`* a a ." ~~**', '*a!a \\_\\_a.*__`c`__*b*\\*\\* &#49;**_*11*`c`_ a a ." \\~\\~**\n'],
  ];
  for (const [source, printed] of STUBBORN) {
    it(`prints ${JSON.stringify(source)} so that it reads back`, () => {
      assert.equal(canonical(source), printed);
    });
  }

  it('prints a run that reads back across a join the stretches were searched apart at', () => {
    // searching the two halves on their own reads each back; the whole does not
    // until they are searched together
    for (const source of [
      '*a!a __a.***`c`**_b_** 1****11*`c`* a a ." ~~**',
      'ba !_***(aa bbaa![l](u)(1~~a[l](u) b1***.*****!*`c`***[l](u)*a[l](u)b!*..  [l](u).__***_*\n__a*b[l](u)*****a.~~! b***b*[l](u)1(1*\n~~.a*',
    ]) canonical(source);
  });

  it('prints a run of more than 600 characters', () => {
    const text = canonical('plain '.repeat(120) + '**.***1****1 ' + 'plain '.repeat(20) + '**a*b***__a***1***__*');
    assert.ok(text.length > 700);
  });

  it('prints stubborn units at any run length, separated or touching', () => {
    for (const unit of ['**.***1****1 ', '**.***1****1', '**a*b***__a***1***__* ', '*a _ab*****a**b***_*__ ', '******.*__*b**.*** ']) {
      for (const count of [1, 3, 24, 200]) canonical(unit.repeat(count));
    }
  });

  it('prints a delimiter next to a character of another kind where the neighbour is not part of the search', () => {
    // the delimiter run at the edge of a stretch is read by the character beside it: a letter, a space, a mark
    for (const edge of ['a', ' ', '.', '"', '(', 'é', '\u{1F600}', ' ']) {
      canonical(edge + '**.***1****1' + edge + '1 ' + edge + '**a*b***__a***1***__*' + edge);
    }
  });
});

describe('toMarkdown — the derived spelling is the one printed', function () {
  it('prints a short run with literal delimiters beside it', () => {
    assert.equal(canonical('\\\\_\\\\_b__`c`*****__**1\\\\_***a****a'),
      '\\\\*\\\\_b_*`c`\\*\\*\\*\\*\\*\\_\\_**1\\\\\\_\\*__a__**&#97;\n');
  });

  it('spells a long run against the character each neighbour prints', () => {
    // the delimiter runs sit against letters, spaces and marks beside them
    assert.equal(canonical(' __"a .a *_b. ba  b"__ _____**"b_*_*[l](u) a_('),
      '\\_*"a .a \\*_b. ba  b"_* ____*\\*\\*"b*\\*_\\*[l](u) a_(\n');
    assert.equal(canonical('**`c`_ (a `c`!**_.__***`c`*1[l](u)****** b_`c`[l](u)1_****!'),
      '**`c`\\_ (a `c`!**_.\\_\\_*__`c`*1[l](u)*__*\\*\\* b_`c`[l](u)1\\_\\*\\*\\*\\*!\n');
    assert.equal(canonical('b.** **ba_**[l](u) b****b***[l](u)(__ b !__a b*__*** b([l](u)****.a _***.**'),
      'b.\\*\\* **ba\\_**[l](u) &#98;__**b**\\*[l](u)(\\_\\_ b !**a b\\***__\\* b([l](u)**__.a \\___\\*.**\n');
  });

  it('prints a run the derivation does not reach, where a strikethrough stands among the runs, as the search spells it', () => {
    assert.equal(canonical('`c`**_!`c`.1* b_~~****__b***! b***a `c` b~~_".(_*1a  b!____****`c`___ ba '),
      '`c`***!`c`.1\\* b*~~****\\_\\_b***! b**\\*a `c` b~~_".(_*1a  b!\\_\\_\\_\\_***\\*`c`\\_\\_\\_ ba\n');
  });
});

describe('toMarkdown — printing a long run costs time in proportion to its length', function () {
  const print = printParsed();
  /** @type {[string, (n: number) => string][]} */
  const SHAPES = [
    ['stubborn units a word apart', (n) => '**.***1****1 plain '.repeat(n)],
    ['stubborn units touching', (n) => '**.***1****1'.repeat(n)],
    ['a unit with a literal delimiter at its end', (n) => '**a*b***__a***1***__* '.repeat(n)],
    ['units of emphasis inside emphasis', (n) => '*a _ab*****a**b***_*__ '.repeat(n)],
    ['units that start with a delimiter run', (n) => '******.*__*b**.*** '.repeat(n)],
  ];
  for (const [what, make] of SHAPES) {
    it(`${what}: eight times the run at most multiplies the time by twenty-four, and it reads back`, function () {
      const small = make(100);
      const large = make(800);
      const ratio = growthRatio(print, small, large, { limit: 24 });
      assert.ok(ratio < 24, `eight times ${what} multiplied the time by ${ratio.toFixed(2)}`);
      for (const source of [small, large]) {
        assert.deepEqual(parseMarkdown(print(source)).ast, parseMarkdown(source).ast);
      }
    });
  }
});

describe('toMarkdown — what sits beside a stretch of delimiters is read as the character it is', function () {
  it('reads an astral character at the edge of a run as one character of its kind, at either end', () => {
    // a code point outside the BMP is two code units, and half of one is a letter
    assert.equal(canonical('\u{1F600}******\u{1F600}*__*\u{1F600}__**\u{1F600}******\u{1F600}*'),
      '\u{1F600}******\u{1F600}*__\\*\u{1F600}__**\u{1F600}***\\*\\**\u{1F600}*\n');
    assert.equal(canonical('*******\u{1F600}*__\u{1F600}*\u{1F600}*_***.*\u{1F600}1'),
      '*****_*\u{1F600}*\\_\\_\u{1F600}_\u{1F600}_\\__**.*\u{1F600}1\n');
  });

  it('reads a hard break beside a run as white space', () => {
    assert.equal(canonical('1\\\n_**x*_*_**x* __** ******'),
      '1\\\n_\\**x*_*\\__*x* \\_\\__* \\*\\*\\*\\*\\*\\*\n');
  });
});

describe('toMarkdown — a bare delimiter never opens a list or a rule', function () {
  it('keeps the blocks of a paragraph whose literal `*` and `_` no spelling can leave bare', () => {
    // a line that starts with a bare `* ` is an item, and escaping it would change what it is
    for (const source of [' \\* ****a*ab*a', ' \\* ******\\_***a******b*b* ', 'x\n\\* ****a*ab*a']) {
      const doc = parseMarkdown(source);
      assert.deepEqual(parseMarkdown(toMarkdown(doc)).ast.map((node) => node.type), doc.ast.map((node) => node.type),
        JSON.stringify(source));
    }
  });
});

describe('toMarkdown — a run whose literal delimiters print bare reads back, at a cost in proportion to its length', function () {
  /** @param {number} n */
  const make = (n) => (UNIT + ' plain ').repeat(n);

  it('prints it so that it reads back, and each copy of it in a block', () => {
    assert.equal(canonical(UNIT),
      '.**_a\\_b\\_1ba 1b\\_&#49;**ab**\\***a _.1\\_b11\\*\\*\\*\\**_1a \\*\\*_ &#98;__*1*&#97;1b.b b b **\\***\\* \\* a a1\\_\\_1__\\*\\*\\**_**._. b\\*\\***\\_\\*\\*\\*\\*\\*\\*\\*\\*\n');
    canonical(make(10));
  });

  it('spells a run near the canonical spelling and one far from it', () => {
    // the first was spelled near the canonical spelling, the second far from it
    assert.equal(canonical('*`c`b1__.**_1`c`***____** bb*b_a .1!"`c` _*`c`!a_[l](u) *_**"***** _'),
      '*`c`b1\\_\\_.__\\_1`c`__*\\_\\__*\\*\\* b&#98;*b\\_a .1!"`c` \\_*`c`!a*[l](u) \\*_**"**\\*\\*\\* \\_\n');
    assert.equal(canonical('[l](u) b(a (__a **`c`*(!`c`**a a"***((_**._**a *(_! bb 1*"._*.b_._!***.* ba *[l](u)""~~1_"[l](u)b_~~("'),
      '[l](u) b(a (__a **`c`*(!`c`__a a"__*((\\_**.*\\*\\*a \\*(*! bb 1\\*".*\\*.b*.*!\\*\\*_._ ba \\*[l](u)""\\~\\~1*"[l](u)b_\\~\\~("\n');
  });

  it('costs at most a bounded multiple of printing a run that reads back at once', function () {
    // Deriving a spelling weighs each node against a few dozen sets of runs
    // open around it at most, so content that needs it costs a bounded
    // multiple of printing content that reads back at once, not the thousands
    // a search of every spelling would. The limit sits near the geometric mean
    // of the bounded multiple and the unbounded search.
    const hard = parseMarkdown(Array.from({ length: 40 }, () => UNIT).join('\n\n')).ast;
    const { ratio, message } = costAgainstReadingBack(hard, UNIT.length);
    assert.ok(ratio < 150, message);
  });

  it('eight times the content at most multiplies the time by twenty-four', function () {
    const ratio = growthRatio(printParsed(), make(6), make(48), { limit: 24 });
    assert.ok(ratio < 24, `eight times the content multiplied the time by ${ratio.toFixed(2)}`);
  });
});

describe('toMarkdown — a node no Markdown reads back as is named, and changes no other block', function () {
  // The parser never makes an emphasis with nothing in it, so no spelling of
  // one reads back: content that holds one is printed by the derived spelling
  // and the node named to `onLossy`.
  const EMPTY = { type: 'emphasis', children: [] };
  /**
   * `n` copies of the guided search's run a word apart, each with an empty
   * emphasis at the end of its outer strong.
   * @param {number} n
   * @returns {any[]}
   */
  const unspellable = (n) => {
    /** @type {any[]} */
    const children = [];
    for (let i = 0; i < n; i++) {
      const [first, strong, last] = parseMarkdown(UNIT).ast[0].children;
      const previous = children.pop();
      children.push(previous === undefined ? first : { type: 'text', value: previous.value + ' plain ' + first.value },
        { ...strong, children: [...strong.children, EMPTY] }, last);
    }
    return [{ type: 'paragraph', children }];
  };

  it('prints the rest of its block by the derived spelling and names the empty node', () => {
    const unit = parseMarkdown(UNIT).ast[0].children;
    const ast = [{ type: 'paragraph', children: [...unit, { type: 'text', value: ' plain ' }, EMPTY] }];
    /** @type {any[]} */
    const reports = [];
    assert.equal(toMarkdown(ast, { onLossy: (report) => reports.push(report) }), '.**_a\\_b\\_1ba 1b\\_&#49;**ab**\\***a _.1\\_b11\\*\\*\\*\\**_1a \\*\\*_ &#98;__*1*&#97;1b.b b b **\\***\\* \\* a a1\\_\\_1__\\*\\*\\**_**._. b\\*\\***\\_\\*\\*\\*\\*\\*\\*\\*\\* plain **\n');
    assert.deepEqual(reports, [{ code: 'empty', path: [0, unit.length + 1], reason: 'an emphasis node with nothing in it, whose opener and closer would be one run' }]);
  });

  it('leaves the blocks after it as they print on their own', () => {
    // the second block is a run the canonical spelling does not read back, and
    // the first holds a node no text reads back as
    const after = parseMarkdown('"_`c`**1b~~1_ ba(__* a  b[l](u)a .`c`1**b____1.~~**_1__ b*[l](u)"" "(*1!a !a _.a~~_[l](u)[l](u)a!!**__*`c`___!~~_*1*****(a ~~a__*~~*[l](u)`c`!_***').ast;
    const ast = [{ type: 'paragraph', children: [{ type: 'strong', children: [EMPTY] }, { type: 'text', value: ' a' }] }, ...after];
    assert.deepEqual(parseMarkdown(toMarkdown(ast)).ast.slice(1), after);
  });

  it('prints content holding a node no spelling reads back as the same every time', () => {
    const ast = unspellable(1);
    const text = toMarkdown(ast);
    assert.equal(text, '.**_a\\_b\\_1ba 1b\\_&#49;**ab**\\***a _.1\\_b11\\*\\*\\*\\**_1a \\*\\*_ &#98;__*1*&#97;1b.b b b **\\***\\* \\* a a1\\_\\_1__\\*\\*\\**_**._. b\\*\\*__**\\_\\*\\*\\*\\*\\*\\*\\*\\*\n');
    assert.equal(toMarkdown(ast), text);
  });

  it('costs at most a bounded multiple of printing a run that reads back at once', function () {
    const { ratio, message } = costAgainstReadingBack(Array.from({ length: 40 }, () => unspellable(1)[0]), UNIT.length);
    assert.ok(ratio < 150, message);
  });

  it('eight times the content at most multiplies the time by twenty-four', function () {
    const ratio = growthRatio((/** @type {any[]} */ ast) => toMarkdown(ast), unspellable(6), unspellable(48), { limit: 24 });
    assert.ok(ratio < 24, `eight times the content multiplied the time by ${ratio.toFixed(2)}`);
  });
});

describe('toMarkdown — random runs and documents read back', function () {
  const INLINE = ['*', '**', '***', '_', '__', '___', 'a', 'b', 'word', ' ', ' ', 'x ', ' y', '1', '.', ',', '"', '(', ')', '!',
    '~~', '`c`', '[l](u)', '![i](p)', '\\*', '\\_', '&amp;', '<b>t</b>', '\n', 'é', '-', '#', '>', '=', '|'];
  /** @param {ReturnType<typeof random>} r @param {number} tokens */
  const inline = (r, tokens) => {
    let text = '';
    for (let i = 1 + r.int(tokens); i > 0; i--) text += r.pick(INLINE);
    return text.replace(/^\s+/, '').replace(/\n[ \t]*\n/g, '\n') || 'p';
  };
  /**
   * @param {string} text @param {string} pad @param {string} first
   * @returns {string}
   */
  const indent = (text, pad, first) => text.split('\n')
    .map((line, i) => (line === '' ? '' : (i === 0 ? first : pad) + line)).join('\n');
  /** @param {ReturnType<typeof random>} r @param {number} depth @param {number} tokens @returns {string} */
  const block = (r, depth, tokens) => {
    switch (depth > 0 ? r.pick([0, 1, 2, 3, 4, 5, 6, 10].slice(0, depth > 2 ? 4 : 8)) : r.int(11)) {
      case 2: return '#'.repeat(1 + r.int(6)) + ' ' + inline(r, tokens).replace(/\n/g, ' ');
      case 3: return ' '.repeat(r.int(4)) + r.pick(['<div>x</div>', '<!-- c -->', '<p>', '<span>s</span> t']);
      case 4: {
        const marker = r.pick(['-', '*', '+', '1.', '3.', '9.', '10.', '1)']);
        const gap = ' '.repeat(1 + r.int(4));
        const items = [];
        for (let i = 1 + r.int(3); i > 0; i--) {
          const m = /^\d/.test(marker) ? String(parseInt(marker, 10) + items.length) + marker.slice(String(parseInt(marker, 10)).length) : marker;
          items.push(indent(blocks(r, depth + 1, tokens, 1 + r.int(2)), ' '.repeat(m.length + gap.length), m + gap));
        }
        return items.join(r.int(3) === 0 ? '\n\n' : '\n');
      }
      case 5: return indent(blocks(r, depth + 1, tokens, 1 + r.int(2)), '> ', '> ').replace(/^> $/gm, '>');
      case 6: return '```\ncode\n```';
      case 7: return '| ' + inline(r, tokens).replace(/\n/g, ' ').replace(/\|/g, '/') + ' | b |\n| --- | --- |\n| c | ' + inline(r, 3).replace(/\n/g, ' ').replace(/\|/g, '/') + ' |';
      case 8: return inline(r, tokens) + '\n' + r.pick(['===', '---']);
      case 9: return '[^n]: ' + inline(r, tokens);
      case 10: return '***';
      default: return inline(r, tokens);
    }
  };
  /** @param {ReturnType<typeof random>} r @param {number} depth @param {number} tokens @param {number} count @returns {string} */
  const blocks = (r, depth, tokens, count) => {
    const out = [];
    for (let i = 0; i < count; i++) out.push(block(r, depth, tokens));
    return out.join('\n\n');
  };

  it('prints 3000 random documents of up to fourteen inline pieces a paragraph so that they read back', function () {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = random(seed);
      canonical(blocks(r, 0, 14, 1 + r.int(4)) + '\n');
    }
  });

  it('prints 3000 random documents of up to forty inline pieces a paragraph so that they read back', function () {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = random(seed * 7919);
      canonical(blocks(r, 0, 40, 1 + r.int(3)) + '\n');
    }
  });

  it('prints 6000 random runs of delimiters, text, links and code so that they read back', function () {
    const pieces = ['*', '**', '***', '_', '__', 'a', 'b', ' ', 'a ', ' b', '1', '.', '*', '_', '~~', '`c`', '[l](u)', '"', '(', '!'];
    for (let seed = 1; seed <= 6000; seed++) {
      const r = random(seed * 104729);
      let source = '';
      for (let i = 2 + r.int(31); i > 0; i--) source += r.pick(pieces);
      canonical(source);
    }
  });
});

describe('toMarkdown — an HTML block that starts with spaces after a list ends the list first', function () {
  it('prints a definition that defines nothing between the list and a block indented as far as its items', () => {
    assert.equal(canonical('-   a\n\n  <div>x</div>\n'), '- a\n\n[-]: <>\n\n  <div>x</div>\n');
    assert.equal(canonical('-   a\n\n   <!-- c -->\n'), '- a\n\n[-]: <>\n\n   <!-- c -->\n');
    assert.equal(canonical('1.  a\n\n   <div>x</div>\n'), '1. a\n\n[-]: <>\n\n   <div>x</div>\n');
    assert.equal(canonical('*   a\n*   b\n\n  <p>\n'), '- a\n- b\n\n[-]: <>\n\n  <p>\n');
  });

  it('measures the indent of the last item, which grows with the number it is printed with', () => {
    // `9.` and `99.` print as `9. ` (3 columns) and `99. ` (4 columns): an HTML block
    // holds at most three spaces, so only the first has a block that reaches
    assert.equal(canonical('9.  a\n\n   <div>x</div>\n'), '9. a\n\n[-]: <>\n\n   <div>x</div>\n');
    assert.equal(canonical('9.  a\n10. b\n\n   <div>x</div>\n'), '9. a\n10. b\n\n   <div>x</div>\n');
    assert.equal(canonical('1.  a\n\n  <div>x</div>\n'), '1. a\n\n  <div>x</div>\n');
  });

  it('leaves a block that starts with fewer spaces than the items are indented by as it is printed', () => {
    assert.equal(canonical('- a\n\n <div>x</div>\n'), '- a\n\n <div>x</div>\n');
    assert.equal(canonical('- a\n\n<div>x</div>\n'), '- a\n\n<div>x</div>\n');
    assert.equal(canonical('para\n\n   <div>x</div>\n'), 'para\n\n   <div>x</div>\n');
    // an item with nothing in it is ended by the blank line, whatever follows
    assert.equal(canonical('-\n\n  <div>x</div>\n'), '- \n\n  <div>x</div>\n');
    assert.equal(canonical('- a\n-\n\n   <div>x</div>\n'), '- a\n- \n\n   <div>x</div>\n');
    assert.equal(canonical('```\ncode\n```\n\n   <div>x</div>\n'), '```\ncode\n```\n\n   <div>x</div>\n');
  });

  it('ends the list inside a block quote, an item and a footnote definition too', () => {
    assert.equal(canonical('> -   a\n>\n>   <div>x</div>\n'), '> - a\n>\n> [-]: <>\n>\n>   <div>x</div>\n');
    assert.equal(canonical('- a\n  -   b\n\n    <div>x</div>\n'), '- a\n\n  - b\n\n  [-]: <>\n\n    <div>x</div>\n');
    assert.equal(canonical('[^n]: a\n\n    -   b\n\n      <div>x</div>\n'),
      '[^n]: a\n\n    - b\n\n    [-]: <>\n\n      <div>x</div>\n');
  });

  it('reads back wherever the list, its markers and the block start', () => {
    let checked = 0;
    for (const marker of ['-', '*', '+', '1.', '2.', '9.', '10.', '99.', '1)', '100.']) {
      for (const gap of [1, 2, 3, 4]) {
        for (const spaces of [0, 1, 2, 3]) {
          for (const items of [1, 2]) {
            for (const wrap of ['', '> ', '> > ']) {
              for (const inner of [false, true]) {
                const pad = ' '.repeat(gap);
                const lines = [marker + pad + 'a'];
                if (inner) lines.push(' '.repeat(marker.length + gap) + '- inner');
                else if (items === 2) lines.push(marker.replace(/^\d+/, (d) => String(Number(d) + 1)) + pad + 'b');
                lines.push('', ' '.repeat(spaces) + '<div>x</div>');
                canonical(lines.map((line) => (line === '' && wrap !== '' ? wrap.trimEnd() : wrap + line)).join('\n') + '\n');
                checked++;
              }
            }
          }
        }
      }
    }
    assert.equal(checked, 10 * 4 * 4 * 2 * 3 * 2);
  });

  it('prints the definition only where the block would otherwise print inside the list', () => {
    // every example's blocks, then an HTML block of one, two or three spaces:
    // the text is the one without a definition wherever that reads back as the
    // blocks, and the one with it, and nothing more, where it does not
    let plainCount = 0;
    let separatedCount = 0;
    for (const source of [...examplesOf('commonmark'), ...examplesOf('gfm')]) {
      const ast = parseMarkdown(source, { frontmatter: false }).ast;
      // an example that ends in an HTML block left open takes any block after it in
      if (ast.length > 0 && ast[ast.length - 1].type === 'html') continue;
      const body = toMarkdown(ast) === '' ? '' : toMarkdown(ast) + '\n';
      for (const spaces of [1, 2, 3]) {
        const html = ' '.repeat(spaces) + '<div>x</div>';
        const blocks = [...ast, { type: 'html', value: html }];
        const text = toMarkdown(blocks);
        const plain = body + html + '\n';
        if (isDeepStrictEqual(parseMarkdown(plain, { frontmatter: false }).ast, blocks)) {
          assert.equal(text, plain, JSON.stringify(source) + ' + ' + spaces);
          plainCount++;
        }
        else {
          assert.equal(text, body + '[-]: <>\n\n' + html + '\n', JSON.stringify(source) + ' + ' + spaces);
          assert.deepEqual(parseMarkdown(text, { frontmatter: false }).ast, blocks);
          separatedCount++;
        }
      }
    }
    assert.ok(plainCount > 1000 && separatedCount > 100, `${plainCount} printed plain, ${separatedCount} with the definition`);
  });
});
