//@ts-check
/**
 * HTML labels: flowchart and state labels drawn as HTML inside a
 * `foreignObject`. The host turns them on (`htmlLabels: true` in the render
 * options); a diagram's own config can turn them off, as Mermaid's
 * directive overrides its site config, but never on — so a host that renders
 * through the view safe policy, which drops `foreignObject` and the labels
 * in it, cannot have every label blanked by an author's `%%{init}%%`.
 * The boxes are sized by the same advance table that sizes SVG text, so a
 * label that does not wrap lays out exactly as it does in SVG text; a line
 * wider than the wrapping width wraps, as a browser wraps Mermaid's HTML
 * label, and the box is sized for the wrapped lines with no DOM to ask.
 * `safe` keeps every label SVG text.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  parseMermaid, renderMermaid, diagramToVnode, layoutDiagram, compileMermaid,
} from '@jarenjs/mermaid';
import { mermaidPlugin } from '@jarenjs/mermaid/plugin';
import { createMermaidComponent } from '@jarenjs/mermaid/component';
import { renderToString } from '@jarenjs/view';
import { textWidth } from '@jarenjs/view/helpers';

/** The host's switch. */
const HOST = { htmlLabels: true };
const svgOf = (/** @type {string} */ source, options = {}) => renderToString(renderMermaid(source, options));
const count = (/** @type {string} */ text, /** @type {string} */ part) => text.split(part).length - 1;
const layout = (/** @type {string} */ source, options = {}) => layoutDiagram(parseMermaid(source), options);

