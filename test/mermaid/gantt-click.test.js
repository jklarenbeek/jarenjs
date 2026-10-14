//@ts-check
/**
 * @file The Gantt `click` statement: the vendored table is checked against
 * the code and against the shipped Mermaid chunk, the parser reads the
 * grammar the table lists, the printer writes it back, and the layout and
 * renderer draw a link only for a URL the package's allow-list passes. A
 * `call` is recorded and drawn as nothing at all.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMermaid, toMermaid, compileMermaid, renderMermaid, layoutDiagram } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';
import { sanitizeHref } from '@jarenjs/view/helpers';

import { readClick, splitCallArguments, hasTaskSeparator } from '../../components/mermaid/src/parser/gantt-click.js';
import { growthRatio } from '../lib/growth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAMMAR = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'gantt-grammar.json'), 'utf8'));

/** Five lines: the click under test is line 6. */
const HEAD = 'gantt\ndateFormat YYYY-MM-DD\nsection S\nA : a1, 2024-01-01, 3d\nB : a2, 2024-01-05, 2d\n';

/** @param {string} line @returns {any} */
const clicksOf = (line) => parseMermaid(HEAD + line).ast.clicks;

/** The links the layout hands the renderer, by task id. @param {string} source @returns {Record<string, string | null>} */
function hrefsOf(source) {
  const scene = layoutDiagram(parseMermaid(source));
  return Object.fromEntries(scene.rows.map((/** @type {any} */ row) => [row.id, row.href]));
}

/** @param {string} source @returns {string} */
const svgOf = (source) => compileMermaid(source).toSvgString();

describe('the click table is the code', () => {
  it('should parse every form the table lists to the tree the table gives', () => {
    assert.ok(GRAMMAR.click.forms.length >= 12);
    for (const form of GRAMMAR.click.forms) {
      const clicks = clicksOf(form.source);
      assert.deepEqual(clicks, [{ ids: form.ids, href: form.href, call: form.call, line: 6 }], form.source);
    }
  });

  it('should refuse every reject the table lists, on its own line', () => {
    assert.ok(GRAMMAR.click.rejects.length >= 10);
    for (const reject of GRAMMAR.click.rejects) {
      assert.throws(() => parseMermaid(HEAD + reject.source),
        (/** @type {any} */ err) => err.name === 'MermaidParseError' && err.line === 6, reject.source);
    }
  });

  it('should be the grammar the shipped Mermaid chunk lexes and applies', () => {
    const chunk = fs.readFileSync(
      path.join(__dirname, '..', '..', GRAMMAR.provenance.source), 'utf8');
    // the lexer rules the table's grammar sentence is read from
    for (const rule of ['/^(?:click[\\s]+)/i', '/^(?:href[\\s]+["])/i', '/^(?:call[\\s]+)/i',
      '/^(?:\\([\\s]*\\))/i', '/^(?:[^(]*)/i', '/^(?:[^)]*)/i'])
      assert.ok(chunk.includes(rule), `the chunk no longer carries the lexer rule ${rule}`);
    // the actions: a link is filtered unless loose, a call is bound only when loose, a click
    // opens the link in the same context
    assert.ok(chunk.includes('securityLevel!=="loose"&&(r=(0,We.sanitizeUrl)(e))'), 'setLink');
    assert.ok(chunk.includes('securityLevel!=="loose"||e===void 0)return'), 'setClickFun');
    assert.ok(chunk.includes('window.open(r,"_self")'), 'the link opens in the same context');
    assert.ok(chunk.includes('$e.runFunc(e,...i)'), 'a loose call runs the named global function');
  });

  it('should list the click divergences the format document numbers', () => {
    const whats = GRAMMAR.divergences.map((/** @type {any} */ d) => d.what);
    assert.equal(whats.filter((/** @type {string} */ w) => /click/.test(w)).length, 3);
    assert.equal(GRAMMAR.divergences.length, 9);
  });
});

