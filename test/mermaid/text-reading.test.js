//@ts-check
/**
 * Every diagram type's drawn text reads as a flowchart label reads: broken
 * into lines at `<br>`, its entity codes decoded last, decimal and named. A
 * sequence actor, message and note, a class or ER panel's rows and a gantt
 * row printed `#9829;` and `#59;` (Mermaid's documented way to write `;` in a
 * message) as written and a message's `<br/>` as text; and a named code
 * (`#quot;`) printed as written in every type. The layout measures the lines
 * the renderer draws, so a message that breaks takes the room its lines need.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileMermaid, renderMermaid, parseMermaid, toMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';
import { decodeEntityCodes, readTextLines } from '../../components/mermaid/src/label-text.js';

const svgOf = (/** @type {string} */ source) => renderToString(renderMermaid(source));
const layoutOf = (/** @type {string} */ source) => compileMermaid(source).toLayout();

describe('sequence — actors, messages and notes read their entity codes and line breaks', () => {
  it('decodes a message\'s codes, #59; included', () => {
    const source = 'sequenceDiagram\nA->>B: I #9829; you #59; ok';
    assert.deepEqual(layoutOf(source).messages[0].lines, ['I ♥ you ; ok']);
    assert.ok(svgOf(source).includes('>I ♥ you ; ok</text>'));
  });

  it('keeps the codes in the tree, so the printed source reads back the same', () => {
    const source = 'sequenceDiagram\nA->>B: I #9829; you #59; ok';
    const doc = parseMermaid(source);
    assert.equal(doc.ast.statements[0].text, 'I #9829; you #59; ok');
    assert.deepEqual(parseMermaid(toMermaid(doc)).ast, doc.ast);
  });

  it('measures and draws a message in the lines it breaks into', () => {
    const one = layoutOf('sequenceDiagram\nA->>B: one\nB->>A: x');
    const two = layoutOf('sequenceDiagram\nA->>B: one<br/>two\nB->>A: x');
    assert.deepEqual(one.messages.map((/** @type {any} */ m) => [m.y, m.lines]), [[86, ['one']], [126, ['x']]]);
    // the second line takes one line's height (14px × 1.2) above the message
    assert.deepEqual(two.messages.map((/** @type {any} */ m) => [m.y, m.lines]), [[102.8, ['one', 'two']], [142.8, ['x']]]);
    assert.deepEqual([one.height, two.height], [218, 234.8]);
    const label = svgOf('sequenceDiagram\nA->>B: one<br/>two').match(/<text[^>]*mm-message-label[\s\S]*?<\/text>/)?.[0];
    assert.equal(label, '<text font-size="14" text-anchor="middle" class="mm-message-label mm-edge-label" fill="#333333">'
      + '<tspan x="122" y="80">one</tspan><tspan x="122" y="96.8">two</tspan></text>');
  });

  it('measures and draws an actor, a self-message and a note in their lines', () => {
    const broken = layoutOf('sequenceDiagram\nparticipant A as Al<br/>Smith\nA->>A: s<br>t\nNote right of A: n #amp; m<br>x');
    const plain = layoutOf('sequenceDiagram\nparticipant A as Al\nA->>A: s\nNote right of A: n & m');
    const view = (/** @type {any} */ d) => ({
      actors: d.actors.map((/** @type {any} */ a) => [a.lines, a.h, a.w]),
      lineTop: d.lineTop,
      messages: d.messages.map((/** @type {any} */ m) => [m.y, m.lines]),
      notes: d.notes.map((/** @type {any} */ n) => [n.y, n.h, n.w, n.lines]),
    });
    assert.deepEqual(view(plain), {
      actors: [[['Al'], 34, 80]], lineTop: 46, messages: [[86, ['s']]], notes: [[138, 34, 55.01, ['n & m']]],
    });
    assert.deepEqual(view(broken), {
      actors: [[['Al', 'Smith'], 50.8, 80]], lineTop: 62.8, messages: [[111.2, ['s', 't']]], notes: [[171.6, 50.8, 55.01, ['n & m', 'x']]],
    });
    const svg = svgOf('sequenceDiagram\nparticipant A as Al<br/>Smith\nNote right of A: n #amp; m<br>x');
    assert.equal(svg.split('>Smith</tspan>').length - 1, 2, 'both actor boxes');
    assert.ok(svg.includes('>n &amp; m</tspan>'));
  });

  it('decodes a block\'s label', () => {
    assert.ok(svgOf('sequenceDiagram\nloop Every #59; tick\nA->>B: x\nend').includes('>loop [Every ; tick]</text>'));
  });
});

