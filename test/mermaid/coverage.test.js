//@ts-check
/**
 * @file Focused coverage for engine paths the other suites never drive:
 * the compiled bundle's `toText`/`walk` (→ `walkDoc`), the host-DOM
 * `createMermaidRenderer`, sequence activation + block layout/render,
 * the explicit `activate`/`deactivate` AST constructor and
 * `walkSequence`, the injected-frontmatter config guard, and the
 * class/ER/gantt/pie canonical printers.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  parseMermaid, toMermaid, compileMermaid, layoutDiagram, renderMermaid,
  createMermaidRenderer, parseMermaidConfig, walkSequence,
} from '@jarenjs/mermaid';
import { renderToString, isElementNode } from '@jarenjs/view';
import { createStubHost, serialize } from '../view/dom.stub.js';

/**
 * A sequence that uses explicit `activate`/`deactivate`, the `+`/`-`
 * message shorthand, a `loop` block and a two-branch `alt` block — every
 * activation and block path in one document.
 */
const SEQ = `sequenceDiagram
  participant A as Alice
  participant B as Bob
  activate A
  A->>+B: request
  B-->>-A: response
  deactivate A
  loop every minute
    A->>B: ping
  end
  alt is ok
    A->>B: yes
  else not ok
    A->>A: retry
  end`;

/** Compact tag for a visited sequence statement. */
const tagOf = (s) => s.kind === 'message' ? 'msg:' + s.text
  : s.kind === 'block' ? 'block:' + s.blockType
    : s.kind;

const EXPECTED_WALK = [
  'activate', 'msg:request', 'msg:response', 'deactivate',
  'block:loop', 'msg:ping', 'block:alt', 'msg:yes', 'msg:retry',
];

describe('ast: explicit activate/deactivate + walkSequence', function () {
  it('parses explicit activate/deactivate into seqActivation nodes', function () {
    // The parser builds these statements with `seqActivation(kind, actor)`.
    const doc = parseMermaid(SEQ);
    assert.deepEqual(doc.ast.statements[0], { kind: 'activate', actor: 'A' });
    assert.deepEqual(doc.ast.statements[3], { kind: 'deactivate', actor: 'A' });
  });

  it('walkSequence visits pre-order and descends into block branches', function () {
    const doc = parseMermaid(SEQ);
    /** @type {string[]} */
    const visited = [];
    walkSequence(doc.ast.statements, (s) => visited.push(tagOf(s)));
    // Both blocks are visited *before* their nested messages (pre-order),
    // and the loop body + both alt branches are descended into.
    assert.deepEqual(visited, EXPECTED_WALK);
    assert.ok(visited.indexOf('block:loop') < visited.indexOf('msg:ping'));
    assert.ok(visited.indexOf('block:alt') < visited.indexOf('msg:retry'));
  });
});

describe('compileMermaid bundle: toText / walk / walkDoc', function () {
  it('toText re-emits canonical text and memoizes', function () {
    const c = compileMermaid(SEQ);
    const text = c.toText();
    assert.equal(text.split('\n')[0], 'sequenceDiagram');
    assert.match(text, /loop every minute/);
    assert.match(text, /alt is ok/);
    // Second call returns the cached string (===, not just equal).
    assert.equal(c.toText(), text);
    // A round trip re-parses to the same AST.
    assert.deepEqual(parseMermaid(text).ast, c.doc.ast);
  });

  it('toText falls back to source when the parse failed', function () {
    const c = compileMermaid('flowchart TD\n  A[unterminated');
    assert.equal(c.doc, null);
    assert.equal(c.toText(), 'flowchart TD\n  A[unterminated');
  });

  it('walk descends a sequence document (walkDoc sequence branch)', function () {
    /** @type {string[]} */
    const visited = [];
    compileMermaid(SEQ).walk((s) => visited.push(tagOf(s)));
    assert.deepEqual(visited, EXPECTED_WALK);
  });

  it('walk visits flowchart nodes then edges (walkDoc flowchart branch)', function () {
    /** @type {any[]} */
    const seen = [];
    compileMermaid('flowchart TD\n  A[Start] --> B\n  B --> C').walk((s) => seen.push(s));
    // 3 nodes (A, B, C) followed by 2 edges.
    assert.equal(seen.length, 5);
    assert.deepEqual(seen.slice(0, 3).map((n) => n.id), ['A', 'B', 'C']);
    assert.equal(seen[3].from, 'A');
    assert.equal(seen[3].to, 'B');
    assert.equal(seen[4].to, 'C');
  });

  it('walk visits a leaf-type AST once (walkDoc else branch)', function () {
    /** @type {any[]} */
    const seen = [];
    compileMermaid('pie\n  "a" : 1\n  "b" : 2').walk((s) => seen.push(s));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].slices.length, 2);
  });

  it('walk is a no-op when the document failed to parse', function () {
    let count = 0;
    compileMermaid('flowchart TD\n  A[unterminated').walk(() => count++);
    assert.equal(count, 0);
  });
});

