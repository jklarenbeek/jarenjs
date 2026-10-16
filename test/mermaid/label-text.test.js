//@ts-check
/**
 * @file The one reading of flowchart and state label text that the layout
 * measures and both label renderers draw: line breaks in every label form,
 * Mermaid's entity codes, and markdown strings. Decoded text is text — a
 * code never becomes a line break, emphasis or markup — and a subgraph
 * frame, title included, always lies inside the canvas.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  renderMermaid, compileMermaid, parseMermaid, toMermaid, createMermaidRenderer,
} from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';
import { textWidth } from '@jarenjs/view/helpers';
import { readLabel, decodeEntityCodes } from '../../components/mermaid/src/label-text.js';
import { createStubHost, StubElement, StubText } from '../view/dom.stub.js';

const svgOf = (/** @type {string} */ source, options = {}) => renderToString(renderMermaid(source, options));
const HTML = { htmlLabels: true };
/** Every `<text>` of a marker class, whole. */
const texts = (/** @type {string} */ svg, /** @type {string} */ cls) =>
  [...svg.matchAll(new RegExp(`<text[^>]*class="${cls}"[^>]*>[\\s\\S]*?</text>`, 'g'))].map((m) => m[0]);

describe('entity codes in labels', () => {
  it('decodes a decimal code in node, edge and subgraph labels, in SVG text and in HTML', () => {
    const source = 'flowchart LR\n  subgraph S ["Set #35;1"]\n    A["I #9829; you"] -->|"a #8594; b"| B\n  end';
    const svg = svgOf(source);
    assert.ok(svg.includes('>I ♥ you</tspan>'));
    assert.ok(svg.includes('>a → b</text>'));
    assert.ok(svg.includes('>Set #1</text>'));
    const html = svgOf(source, HTML);
    for (const line of ['I ♥ you', 'a → b', 'Set #1']) assert.ok(html.includes(`<div>${line}</div>`), line);
  });

  it('measures the decoded text, not the code', () => {
    const coded = compileMermaid('flowchart LR\n  A["#9829;"]').toLayout().nodes[0];
    const plain = compileMermaid('flowchart LR\n  A["♥♥♥♥"]').toLayout().nodes[0];
    assert.equal(coded.w, 48); // the minimum width: one heart, not six characters of code
    assert.ok(plain.w > 48);
  });

  it('reads a code as an HTML parser reads the reference Mermaid makes of it', () => {
    assert.equal(decodeEntityCodes('#65;|#065;|#150;|#128;|#159;|#129;|#127;'), 'A|A|–|€|Ÿ|\u0081|\u007F');
    // zero, a surrogate and past U+10FFFF are U+FFFD, as there
    assert.equal(decodeEntityCodes('#0;|#55296;|#57343;|#1114112;|#99999999999;'), '�|�|�|�|�');
    // what XML cannot carry is U+FFFD; tab, newline and return draw as a space
    assert.equal(decodeEntityCodes('#1;|#12;|#31;|#65534;|#65535;|#9;|#10;|#13;'), '�|�|�|�|�| | | ');
  });

  it('leaves what Mermaid does not read as a decimal code as written, named codes included', () => {
    assert.equal(decodeEntityCodes('#x2665; #+65; # 65; #65 #quot; #foo;'), '#x2665; #+65; # 65; #65 #quot; #foo;');
  });

  it('never lets a decoded character become markup, a line break or emphasis', () => {
    const script = '#60;script#62;alert(1)#60;/script#62;';
    const source = `flowchart LR\n  subgraph S ["${script}"]\n    A["${script}"] -->|"${script}"| B["\`**${script}**\`"]\n  end\n  B -->|"a#60;br#62;b #42;#42;c#42;#42;"| C`;
    const escaped = '&lt;script&gt;alert(1)&lt;/script&gt;';
    for (const options of [{}, HTML]) {
      const out = svgOf(source, options);
      assert.equal(out.includes('<script'), false);
      assert.equal(out.split(escaped).length - 1, 4, JSON.stringify(options));
      assert.ok(out.includes('a&lt;br&gt;b **c**'), 'one line, no emphasis');
      const reports = [];
      renderToString(renderMermaid(source, options), { safe: true, onUnsafe: (info) => reports.push(info) });
      assert.equal(reports.filter((r) => /script/.test(JSON.stringify(r))).length, 0);
    }
    const safe = [];
    const safeOut = renderToString(renderMermaid(source, { safe: true }), { safe: true, onUnsafe: (info) => safe.push(info) });
    assert.deepEqual(safe, []);
    assert.equal(safeOut.split(escaped).length - 1, 4);
    // through the DOM renderer: the decoded text is a text node, no element is a script
    const { document, container } = createStubHost();
    createMermaidRenderer({ container, document })(source);
    const tags = [];
    const strings = [];
    const walk = (/** @type {any} */ n) => {
      if (n instanceof StubText) strings.push(n.nodeValue);
      if (n instanceof StubElement) tags.push(String(n.tagName).toLowerCase());
      for (const c of n.childNodes ?? []) walk(c);
    };
    walk(container);
    assert.equal(tags.includes('script'), false);
    assert.equal(strings.filter((s) => s.includes('<script>alert(1)</script>')).length, 4);
  });
});