describe('htmlLabels — the labels are HTML inside a foreignObject', () => {
  const BODY = 'flowchart LR\n  A[Hello] -->|go| B("one<br/>two")';

  it('draws a node label as one block per line, sized to the node box', () => {
    const svg = svgOf(BODY, HOST);
    assert.ok(svg.includes('<g class="mm-node" data-id="A"><rect x="12" y="20.4" width="59.12" height="34.8"'
      + ' class="mm-node-shape" fill="#dbeafe" stroke="#2563eb" stroke-width="1"></rect>'
      + '<foreignObject x="12" y="20.4" width="59.12" height="34.8" overflow="visible">'
      + '<div xmlns="http://www.w3.org/1999/xhtml" class="mm-label" style="display:flex;flex-direction:column;'
      + 'justify-content:center;align-items:center;width:100%;height:100%;font-size:14px;line-height:1.2;'
      + 'white-space:nowrap;text-align:center;color:var(--mm-node-text)"><div>Hello</div></div></foreignObject></g>'));
    assert.ok(svg.includes('<div>one</div><div>two</div>'));
    assert.ok(svg.includes('class="mm-edge-label" style="') && svg.includes('color:var(--mm-edge-label-text)"><div>go</div>'));
    assert.equal(count(svg, '<foreignObject'), 3);
    assert.equal(count(svg, '<text'), 0);
  });

  it('is the host\'s to turn on: a diagram\'s own directive alone keeps SVG text', () => {
    const plain = svgOf(BODY);
    for (const head of [
      '%%{init: {"htmlLabels": true}}%%\n',
      '%%{init: {"flowchart": {"htmlLabels": true}}}%%\n',
      '---\nconfig:\n  htmlLabels: true\n---\n',
    ]) {
      // and its config no longer reaches the root's style, so the output is
      // the plain output byte for byte
      assert.equal(svgOf(head + BODY), plain, head);
      assert.equal(svgOf(head + BODY, HOST).includes('<foreignObject'), true, head);
    }
  });

  it('lets the diagram turn them off, in every spelling Mermaid reads, the root one first', () => {
    const plain = svgOf(BODY);
    for (const head of [
      '%%{init: {"htmlLabels": false}}%%\n',
      '%%{init: {"htmlLabels": "false"}}%%\n',
      '%%{init: {"flowchart": {"htmlLabels": false}}}%%\n',
      '%%{init: {"htmlLabels": false, "flowchart": {"htmlLabels": true}}}%%\n',
      '%%{init: {"htmlLabels": null, "flowchart": {"htmlLabels": "0"}}}%%\n',
      '---\nconfig:\n  htmlLabels: false\n---\n',
    ]) assert.equal(svgOf(head + BODY, HOST), plain, head);
    assert.equal(svgOf('%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": false}}}%%\n' + BODY, HOST)
      .includes('<foreignObject'), true);
  });

  it('writes no void element, so the standalone SVG stays well-formed XML', () => {
    const svg = svgOf('flowchart TD\n  A["a<br>b<br/>c"] --> B["x < y & z"]', HOST);
    assert.equal(/<(br|hr|img|wbr)\b/.test(svg), false);
    assert.ok(svg.includes('<div>a</div><div>b</div><div>c</div>'));
    assert.ok(svg.includes('<div>x &lt; y &amp; z</div>'));
  });

  it('reads entity codes and markdown strings as SVG text reads them', () => {
    const body = 'flowchart LR\n  A["#quot;q#quot; #9829;"] --> B["`**md** x`"] --> C["<b>x</b>"]';
    const html = svgOf(body, HOST);
    const svg = svgOf(body);
    assert.equal(count(html, '<div>#quot;q#quot; \u2665</div>'), 1);
    assert.equal(count(svg, '>#quot;q#quot; \u2665</tspan>'), 1);
    assert.equal(count(html, '<div><strong>md</strong> x</div>'), 1);
    assert.equal(count(svg, '><tspan font-weight="bold">md</tspan><tspan> x</tspan></tspan>'), 1);
    assert.equal(count(html, '<div>&lt;b&gt;x&lt;/b&gt;</div>'), 1);
    assert.equal(count(svg, '>&lt;b&gt;x&lt;/b&gt;</tspan>'), 1);
  });

  it('gives an authored text color to the HTML label', () => {
    const svg = svgOf('flowchart LR\n  A[Red] --> B\n  style A color:#ff0000', HOST);
    assert.ok(svg.includes('text-align:center;color:#ff0000"><div>Red</div>'));
  });

  it('draws a subgraph title as HTML in the band at the top of its frame', () => {
    const svg = svgOf('flowchart TD\n  subgraph S [Stage one]\n    A --> B\n  end', HOST);
    assert.match(svg, /<g class="mm-cluster"><rect [^>]*><\/rect><foreignObject x="12" y="12" width="84" height="20" overflow="visible"><div xmlns="http:\/\/www.w3.org\/1999\/xhtml" class="mm-cluster-label" [^>]*><div>Stage one<\/div><\/div><\/foreignObject><\/g>/);
  });

  it('draws a state diagram\'s labels as HTML, and no label on a pseudo-state', () => {
    const svg = svgOf('stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy : start\n  Busy --> [*]', HOST);
    assert.equal(count(svg, '<foreignObject'), 3); // Idle, Busy, start
    assert.equal(count(svg, '<text'), 0);
    assert.ok(svg.includes('<div>Idle</div>') && svg.includes('<div>Busy</div>') && svg.includes('<div>start</div>'));
  });

  it('leaves the other diagram types as SVG text', () => {
    const seq = 'sequenceDiagram\n  A->>B: hi';
    assert.equal(svgOf(seq, HOST), svgOf(seq));
  });
});