describe('createMermaidRenderer: host-DOM factory', function () {
  it('mounts an svg and reconciles new content on re-render', function () {
    const { document, container } = createStubHost();
    const render = createMermaidRenderer({ container, document });

    render('flowchart TD\n  A[Start] --> B[End]');
    assert.equal(container.childNodes.length, 1);
    assert.equal(container.childNodes[0].tagName, 'svg');
    const flowMarkup = serialize(container);
    assert.match(flowMarkup, /<svg[^>]*class="mermaid mm-svg"/);
    assert.match(flowMarkup, /Start/); // flowchart node label rendered
    assert.equal(flowMarkup.includes('mm-message-line'), false); // no sequence parts yet

    // A second render reconciles into the *same* container (still exactly
    // one root) and swaps in sequence-only content (`mm-message-line` is a
    // sequence-render class, not a theme CSS var).
    render('sequenceDiagram\n  A->>B: hi');
    assert.equal(container.childNodes.length, 1);
    assert.equal(container.childNodes[0].tagName, 'svg');
    const seqMarkup = serialize(container);
    assert.match(seqMarkup, /mm-message-line/);
    assert.equal(seqMarkup.includes('Start'), false);
  });

  it('renders an error vnode for bad source without throwing', function () {
    const { document, container } = createStubHost();
    const render = createMermaidRenderer({ container, document });
    assert.doesNotThrow(() => render('flowchart TD\n  A[unterminated'));
    assert.match(serialize(container), /mm-error/);
  });
});

describe('layout/sequence: activation bars', function () {
  it('activate/deactivate produce balanced activation rectangles', function () {
    const scene = layoutDiagram(parseMermaid(SEQ));
    assert.equal(scene.type, 'sequence');
    // Two balanced activations: explicit `activate A`…`deactivate A`, and
    // the `A->>+B` / `B-->>-A` shorthand pair.
    assert.equal(scene.activations.length, 2);
    for (const a of scene.activations) {
      assert.equal(a.w, 10); // ACT_W
      assert.ok(a.h > 0, 'activation has positive height');
      assert.ok(a.y > 0, 'activation starts below the actor row');
    }
    // The loop and alt frames are present in the scene too.
    assert.deepEqual(scene.blocks.map((b) => b.blockType), ['loop', 'alt']);
  });
});

describe('render/sequence: block frames (renderBlock)', function () {
  it('draws loop/alt frame labels and the else divider', function () {
    const v = renderMermaid(SEQ);
    assert.ok(isElementNode(v));
    const svg = renderToString(v);
    assert.match(svg, /loop \[every minute\]/);
    assert.match(svg, /alt \[is ok\]/);
    // The `else not ok` branch renders a divider label.
    assert.match(svg, /\[not ok\]/);
  });
});

describe('parseMermaidConfig: injected frontmatter (safeCall)', function () {
  it('routes frontmatter through options.parseFrontmatter', function () {
    /** @type {string|null} */
    let seen = null;
    const result = parseMermaidConfig('---\ntitle: X\n---\nflowchart TD\n  A-->B', {
      parseFrontmatter: (text) => {
        seen = text;
        return { title: 'Injected', config: { theme: 'dark' } };
      },
    });
    assert.equal(seen, 'title: X\n');
    assert.equal(result.title, 'Injected');
    assert.deepEqual(result.config, { theme: 'dark' });
    assert.equal(result.body.trim().startsWith('flowchart'), true);
  });

  it('swallows a throwing parseFrontmatter and yields empty config', function () {
    const result = parseMermaidConfig('---\ntitle: X\n---\nflowchart TD\n  A-->B', {
      parseFrontmatter: () => { throw new Error('boom'); },
    });
    // safeCall caught the throw → null → no title/config, body still intact.
    assert.equal(result.title, null);
    assert.deepEqual(result.config, {});
    assert.equal(result.body.trim().startsWith('flowchart'), true);
  });
});

describe('to-mermaid: class/ER/gantt/pie printers', function () {
  it('printClass emits class bodies and relations', function () {
    const text = toMermaid(parseMermaid(
      'classDiagram\nclass Animal {\n +int age\n +run()\n}\nAnimal <|-- Dog\nAnimal <|-- Cat : extends'));
    assert.equal(text.split('\n')[0], 'classDiagram');
    assert.match(text, /class Animal \{/);
    assert.match(text, /\+int age/);
    assert.match(text, /\+run\(\)/);
    assert.match(text, /Animal <\|-- Dog/);
    assert.match(text, /Animal <\|-- Cat : extends/);
  });

  it('printEr emits entity attributes and a relationship', function () {
    const text = toMermaid(parseMermaid(
      'erDiagram\nCUSTOMER {\n string name PK\n int age\n}\nCUSTOMER ||--|| ORDER : places'));
    assert.equal(text.split('\n')[0], 'erDiagram');
    assert.match(text, /CUSTOMER \{/);
    assert.match(text, /string name PK/);
    assert.match(text, /CUSTOMER \|\|--\|\| ORDER : places/);
  });

  it('printGantt emits meta, section and task rows', function () {
    const text = toMermaid(parseMermaid(
      'gantt\ntitle My Plan\ndateFormat YYYY-MM-DD\nsection Design\nTask A : a1, 2014-01-01, 3d'));
    assert.equal(text.split('\n')[0], 'gantt');
    assert.match(text, /title My Plan/);
    assert.match(text, /dateFormat YYYY-MM-DD/);
    assert.match(text, /section Design/);
    assert.match(text, /Task A : a1, 2014-01-01, 3d/);
  });

  it('printPie emits the showData flag, title and slices', function () {
    const text = toMermaid(parseMermaid('pie showData\ntitle Pets\n"Dogs" : 40\n"Cats" : 25'));
    assert.equal(text.split('\n')[0], 'pie showData');
    assert.match(text, /title Pets/);
    assert.match(text, /"Dogs" : 40/);
    assert.match(text, /"Cats" : 25/);
  });
});