describe('a click statement is read as Mermaid reads it', () => {
  it('should not take an href line for a task row, as it did when the URL held a colon', () => {
    const { ast } = parseMermaid(HEAD + 'click a1 href "https://x.test/p"');
    assert.deepEqual(ast.sections[0].tasks.map((/** @type {any} */ t) => t.id), ['a1', 'a2']);
    assert.deepEqual(ast.clicks, [{ ids: ['a1'], href: 'https://x.test/p', call: null, line: 6 }]);
  });

  it('should keep a call that holds no colon from vanishing', () => {
    assert.deepEqual(clicksOf('click a1 call fn(1, "two")'),
      [{ ids: ['a1'], href: null, call: { name: 'fn', args: ['1', 'two'] }, line: 6 }]);
  });

  it('should keep the statements in source order, each on its line', () => {
    const { ast } = parseMermaid(HEAD + 'click a1 href "https://x.test/p"\n\n\nclick a2 call go()');
    assert.deepEqual(ast.clicks.map((/** @type {any} */ c) => [c.ids[0], c.line]), [['a1', 6], ['a2', 9]]);
  });

  it('should split arguments at the commas Mermaid splits at', () => {
    assert.deepEqual(splitCallArguments('x, "y z", 3'), ['x', 'y z', '3']);
    assert.deepEqual(splitCallArguments('"a,b", c'), ['a,b', 'c']);
    assert.deepEqual(splitCallArguments('a, b"c, d'), ['a, b"c', 'd'], 'a comma with an odd number of quotes after it does not split');
    assert.deepEqual(splitCallArguments('   '), []);
    assert.deepEqual(splitCallArguments('"'), [''], 'a lone quote is a pair of one character');
  });

  it('should split exactly where the expression Mermaid executes splits', () => {
    // setClickFun: argList = functionArgs.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/), then trim and unquote
    const mermaid = (/** @type {string} */ text) => text.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map((piece) => {
      const item = piece.trim();
      return item.startsWith('"') && item.endsWith('"') ? item.substr(1, item.length - 2) : item;
    });
    for (const text of ['a', 'a,b', ' a , b ', '"a,b",c', 'a,"b,c', '"a","b","c"', 'a"b,c"d,e', ',', ',,', '""', '"', '" "',
      'x, "y z", 3', '"a,b', 'a,b"', '"a"b"c,d"', '"""', 'a,"",b'])
      assert.deepEqual(splitCallArguments(text), mermaid(text), JSON.stringify(text));
  });

  it('should read click, href and call in any case', () => {
    assert.deepEqual(readClick('ClIcK a1 HrEf "u" CALL f()').value,
      { ids: ['a1'], href: 'u', call: { name: 'f', args: [] } });
  });

  it('should drop empty ids and refuse a statement that names none', () => {
    assert.deepEqual(clicksOf('click a1,,a2, href "u"')[0].ids, ['a1', 'a2']);
    assert.throws(() => parseMermaid(HEAD + 'click , href "u"'), /names no task id/);
  });

  it('should name what is wrong with a malformed statement', () => {
    const cases = /** @type {[string, RegExp][]} */ ([
      ['click a1', /needs href/],
      ['click a1 call fn', /parentheses/],
      ['click a1 call (x)', /names no function/],
      ['click a1 call fn(x', /closing '\)'/],
      ['click a1 href', /double-quoted URL/],
      ['click a1 href x', /double-quoted URL/],
      ['click', /names no task id/],
      ['click a1 href "https://x.test', /closing quote/],
      ['click a1 href ""', /empty/],
      ['click a1 href "u" "v"', /does not expect '"v"'/],
      ['click a1 href "u" href "v"', /does not expect 'href'/],
    ]);
    for (const [line, message] of cases) {
      assert.throws(() => parseMermaid(HEAD + line),
        (/** @type {any} */ err) => err.line === 6 && message.test(err.message), line);
    }
  });

  it('should keep a task row whose name starts with the word', () => {
    const { ast } = parseMermaid(HEAD + 'Click the button : a3, 2024-01-09, 1d\nclick me : a4, 2024-01-12, 1d');
    assert.deepEqual(ast.sections[0].tasks.map((/** @type {any} */ t) => t.id), ['a1', 'a2', 'a3', 'a4']);
    assert.deepEqual(ast.clicks, []);
  });

  it('should keep a row whose name reads like a click statement a task row', () => {
    const rows = ['Click on href : a3, 2024-01-09, 1d', 'Click to call (now) : a3, 2024-01-09, 1d',
      'Click on href: a3, 2024-01-09, 1d', 'click a href "x" : a3, 2024-01-09, 1d',
      'Click to call fn(now) : a3, 2024-01-09, 1d', 'click the call() button : a3, 2024-01-09, 1d'];
    for (const row of rows) {
      const { ast } = parseMermaid(HEAD + row);
      assert.deepEqual(ast.sections[0].tasks.map((/** @type {any} */ t) => [t.id, t.name, t.line]),
        [['a1', 'A', 4], ['a2', 'B', 5], ['a3', row.slice(0, row.indexOf(' :') === -1 ? row.indexOf(':') : row.indexOf(' :')), 6]], row);
      assert.deepEqual(ast.clicks, [], row);
    }
  });

  it('should still refuse a click with an unquoted URL, as a row that cannot be read', () => {
    assert.throws(() => parseMermaid(HEAD + 'click a1 href https://x.test'),
      (/** @type {any} */ err) => err.name === 'MermaidParseError' && err.line === 6);
  });

  it('should find the colon that separates a task, and not one in a URL or an argument', () => {
    assert.equal(hasTaskSeparator('Click on href : a3, 2024-01-09, 1d'), true);
    assert.equal(hasTaskSeparator('click a1 href "https://x.test:8080/p"'), false);
    assert.equal(hasTaskSeparator('click a1 call fn("a:b", c:d)'), false);
    assert.equal(hasTaskSeparator('click a1 href "https://x.test" : a3'), true);
    assert.equal(hasTaskSeparator('click a1 href "https://x.test'), false);
    assert.equal(hasTaskSeparator('click a1 call fn(x'), false);
  });

  it('should keep a colon inside an argument or a URL from making a task row', () => {
    assert.deepEqual(clicksOf('click a1 call fn("a:b")')[0].call.args, ['a:b']);
    assert.deepEqual(clicksOf('click a1 href "https://x.test:8080/p"')[0].href, 'https://x.test:8080/p');
  });

  it('should accept an id no task has and bind nothing', () => {
    assert.deepEqual(hrefsOf(HEAD + 'click nope href "https://x.test/p"'), { a1: null, a2: null });
  });

  it('should give every gantt tree a clicks member, empty without a statement', () => {
    assert.deepEqual(parseMermaid(HEAD).ast.clicks, []);
  });
});