describe('markdown strings', () => {
  it('reads bold and italic runs, innermost emphasis winning, as Mermaid draws them', () => {
    const runs = (/** @type {string} */ s) => readLabel('`' + s + '`');
    assert.deepEqual(runs('**bold** md'), [[{ text: 'bold', type: 'strong' }, { text: ' md', type: 'normal' }]]);
    assert.deepEqual(runs('*a **b** c*'), [[{ text: 'a ', type: 'em' }, { text: 'b', type: 'strong' }, { text: ' c', type: 'em' }]]);
    assert.deepEqual(runs('***x***'), [[{ text: 'x', type: 'strong' }]]);
    assert.deepEqual(runs('__u__ and _i_'), [[{ text: 'u', type: 'strong' }, { text: ' and ', type: 'normal' }, { text: 'i', type: 'em' }]]);
    // unpaired, space-flanked and intraword `_` delimiters are text
    assert.deepEqual(runs('**open'), [[{ text: '**open', type: 'normal' }]]);
    assert.deepEqual(runs('* a *'), [[{ text: '* a *', type: 'normal' }]]);
    assert.deepEqual(runs('snake_case_name'), [[{ text: 'snake_case_name', type: 'normal' }]]);
    assert.deepEqual(runs('foo_bar_ baz'), [[{ text: 'foo_bar_ baz', type: 'normal' }]]);
    // codes decode after the emphasis is read: `#42;` is a star, never a delimiter
    assert.deepEqual(runs('#42;#42;x#42;#42; *#95;y#95;*'), [[{ text: '**x** ', type: 'normal' }, { text: '_y_', type: 'em' }]]);
    assert.deepEqual(runs('**a*'), [[{ text: '*', type: 'normal' }, { text: 'a', type: 'em' }]]);
  });

  it('breaks a markdown string into trimmed lines, dropping blank ones', () => {
    assert.deepEqual(readLabel('`  one <br/><br/>  **two**`'),
      [[{ text: 'one', type: 'normal' }], [{ text: 'two', type: 'strong' }]]);
    assert.deepEqual(readLabel('`  `'), ['']);
  });

  it('draws bold and italic runs inside their line, in SVG text and in HTML', () => {
    const source = 'flowchart LR\n  A["`**bold** and *it*`"] -->|"`*e*`"| B';
    const svg = svgOf(source);
    assert.ok(svg.includes('dominant-baseline="central"><tspan font-weight="bold">bold</tspan>'
      + '<tspan> and </tspan><tspan font-style="italic">it</tspan></tspan></text>'));
    assert.ok(svg.includes('dominant-baseline="central"><tspan font-style="italic">e</tspan></tspan></text>'));
    const html = svgOf(source, HTML);
    assert.ok(html.includes('<div><strong>bold</strong> and <em>it</em></div>'));
    assert.ok(html.includes('<div><em>e</em></div>'));
  });

  it('measures a bold run in the bold advance', () => {
    const [bold, plain] = compileMermaid('flowchart LR\n  A["`**bold**`"] --> B["bold"]').toLayout().nodes;
    assert.equal(bold.w, Math.round((textWidth('bold', 14, 700) + 28) * 100) / 100);
    assert.equal(plain.w, Math.round((textWidth('bold', 14) + 28) * 100) / 100);
    assert.ok(bold.w > plain.w);
  });

  it('wraps a long markdown HTML label at its spaces, each word keeping its style', () => {
    const scene = compileMermaid('flowchart LR\n  A["`**The quick brown fox** jumps over the lazy dog twice`"]', HTML).toLayout();
    // the plain label wraps after `over` (html-labels.test.js); the bold run
    // measures 4% wider, so here `over` no longer fits the first line
    assert.deepEqual(scene.nodes[0].lines, [
      [{ text: 'The quick brown fox', type: 'strong' }, { text: ' jumps', type: 'normal' }],
      [{ text: 'over the lazy dog twice', type: 'normal' }],
    ]);
  });

  it('draws a markdown subgraph title on its one line', () => {
    const svg = svgOf('flowchart TD\n  subgraph S ["`**T** one<br/>two`"]\n    A\n  end');
    assert.equal(texts(svg, 'mm-cluster-label')[0], '<text x="54" y="27" font-size="14" text-anchor="middle" class="mm-cluster-label" fill="#1f2020">'
      + '<tspan><tspan font-weight="bold">T</tspan><tspan> one two</tspan></tspan></text>');
  });

  it('prints a markdown string quoted, as Mermaid needs it to read one', () => {
    const doc = parseMermaid('flowchart LR\n  A[`**a**`] -->|`*b*`| B\n  subgraph S [`c`]\n    B\n  end');
    const printed = toMermaid(doc);
    assert.equal(printed, 'flowchart LR\nA["`**a**`"]\nB\nsubgraph S ["`c`"]\n  B\nend\nA -->|"`*b*`"| B\n');
    assert.deepEqual(parseMermaid(printed).ast, doc.ast);
  });

  it('pairs emphasis in time linear in the line', () => {
    // every `_` closer finds no `_` opener under the `*` openers: a pairing
    // that searched the whole stack each time would grow 64x over this step
    const label = (/** @type {number} */ n) => '`' + '*x '.repeat(n) + 'y_ '.repeat(n) + '`';
    const time = (/** @type {number} */ n) => {
      const inputs = Array.from({ length: 8 }, (_, i) => label(n) + i);
      const t0 = process.hrtime.bigint();
      for (const s of inputs) readLabel(s.slice(0, -1));
      return Number(process.hrtime.bigint() - t0);
    };
    time(1000);
    const small = Math.min(time(1000), time(1000), time(1000));
    const large = Math.min(time(8000), time(8000), time(8000));
    assert.ok(large / small < 24, `8x the input took ${(large / small).toFixed(1)}x the time`);
  });
});