describe('htmlLabels — parity with the SVG-text layout', () => {
  /** A graph whose labels all fit the wrapping width. */
  const GRAPHS = [
    'flowchart TD\n  A[Start] --> B{Is it?}\n  B -->|Yes| C[OK]\n  B -->|No| D[End]\n  C --> D',
    'flowchart LR\n  A(round) --> B([stadium])\n  B --> C{{hex}}\n  C ==> D[(db)]\n  D -.-> E((circle))\n  E --> F>flag]',
    'flowchart BT\n  subgraph S [Group]\n    A["two<br/>lines"] --> B[/para/]\n  end\n  B -->|label| C[\\alt\\]',
    'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : start\n  Running --> Idle : stop\n  Running --> [*]',
  ];
  const strip = (/** @type {any} */ scene) => JSON.parse(JSON.stringify(scene, (k, v) => (k === 'lines' || k === 'htmlLabels' ? undefined : v)));

  for (const body of GRAPHS) {
    it(`lays out ${body.split('\n')[0]} exactly as SVG text does (tolerance 0)`, () => {
      const svgScene = layout(body);
      const htmlScene = layout(body, HOST);
      assert.equal(htmlScene.htmlLabels, true);
      assert.deepEqual(strip(htmlScene), svgScene);
    });
    it(`draws each label of ${body.split('\n')[0]} once in both paths`, () => {
      const svgOut = svgOf(body);
      const htmlOut = svgOf(body, HOST);
      const scene = layout(body);
      const texts = [...scene.nodes.map((/** @type {any} */ n) => n.label), ...scene.edges.map((/** @type {any} */ e) => e.label)]
        .filter((l) => l !== null && l !== '').flatMap((l) => l.split('\n'));
      for (const text of texts) {
        assert.equal(count(htmlOut, `<div>${text}</div>`), texts.filter((t) => t === text).length, text);
        assert.equal(count(svgOut, `>${text}</t`), texts.filter((t) => t === text).length, text);
      }
    });
  }

  it('wraps a line wider than 200px at its spaces and sizes the box for the wrapped lines', () => {
    const body = 'flowchart TD\n  A[The quick brown fox jumps over the lazy dog twice] -->|a rather long edge label that wraps too| B[Supercalifragilisticexpialidociousnessisms]';
    const svgScene = layout(body);
    const scene = layout(body, HOST);
    const [a, b] = scene.nodes;
    assert.deepEqual(a.lines, ['The quick brown fox jumps over', 'the lazy dog twice']);
    assert.deepEqual([a.w, a.h], [226.41, 51.6]);
    assert.deepEqual([svgScene.nodes[0].w, svgScene.nodes[0].h], [342.36, 34.8]);
    // a single word wider than the width keeps its line, as a browser lets it overflow
    assert.deepEqual(b.lines, ['Supercalifragilisticexpialidociousnessisms']);
    assert.equal(b.w, svgScene.nodes[1].w);
    assert.deepEqual(scene.edges[0].lines, ['a rather long edge label that', 'wraps too']);
    for (const line of [...a.lines, ...scene.edges[0].lines]) assert.ok(textWidth(line, 14) <= 200, line);
    // the ranks and their order hold: A above B in both
    assert.ok(a.y + a.h < b.y && svgScene.nodes[0].y + svgScene.nodes[0].h < svgScene.nodes[1].y);
    const svg = svgOf(body, HOST);
    assert.ok(svg.includes('<div>The quick brown fox jumps over</div><div>the lazy dog twice</div>'));
    assert.ok(svg.includes('<foreignObject x="43.5" y="12" width="226.41" height="51.6" overflow="visible">'));
  });

  it('reads flowchart.wrappingWidth', () => {
    const body = 'flowchart TD\n  A[The quick brown fox jumps over the lazy dog twice]';
    const scene = layout('%%{init: {"flowchart": {"wrappingWidth": 100}}}%%\n' + body, HOST);
    assert.deepEqual(scene.nodes[0].lines, ['The quick', 'brown fox', 'jumps over the', 'lazy dog twice']);
    assert.deepEqual([scene.nodes[0].w, scene.nodes[0].h], [119.81, 85.2]);
  });

  it('wraps a markdown line only at a space, never where the style changes inside a word', () => {
    const source = (/** @type {number} */ width) => `%%{init: {"flowchart": {"wrappingWidth": ${width}}}}%%\n`
      + 'flowchart LR\n  A["`one two **three**four five`"]';
    assert.deepEqual(layout(source(110), HOST).nodes[0].lines, [
      [{ text: 'one two', type: 'normal' }],
      [{ text: 'three', type: 'strong' }, { text: 'four five', type: 'normal' }],
    ]);
    for (let width = 40; width <= 260; width += 5) {
      const lines = layout(source(width), HOST).nodes[0].lines
        .map((/** @type {any[]} */ line) => line.map((run) => run.text).join(''));
      assert.equal(lines.join(' '), 'one two threefour five', String(width));
    }
  });

  it('hands toLayout() the geometry it draws', () => {
    const source = 'flowchart TD\n  A[The quick brown fox jumps over the lazy dog twice] --> B';
    const compiled = compileMermaid(source, HOST);
    assert.deepEqual(compiled.toLayout(), layout(source, HOST));
    assert.deepEqual(compiled.toLayout().nodes[0].lines, ['The quick brown fox jumps over', 'the lazy dog twice']);
    const safe = compileMermaid(source, { ...HOST, safe: true }).toLayout();
    assert.equal(safe.htmlLabels, undefined);
    assert.deepEqual(safe, layout(source));
    assert.equal(safe.nodes[0].lines, undefined);
  });
});