describe('a click statement prints back', () => {
  const SOURCE = HEAD + 'click a1,a2 href "https://x.test/p" call report(a1, "two, words", "")\nclick a2 call go()';

  it('should print the canonical line after the tasks', () => {
    assert.equal(toMermaid(parseMermaid(SOURCE)), SOURCE + '\n');
  });

  it('should be a fixed point over parse, print, parse', () => {
    const once = parseMermaid(SOURCE);
    const twice = parseMermaid(toMermaid(once));
    assert.deepEqual(twice.ast, once.ast);
  });

  it('should quote an argument that has whitespace at an edge, a comma or nothing in it', () => {
    const line = 'click a1 call f(" x ", "", "a,b", c)';
    assert.ok(toMermaid(parseMermaid(HEAD + line)).endsWith(line + '\n'));
  });

  it('should write the canonical form of a loosely written statement', () => {
    const doc = parseMermaid(HEAD + 'CLICK  a1,  HREF "u"   CALL  f( x ,y )  %% tail');
    assert.ok(toMermaid(doc).endsWith('\nclick a1 href "u" call f(x, y)\n'));
  });

  it('should print a tree written before click existed without a clicks line', () => {
    const doc = parseMermaid(HEAD);
    delete doc.ast.clicks;
    assert.equal(toMermaid(doc), HEAD);
  });
});

describe('a link is drawn only through the allow-list', () => {
  const link = (/** @type {string} */ url) => hrefsOf(HEAD + `click a1 href "${url}"`).a1;

  it('should draw the forms sanitizeHref passes', () => {
    for (const url of ['https://x.test/p', 'http://x.test/p', 'mailto:a@b.test', '#frag', '/docs/page', './page.html',
      '//cdn.test/x']) {
      assert.equal(link(url), url, url);
      assert.notEqual(sanitizeHref(url), null, url);
    }
  });

  it('should draw nothing for a script, a document or a bare relative URL', () => {
    for (const url of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)',
      'vbscript:x', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'page.html', 'x.test/p',
      '\u0001javascript:alert(1)', '\u00a0javascript:alert(1)', '&#106;avascript:alert(1)', 'about:blank', '\\\\evil.test']) {
      assert.equal(link(url), null, url);
      assert.equal(sanitizeHref(url), null, url);
      const svg = svgOf(HEAD + `click a1 href "${url}"`);
      assert.ok(!svg.includes('<a '), url);
      assert.ok(!svg.includes('mm-gantt-clickable'), url);
    }
  });

  it('should percent-encode the URL for the attribute and escape the markup', () => {
    assert.equal(link('https://x.test/a b?q=1&r=é'), 'https://x.test/a%20b?q=1&r=%C3%A9');
    const svg = svgOf(HEAD + 'click a1 href "https://x.test/a b?q=1&r=2"');
    assert.ok(svg.includes('<a href="https://x.test/a%20b?q=1&amp;r=2" class="mm-gantt-click">'));
  });

  it('should let the last href that names a task win, as Mermaid keeps one', () => {
    assert.equal(hrefsOf(HEAD + 'click a1 href "https://a.test"\nclick a1 href "https://b.test"').a1, 'https://b.test');
    assert.equal(hrefsOf(HEAD + 'click a1 href "https://a.test"\nclick a1 href "javascript:x"').a1, null,
      'an unsafe later link does not resurrect the earlier one');
  });

  it('should keep an earlier link when a later statement for the task only names a call', () => {
    assert.equal(hrefsOf(HEAD + 'click a1 href "https://a.test"\nclick a1 call f()').a1, 'https://a.test');
  });

  it('should bind by id wherever the statement stands, and to every id it lists', () => {
    const source = 'gantt\ndateFormat YYYY-MM-DD\nclick a1,a2 href "https://x.test/p"\nA : a1, 2024-01-01, 3d\nB : a2, 2024-01-05, 2d';
    assert.deepEqual(hrefsOf(source), { a1: 'https://x.test/p', a2: 'https://x.test/p' });
  });

  it('should wrap the label and the shape of a linked row in one anchor inside its group', () => {
    const svg = svgOf(HEAD + 'click a2 href "https://x.test/p"');
    assert.match(svg, /<g class="mm-gantt-task mm-gantt-clickable" data-id="a2"><a href="https:\/\/x\.test\/p" class="mm-gantt-click"><text [^>]*class="mm-gantt-label"[^>]*>B<\/text><rect [^>]*class="mm-gantt-shape"[^>]*><\/rect><\/a><\/g>/);
    assert.match(svg, /<g class="mm-gantt-task" data-id="a1"><text /, 'an unlinked row keeps its shape');
  });

  it('should draw a milestone inside the anchor too', () => {
    const svg = svgOf('gantt\ndateFormat YYYY-MM-DD\nM : milestone, m1, 2024-01-03, 0d\nclick m1 href "/ship"');
    assert.match(svg, /<a href="\/ship" class="mm-gantt-click"><text [^>]*>M<\/text><polygon /);
  });

  it('should reach the document through the vnode renderer as well', () => {
    const vnode = renderMermaid(HEAD + 'click a1 href "https://x.test/p"');
    assert.ok(renderToString(vnode).includes('<a href="https://x.test/p" class="mm-gantt-click">'));
  });
});