describe('line breaks in edge labels', () => {
  const PIPE = 'flowchart LR\n  A -->|one<br/>two| B';

  it('draws an SVG edge label in the lines its background was measured for', () => {
    const scene = compileMermaid(PIPE).toLayout();
    assert.equal(scene.edges[0].labelH, 38.6);
    assert.deepEqual(texts(svgOf(PIPE), 'mm-edge-label'), ['<text font-size="14" text-anchor="middle" class="mm-edge-label" fill="#333333">'
      + '<tspan x="87" y="21" text-anchor="middle" dominant-baseline="central">one</tspan>'
      + '<tspan x="87" y="37.8" text-anchor="middle" dominant-baseline="central">two</tspan></text>']);
  });

  it('reads the inline form as the pipe form: no quotes, `<br>` a break', () => {
    const inline = 'flowchart LR\n  A -- "one<br/>two" --> B';
    assert.equal(parseMermaid(inline).ast.edges[0].label, 'one\ntwo');
    assert.equal(svgOf(inline), svgOf(PIPE));
    assert.equal(parseMermaid('flowchart LR\n  A -- "go on" --> B').ast.edges[0].label, 'go on');
    assert.equal(toMermaid(parseMermaid('flowchart LR\n  A -- "go on" --> B')), 'flowchart LR\nA\nB\nA -->|go on| B\n');
  });

  it('breaks a state transition and a state description at `<br>`, and prints both back as written', () => {
    const source = 'stateDiagram-v2\n  A --> B : one<br/>two\n  B : three<br/>four';
    const svg = svgOf(source);
    assert.equal(svg.includes('&lt;br'), false);
    const [edge] = texts(svg, 'mm-edge-label');
    assert.deepEqual([...edge.matchAll(/>([^<>]+)<\/tspan>/g)].map((m) => m[1]), ['one', 'two']);
    const scene = compileMermaid(source).toLayout();
    assert.equal(scene.edges[0].labelH, 38.6);
    assert.equal(scene.nodes[1].h, 51.6);
    assert.equal(toMermaid(parseMermaid(source)), 'stateDiagram-v2\nstate A\nB : three<br/>four\nA --> B : one<br/>two\n');
  });

  it('keeps a one-line edge label as one text element', () => {
    assert.deepEqual(texts(svgOf('flowchart LR\n  A -->|go| B'), 'mm-edge-label'), ['<text x="87" y="29.4" font-size="14" text-anchor="middle" dominant-baseline="central"'
      + ' class="mm-edge-label" fill="#333333">go</text>']);
  });
});