describe('class and ER panels read their rows', () => {
  it('decodes a row\'s codes and draws a broken row in its lines, the box grown to hold them', () => {
    const svg = svgOf('classDiagram\nclass A {\n  +items #lt;T#gt;\n}\nA --> B : one<br>two');
    assert.ok(svg.includes('>+items &lt;T&gt;</text>'));
    assert.ok(svg.includes('<text font-size="13" fill="#1f2020"><tspan x="26" y="204">A --&gt; B : one</tspan><tspan x="26" y="226">two</tspan></text>'));
    const flat = svgOf('classDiagram\nclass A {\n  +items #lt;T#gt;\n}\nA --> B : one');
    // one row's height (22px) more
    assert.deepEqual([flat, svg].map((s) => s.match(/height="(\d+)"/)?.[1]), ['234', '256']);
  });

  it('decodes an ER relationship\'s label', () => {
    assert.ok(svgOf('erDiagram\nA ||--o{ B : has #9829;').includes('>A ||--o{ B : has ♥</text>'));
  });
});

describe('gantt rows read their entity codes', () => {
  it('decodes a task\'s, a section\'s and the title\'s codes, measured as drawn', () => {
    const svg = svgOf('gantt\ntitle T #amp; U\ndateFormat YYYY-MM-DD\nsection S #35;1\nDesign #9829; it :a1, 2024-01-01, 3d');
    for (const text of ['>Design ♥ it<', '>S #1<', '>T &amp; U<', '>Gantt chart: T &amp; U<']) assert.ok(svg.includes(text), text);
    const width = (/** @type {string} */ name) => layoutOf(`gantt\ndateFormat YYYY-MM-DD\nsection S\n${name} :a1, 2024-01-01, 3d`).labelWidth;
    assert.equal(width('Design #9829; it'), width('Design ♥ it'));
  });

  it('draws a name on one line, its <br> as text, as Mermaid draws it', () => {
    assert.ok(svgOf('gantt\ndateFormat YYYY-MM-DD\nsection S\na<br>b :a1, 2024-01-01, 3d').includes('>a&lt;br&gt;b<'));
  });
});

describe('named entity codes, in every type', () => {
  it('reads a named code as the HTML standard names it', () => {
    assert.equal(decodeEntityCodes('#quot;a#quot;|#amp;|#lt;b#gt;|#AMP;|#ngE;|#copy;'), '"a"|&|<b>|&|≧̸|©');
    // tab and newline draw as a space, as their decimal codes do
    assert.equal(decodeEntityCodes('a#NewLine;b#Tab;c'), 'a b c');
  });

  it('never lets a named code break a line', () => {
    assert.deepEqual(readTextLines('#lt;br#gt;x<br>y'), ['<br>x', 'y']);
    assert.ok(svgOf('flowchart LR\n  A["#lt;br#gt; #amp; #copy;"]').includes('>&lt;br&gt; &amp; ©</tspan>'));
  });

  it('decodes in flowchart edges, state labels and sequence messages alike', () => {
    assert.ok(svgOf('flowchart LR\n  A -->|#quot;x#quot;| B').includes('>"x"</text>'));
    assert.ok(svgOf('stateDiagram-v2\n  s1 : a #amp; b').includes('>a &amp; b</tspan>'));
    assert.ok(svgOf('sequenceDiagram\nA->>B: #quot;hi#quot;').includes('>"hi"</text>'));
  });
});