describe('a linked row is styled as a link', () => {
  it('should give the anchor a pointer and a visible focus in the stylesheet', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'mermaid', 'styles', 'mermaid.css'), 'utf8');
    assert.match(css, /\.mm-gantt-click \{ cursor: pointer; \}/);
    assert.match(css, /\.mm-gantt-click:focus-visible \.mm-gantt-shape \{ stroke-width: 3; \}/);
  });
});

describe('a call is recorded and drawn as nothing', () => {
  const SOURCE = HEAD + 'click a1 call steal("document.cookie")\nclick a2 call go() href "https://x.test/p"';

  it('should keep the name and the arguments in the tree', () => {
    assert.deepEqual(parseMermaid(SOURCE).ast.clicks.map((/** @type {any} */ c) => c.call),
      [{ name: 'steal', args: ['document.cookie'] }, { name: 'go', args: [] }]);
  });

  it('should leave a call-only task unlinked, unmarked and without a handler', () => {
    const svg = svgOf(HEAD + 'click a1 call steal("document.cookie")');
    assert.deepEqual(hrefsOf(HEAD + 'click a1 call steal("document.cookie")'), { a1: null, a2: null });
    assert.ok(!svg.includes('steal') && !svg.includes('cookie'), 'the call text reaches no output');
    assert.ok(!svg.includes('<a ') && !svg.includes('clickable') && !/ on[a-z]+=/.test(svg));
  });

  it('should draw only the link of a statement that carries both', () => {
    const svg = svgOf(SOURCE);
    assert.ok(svg.includes('<a href="https://x.test/p" class="mm-gantt-click">'));
    assert.ok(!svg.includes('go()') && !svg.includes('steal'));
  });

  it('should render the same document byte for byte with and without the call', () => {
    const withCall = svgOf(HEAD + 'click a1 call steal(1)');
    assert.equal(withCall, svgOf(HEAD));
  });
});

describe('a hostile click line costs time linear in its length', () => {
  /** @type {[string, (n: number) => string][]} */
  const shapes = [
    ['spaces after call', (n) => 'click a1 call' + ' '.repeat(n)],
    ['spaces after href', (n) => 'click a1 href' + ' '.repeat(n)],
    ['spaces between the ids and the keyword', (n) => 'click a1' + ' '.repeat(n) + 'x'],
    ['an unclosed quote', (n) => 'click a1 href "' + 'a'.repeat(n)],
    ['quotes and commas in the arguments', (n) => 'click a1 call f(' + '",'.repeat(n) + ')'],
    ['many ids', (n) => 'click ' + 'a1,'.repeat(n) + ' href "u"'],
  ];
  for (const [name, make] of shapes) {
    it(`${name}: eight times the input costs far less than sixty-four times`, () => {
      const ratio = growthRatio((/** @type {string} */ line) => {
        try { readClick(line); }
        catch { /* a refusal is an answer */ }
      }, make(4000), make(32000), { limit: 24 });
      assert.ok(ratio < 24, `${name}: eight times the input multiplied the time by ${ratio.toFixed(1)}`);
    });
  }
});
