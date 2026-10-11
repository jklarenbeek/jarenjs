//@ts-check
/**
 * Diagram text is untrusted, so what it declares must stay data. A state
 * diagram that opened a composite state inside itself (or declared an
 * ancestor inside its own descendant) used to produce states that were each
 * other's parent: the parse succeeded, the canonical printer then threw a
 * bare TypeError. And a config key named `__proto__` re-parented the
 * config object instead of becoming a member, so its entries showed up as
 * inherited members that vanish when the document is serialized. And a
 * `style` or `classDef` value went verbatim into the shape's inline
 * `style` attribute, so `fill:#fff;cursor:url(//evil.test/x.png)` added
 * declarations of its own — including ones that load a remote resource.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid, parseMermaidConfig, compileMermaid, renderMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';

describe('state diagrams — a state is never its own ancestor', function () {
  it('a composite state opened inside itself stays under its first parent', () => {
    const doc = parseMermaid('stateDiagram-v2\n  state C {\n  state C {\n  A --> B\n}\n}');
    assert.deepEqual(doc.ast.states, [
      { id: 'C', label: 'C' },
      { id: 'A', label: 'A', parent: 'C' },
      { id: 'B', label: 'B', parent: 'C' },
    ]);

    assert.deepEqual(parseMermaid(toMermaid(doc)).ast, doc.ast);
  });

  it('an ancestor declared inside its own descendant is not re-parented into a cycle', () => {
    const doc = parseMermaid('stateDiagram-v2\n state A {\n state B {\n state A {\n}\n}\n}\n A --> B');
    assert.deepEqual(doc.ast.states, [{ id: 'A', label: 'A' }, { id: 'B', label: 'B', parent: 'A' }]);
    assert.doesNotThrow(() => toMermaid(doc));
    assert.deepEqual(parseMermaid(toMermaid(doc)).ast, doc.ast);
  });

  it('a state declared earlier at the top level is not pulled under its own child', () => {
    const doc = parseMermaid('stateDiagram-v2\n state A {\n state B\n}\nstate B {\n state A\n}');
    for (const state of doc.ast.states) {
      const seen = new Set();
      for (let id = state.id; id != null; id = doc.ast.states.find((s) => s.id === id)?.parent) {
        assert.equal(seen.has(id), false, `${state.id} is its own ancestor`);
        seen.add(id);
      }
    }
    assert.doesNotThrow(() => toMermaid(doc));
  });

  it('compiling such text still prints', () => {
    const compiled = compileMermaid('stateDiagram-v2\n state C {\n state C {\n A --> B\n}\n}');
    assert.equal(typeof compiled.toText(), 'string');
  });
});

describe('config — a prototype-named key is a member', function () {
  it('an init directive keeps __proto__ as an own member', () => {
    const { config } = parseMermaidConfig('%%{init: {"__proto__": {"polluted": 1}, "theme": "dark"}}%%\nflowchart TD\nA-->B');
    assert.deepEqual(Object.keys(config).sort(), ['__proto__', 'theme']);
    assert.equal(Object.getPrototypeOf(config), Object.prototype);
    assert.equal(/** @type {any} */ (config).polluted, undefined);
    assert.deepEqual(Object.getOwnPropertyDescriptor(config, '__proto__')?.value, { polluted: 1 });
  });

  it('front matter keeps __proto__ at every depth', () => {
    const { config } = parseMermaidConfig('---\nconfig:\n  __proto__:\n    polluted: 1\n  flowchart:\n    __proto__: 2\n---\nflowchart TD\nA-->B');
    assert.deepEqual(Object.keys(config).sort(), ['__proto__', 'flowchart']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(config, '__proto__')?.value, { polluted: 1 });
    assert.equal(Object.getOwnPropertyDescriptor(config.flowchart, '__proto__')?.value, 2);
    assert.equal(/** @type {any} */ (config).polluted, undefined);
  });

  it('merging two sources keeps the nested members of both', () => {
    const { config } = parseMermaidConfig('---\nconfig:\n  flowchart:\n    curve: basis\n---\n%%{init: {"flowchart": {"htmlLabels": false}}}%%\nflowchart TD\nA-->B');
    assert.deepEqual(config, { flowchart: { curve: 'basis', htmlLabels: false } });
  });
});

describe('style values — an author sets paint, not arbitrary CSS', function () {
  /** @param {string} style @returns {string} the first node shape element */
  const shapeOf = (style) => {
    const svg = renderToString(renderMermaid(`flowchart TD\n  A[x] --> B\n  ${style}`));
    return /** @type {RegExpExecArray} */ (/<rect[^>]*mm-node-shape[^>]*>/.exec(svg))[0];
  };

  it('keeps ordinary paint values', () => {
    const shape = shapeOf('style A fill:#eee,stroke:#f00,stroke-width:2px,stroke-dasharray:5 5,opacity:0.5');
    assert.match(shape, /style="fill:#eee;stroke:#f00;stroke-width:2;stroke-dasharray:5 5;opacity:0\.5"/);
    assert.match(shapeOf('style A fill:var(--accent)'), /style="fill:var\(--accent\)"/);
    assert.match(shapeOf('style A fill:url(#grad)'), /style="fill:url\(#grad\)"/);
    assert.match(shapeOf('style A fill:rgb(10 20 30)'), /style="fill:rgb\(10 20 30\)"/);
    assert.match(shapeOf('style A fill:hsl(210 50% 40% / 0.5)'), /style="fill:hsl\(210 50% 40% \/ 0\.5\)"/);
  });

  it('drops a value that carries a declaration separator, a url() or a function', () => {
    for (const style of [
      'style A fill:#fff;cursor:url(//evil.test/x.png)',
      'style A fill:url(https://evil.test/a.svg#p)',
      'style A fill:red;filter:url(//evil.test/f.svg#x)',
      'style A stroke:expression(alert(1))',
      'style A fill:#fff"/><script>',
      'style A fill:rgb(1 2 3);cursor:url(//evil.test/x.png)',
      'style A fill:url(#a);filter:url(//evil.test/f.svg#x)',
      'style A fill:url(#a.b)',
    ]) {
      const shape = shapeOf(style);
      assert.doesNotMatch(shape, /evil|url\(|expression|cursor|filter|script/, style);
      assert.doesNotMatch(shape, / style="/, style);
    }
  });

  it('drops an unsafe label color too, and keeps the derived ink', () => {
    const svg = renderToString(renderMermaid('flowchart TD\n  A[x] --> B\n  style A fill:#dcfce7,color:red;cursor:url(//evil.test/x.png)'));
    assert.doesNotMatch(svg, /evil|cursor/);
    assert.match(svg, /fill:#dcfce7/);
  });
});