describe('htmlLabels — safe mode keeps SVG text', () => {
  const SOURCE = 'flowchart LR\n  A[Hello] -->|go| B("one<br/>two")';
  const SAFE = { ...HOST, safe: true };

  it('loses every label when an HTML-label diagram meets the safe render policy', () => {
    /** @type {any[]} */
    const reports = [];
    const out = renderToString(renderMermaid(SOURCE, HOST), { safe: true, onUnsafe: (info) => reports.push(info) });
    assert.equal(out.includes('Hello'), false);
    assert.deepEqual(reports.map((r) => r.name), ['foreignObject', 'foreignObject', 'foreignObject']);
  });

  it('draws the SVG-text output, byte for byte, under safe: true', () => {
    assert.deepEqual(diagramToVnode(SOURCE, SAFE), diagramToVnode(SOURCE));
    assert.deepEqual(diagramToVnode('%%{init: {"htmlLabels": true}}%%\n' + SOURCE, SAFE),
      diagramToVnode('%%{init: {"htmlLabels": true}}%%\n' + SOURCE));
    /** @type {any[]} */
    const reports = [];
    const out = renderToString(renderMermaid(SOURCE, SAFE), { safe: true, onUnsafe: (info) => reports.push(info) });
    assert.deepEqual(reports, []);
    for (const text of ['Hello', 'go', 'one', 'two']) assert.equal(count(out, `>${text}</t`), 1, text);
  });

  it('reaches htmlLabels and safe through the plugin, the compiled document and the component', () => {
    const fence = { value: '%%{init: {"htmlLabels": true}}%%\n' + SOURCE };
    assert.equal(renderToString(mermaidPlugin().render(fence)).includes('foreignObject'), false);
    assert.equal(renderToString(mermaidPlugin(HOST).render(fence)).includes('foreignObject'), true);
    assert.equal(renderToString(mermaidPlugin(SAFE).render(fence)).includes('foreignObject'), false);
    assert.equal(compileMermaid(SOURCE, HOST).toSvgString().includes('foreignObject'), true);
    assert.equal(compileMermaid(SOURCE, SAFE).toSvgString().includes('foreignObject'), false);
    assert.equal(renderToString(createMermaidComponent().view(fence.value)).includes('foreignObject'), false);
    assert.equal(renderToString(createMermaidComponent(HOST).view(fence.value)).includes('foreignObject'), true);
    assert.equal(renderToString(createMermaidComponent(SAFE).view(fence.value)).includes('foreignObject'), false);
  });
});