describe('subgraph frames inside the canvas', () => {
  /** @param {any} scene */
  const inside = (scene) => [...scene.subgraphs, ...scene.nodes].every((/** @type {any} */ s) =>
    s.x >= 12 && s.y >= 12 && s.x + s.w <= scene.width - 12 && s.y + s.h <= scene.height - 12);

  it('moves the diagram so a frame holding a first-rank node keeps the margin', () => {
    const source = 'flowchart TD\n  subgraph S [Stage one]\n    A --> B\n  end';
    const scene = compileMermaid(source).toLayout();
    assert.deepEqual(scene.subgraphs, [{ id: 'S', label: 'Stage one', x: 12, y: 12, w: 84, h: 181.6 }]);
    assert.deepEqual([scene.width, scene.height], [108, 205.6]);
    assert.deepEqual(scene.nodes.map((/** @type {any} */ n) => [n.id, n.x, n.y]), [['A', 30, 52], ['B', 30, 140.8]]);
    assert.deepEqual(scene.edges[0].points, [{ x: 54, y: 86.8 }, { x: 54, y: 140.8 }]);
    const svg = svgOf(source);
    assert.ok(svg.includes('viewBox="0 0 108 205.6"'));
    assert.ok(svg.includes('<rect x="12" y="12" width="84" height="181.6" rx="6" class="mm-cluster-rect"'));
    assert.equal(texts(svg, 'mm-cluster-label')[0].slice(0, 22), '<text x="54" y="27" fo');
  });

  it('holds every frame inside in every direction, nested frames too', () => {
    for (const dir of ['TD', 'BT', 'LR', 'RL']) {
      const scene = compileMermaid(`flowchart ${dir}\n  subgraph S [Stage one]\n    A --> B\n  end\n  B --> C`).toLayout();
      assert.ok(inside(scene), dir);
    }
    const nested = compileMermaid('flowchart TD\n  A --> B\n  subgraph O [outer]\n    B\n    subgraph I [inner]\n      C\n    end\n  end\n  B --> C').toLayout();
    assert.ok(inside(nested));
    assert.deepEqual(nested.subgraphs.map((/** @type {any} */ s) => [s.id, s.x, s.y]), [['I', 12, 149.6], ['O', 12, 60.8]]);
  });

  it('moves nothing when every frame is already inside the margin', () => {
    const scene = compileMermaid('flowchart TD\n  A[a very long label for the top node] --> B\n  subgraph S\n    B\n  end').toLayout();
    assert.deepEqual(scene.nodes.map((/** @type {any} */ n) => [n.id, n.x, n.y]), [['A', 12, 12], ['B', 103.95, 100.8]]);
    assert.deepEqual([scene.width, scene.height], [255.9, 165.6]);
    assert.deepEqual(scene.subgraphs[0], { id: 'S', label: 'S', x: 85.95, y: 60.8, w: 84, h: 92.8 });
  });

  it('moves an edge label with its edge', () => {
    const scene = compileMermaid('flowchart TD\n  subgraph S\n    A -->|go| B\n  end').toLayout();
    assert.deepEqual(scene.edges[0].points, [{ x: 54, y: 86.8 }, { x: 54, y: 140.8 }]);
    assert.deepEqual(scene.edges[0].labelPos, { x: 54, y: 113.8 });
  });

  it('leaves an empty subgraph where it was: it draws no frame', () => {
    const scene = compileMermaid('flowchart TD\n  A\n  subgraph E\n  end').toLayout();
    assert.deepEqual(scene.subgraphs[0], { id: 'E', label: 'E', x: 0, y: 0, w: 0, h: 0 });
    assert.deepEqual([scene.nodes[0].x, scene.nodes[0].y], [12, 12]);
    const moved = compileMermaid('flowchart TD\n  subgraph S\n    A\n  end\n  subgraph E\n  end').toLayout();
    assert.deepEqual(moved.subgraphs.map((/** @type {any} */ g) => [g.id, g.x, g.y, g.w]), [['S', 12, 12, 84], ['E', 0, 0, 0]]);
  });
});
