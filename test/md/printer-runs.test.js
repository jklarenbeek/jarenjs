//@ts-check
/**
 * The printer's output reads back as the document it came from for any run
 * of emphasis and strong, however long, and for an HTML block that starts
 * with spaces and stands straight after a list.
 *
 * A run the canonical spelling merges into one delimiter run is spelled by
 * a search against the parser. The search covers a stretch of the run at a
 * time, with the character each neighbour prints beside its edge, so it is
 * not bounded by the number of delimiter nodes or characters in the run;
 * the timing tests compare eight times the input and never a wall clock.
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
import { growthRatio } from './scaling.js';

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

describe('toMarkdown — a run of emphasis and strong no short search spells reads back', function () {
  // Each source below is five or more delimiter nodes whose canonical
  // spelling reads back as something else, and which no spelling of the
  // first four nodes and six bits does.
  const STUBBORN = [
    ['**a*b***__a***1***__*', '**a*b***__a***1***__\\*\n'],
    ['*a _ab*****a**b***_*__', '*a _ab*****a**b***_*\\_\\_\n'],
    ['**__****1***b***__****', '**__****1***b***__**\\*\\*\n'],
    ['******.*__*b**.***', '\\*_****.*\\_\\_*b**.**_\n'],
    ['*a!a __a.***`c`**_b_** 1****11*`c`* a a ." ~~**', '*a!a \\_\\_a.*__`c`__*b*\\*\\* 1****11*`c`* a a ." \\~\\~**\n'],
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

describe('toMarkdown — the spelling a search finds is the one printed', function () {
  it('keeps the first combination of a short run that reads back, six sites deep', () => {
    // four delimiter nodes and a literal `*` or `_` bare in the second group of escapes:
    // the search over the whole run needs its sixth bit, as it always has
    assert.equal(canonical('\\\\_\\\\_b__`c`*****__**1\\\\_***a****a'),
      '\\\\*\\\\*b**`c`\\*\\*\\*\\*\\*\\_\\_**1\\\\_***a****a\n');
  });

  it('spells a long run a stretch at a time, each against the character its neighbour prints', () => {
    // the delimiter runs sit against letters, spaces and marks of the stretches beside them
    assert.equal(canonical(' __"a .a *_b. ba  b"__ _____**"b_*_*[l](u) a_('),
      '\\__"a .a \\**b. ba  b"*_ ____*\\*\\*"b*\\*_\\*[l](u) a_(\n');
    assert.equal(canonical('**`c`_ (a `c`!**_.__***`c`*1[l](u)****** b_`c`[l](u)1_****!'),
      '**`c`\\_ (a `c`!**_.\\_\\_***`c`*1[l](u)****\\*\\* b_`c`[l](u)1\\_\\*\\*\\*\\*!\n');
    assert.equal(canonical('`c`**_!`c`.1* b_~~****__b***! b***a `c` b~~_".(_*1a  b!____****`c`___ ba '),
      '`c`***!`c`.1\\* b*~~****\\_\\_b***! b**\\*a `c` b~~_".(_*1a  b!\\_\\_\\_\\_***\\*`c`\\_\\_\\_ ba\n');
    assert.equal(canonical('b.** **ba_**[l](u) b****b***[l](u)(__ b !__a b*__*** b([l](u)****.a _***.**'),
      'b.\\*\\* **ba\\_**[l](u) b****b***[l](u)(\\_\\_ b !__a b\\*__**\\* b([l](u)**__.a \\___\\*.**\n');
  });
});

describe('toMarkdown — printing a long run costs time in proportion to its length', function () {
  /** @type {Map<string, any>} */
  const documents = new Map();
  /** @param {string} source */
  const print = (source) => {
    let doc = documents.get(source);
    if (doc === undefined) {
      doc = parseMarkdown(source);
      documents.set(source, doc);
    }
    return toMarkdown(doc);
  };
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
      '\\*\\*_****\u{1F600}*\\_\\_\u{1F600}*\u{1F600}*\\_***._\u{1F600}1\n');
  });

  it('reads a hard break beside a run as white space', () => {
    assert.equal(canonical('1\\\n_**x*_*_**x* __** ******'),
      '1\\\n_\\**x*_*\\_**x* \\_\\_** \\*\\*\\*\\*\\*\\*\n');
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

describe('toMarkdown — content no searched spelling reads back as costs time in proportion to its length', function () {
  // ninety characters of delimiters, letters and spaces that the search does not
  // reach: the printer spends its whole allowance on it and prints it canonically.
  // If it ever reads back, use another run the search gives up on: the point is the cost.
  const UNIT = '.___a_b_1ba 1b_1**ab***__a _.1_b11****__1a **_ b***1*a1b.b b b __*__* * a a1__1*****____._. b**___********';
  /** @param {number} n */
  const make = (n) => (UNIT + ' plain ').repeat(n);

  it('prints it as it prints everything the search gives up on, and not as the nodes it came from', () => {
    const source = make(10);
    const doc = parseMarkdown(source);
    const text = toMarkdown(doc);
    assert.notDeepEqual(parseMarkdown(text).ast, doc.ast);
    assert.equal(toMarkdown(doc), text);
  });

  it('costs at most a bounded multiple of printing a run that reads back at once', function () {
    // The search is paid from a pool in proportion to what a call prints, so
    // content it cannot spell costs a bounded number of reads of itself, not the
    // thousands a search of every spelling would. Both documents print the same
    // number of characters; the timing of each is the fastest of several, taken
    // in turn so that a loaded host slows them alike.
    const hard = parseMarkdown(Array.from({ length: 40 }, () => UNIT).join('\n\n'));
    const easy = parseMarkdown(Array.from({ length: 40 }, () => '*a **b** c* and '.repeat(7).slice(0, UNIT.length)).join('\n\n'));
    const time = (/** @type {any} */ doc) => {
      const started = performance.now();
      toMarkdown(doc);
      return performance.now() - started;
    };
    let hardest = Infinity;
    let easiest = Infinity;
    for (let i = 0; i < 9; i++) {
      hardest = Math.min(hardest, time(hard));
      easiest = Math.min(easiest, time(easy));
    }
    assert.ok(hardest / easiest < 150, `${hardest.toFixed(2)} ms against ${easiest.toFixed(2)} ms`);
  });

  it('eight times the content at most multiplies the time by twenty-four', function () {
    /** @type {Map<string, any>} */
    const documents = new Map();
    /** @param {string} source */
    const print = (source) => {
      let doc = documents.get(source);
      if (doc === undefined) {
        doc = parseMarkdown(source);
        documents.set(source, doc);
      }
      return toMarkdown(doc);
    };
    const ratio = growthRatio(print, make(6), make(48), { limit: 24 });
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