describe('a diagram\'s config reaches the root style only as theme tokens', () => {
  const BODY = '\nflowchart LR\n  A --> B';
  const styleOf = (/** @type {string} */ svg) => /<svg [^>]*style="([^"]*)"/.exec(svg)?.[1] ?? '';

  it('writes no declaration from a value that would close its own', () => {
    const source = '%%{init: {"x": "1;position:fixed;inset:0", "nodeFill": "red;position:fixed"}}%%' + BODY;
    for (const options of [{}, HOST, { safe: true }, { theme: 'host' }]) {
      const svg = svgOf(source, options);
      assert.equal(svg.includes('position:fixed'), false, JSON.stringify(options));
      assert.equal(renderToString(renderMermaid(source, options), { safe: true }).includes('position'), false);
    }
    // the theme keeps its own value for the token whose override was unusable
    assert.equal(styleOf(svgOf(source)), styleOf(svgOf(BODY.trimStart())));
  });

  it('stamps no config member that is not a theme token, and never [object Object]', () => {
    const plain = styleOf(svgOf(BODY.trimStart()));
    for (const head of [
      '%%{init: {"flowchart": {"curve": "basis"}}}%%',
      '%%{init: {"htmlLabels": true, "gantt": {"topAxis": true}, "themeVariables": {"primaryColor": "#f00"}}}%%',
      '%%{init: {"theme": {"nodeFill": "red"}}}%%',
    ]) {
      const style = styleOf(svgOf(head + BODY));
      assert.equal(style, plain, head);
      assert.equal(style.includes('[object Object]'), false, head);
    }
  });

  it('still takes a theme token or a theme name from the config', () => {
    assert.ok(styleOf(svgOf('%%{init: {"nodeFill": "#ff0000"}}%%' + BODY)).includes('--mm-node-fill:#ff0000;'));
    assert.ok(svgOf('%%{init: {"nodeFill": "#ff0000"}}%%' + BODY).includes('fill="#ff0000"'));
    assert.equal(svgOf('%%{init: {"theme": "dark"}}%%' + BODY), svgOf(BODY.trimStart(), { theme: 'dark' }));
  });

  it('drops a token whose bracket or string never closes, which swallowed every declaration after it', () => {
    const plain = styleOf(svgOf(BODY.trimStart()));
    for (const bad of ['red(', 'red[', 'red)', 'a[b)', 'f(a))', '\'a"b\'"']) {
      assert.equal(styleOf(svgOf(`%%{init: {"nodeFill": ${JSON.stringify(bad)}}}%%` + BODY)), plain, bad);
      assert.equal(styleOf(svgOf(BODY.trimStart(), { theme: { nodeFill: bad } })), plain, bad);
    }
    for (const good of ['color-mix(in srgb, red 50%, blue)', 'rgb(1 2 3 / 0.5)', 'var(--x, rgb(1, 2, 3))']) {
      assert.ok(styleOf(svgOf(`%%{init: {"nodeFill": "${good}"}}%%` + BODY)).includes(`--mm-node-fill:${good};`), good);
    }
    const font = '"Font (Pro", serif';
    // a bracket inside a string is text
    assert.ok(styleOf(svgOf(BODY.trimStart(), { theme: { fontFamily: font } }))
      .includes(`--mm-font-family:${font.replaceAll('"', '&quot;')};`));
  });

  it('paints no remote url() from a diagram\'s config, as a style statement does not', () => {
    const remote = 'url(https://evil.example/p.svg#g)';
    const source = `%%{init: {"nodeFill": "${remote}", "nodeStroke": "URL(//evil.example/s.svg#s)", "lineColor": "url(#grad)"}}%%` + BODY;
    for (const options of [{}, HOST, { safe: true }]) {
      const svg = svgOf(source, options);
      assert.equal(svg.includes('evil.example'), false, JSON.stringify(options));
      assert.ok(svg.includes('--mm-line-color:url(#grad);'), JSON.stringify(options));
      assert.ok(styleOf(svg).includes('--mm-node-fill:#dbeafe;'), JSON.stringify(options));
    }
    assert.equal(svgOf(`flowchart LR\n  A --> B\n  style A fill:${remote}`).includes('evil.example'), false);
    // a host's own theme is the host's choice
    assert.ok(styleOf(svgOf(BODY.trimStart(), { theme: { nodeFill: remote } })).includes(`--mm-node-fill:${remote};`));
  });

  it('drops an unusable override a host passes too, and keeps a usable one', () => {
    for (const bad of ['a;b', 'a}b', 'a{b', 'a<b', 'a\\b', 'a\nb', 'a/*b', '"a', { r: 1 }, Infinity]) {
      const style = styleOf(svgOf(BODY.trimStart(), { theme: { nodeFill: bad } }));
      assert.ok(style.includes('--mm-node-fill:#dbeafe;'), String(bad));
    }
    assert.ok(styleOf(svgOf(BODY.trimStart(), { theme: { nodeFill: 'rgb(1, 2, 3)' } })).includes('--mm-node-fill:rgb(1, 2, 3);'));
    const linked = styleOf(svgOf(BODY.trimStart(), { theme: { vars: { nodeFill: '--x);position:fixed;--y:(', nodeStroke: '--accent' } } }));
    assert.equal(linked.includes('position'), false);
    assert.ok(linked.includes('--mm-node-fill:#dbeafe;') && linked.includes('--mm-node-stroke:var(--accent, #2563eb);'));
  });
});
