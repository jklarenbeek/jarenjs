//@ts-check
/**
 * Focused coverage for AST/visitor/printer/renderer code paths that the
 * feature-oriented suites never reach: the non-exported AST builders and
 * shape guard, the compiled per-type visitor machinery, the `html` and
 * `custom` node branches of both the Markdown printer and the vnode
 * emitter (plus the honest-degradation `fallbackVnode`), and the two
 * default hydrate-error sinks.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  parseMarkdown, mdToVnode, toMarkdown, compileMarkdown,
  createMdRenderer, isContainerNode, visitAst, hashContent,
} from '@jarenjs/md';
import { createMdComponent } from '@jarenjs/md/component';
import { definePlugin } from '@jarenjs/md/plugins';
import { renderToString } from '@jarenjs/view';
import { StubElement, createStubHost } from '../view/dom.stub.js';

// The AST builders are the package's node vocabulary but are not
// re-exported from the index; reach them through the ast submodule.
import {
  paragraph, heading, table, custom,
  text, emphasis, tableRow, tableCell, thematicBreak,
} from '../../components/md/src/ast.js';

// The md renderer needs two DOM members the view stub does not model
// (mirrors test/md/renderer.test.js).
/** @type {any} */ (StubElement.prototype).getAttribute = function (name) {
  return this.attributes.get(name) ?? null;
};
/** @type {any} */ (StubElement.prototype).querySelectorAll = function (selector) {
  const attr = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
  const out = [];
  const walk = (node) => {
    if (!(node instanceof StubElement)) return;
    if (attr !== undefined && node.attributes.has(attr)) out.push(node);
    for (const child of node.childNodes) walk(child);
  };
  walk(this);
  return out;
};

// ------------------------------------------------------------------
// ast.js: node builders + isContainerNode
// ------------------------------------------------------------------

describe('ast builders and isContainerNode', function () {
  it('paragraph/heading/table build canonical node shapes', function () {
    assert.deepEqual(paragraph([text('hi')]),
      { type: 'paragraph', children: [{ type: 'text', value: 'hi' }] });
    assert.deepEqual(heading(2, [text('Title')]),
      { type: 'heading', depth: 2, children: [{ type: 'text', value: 'Title' }] });
    const t = table([null], [tableRow([tableCell([text('a')])])]);
    assert.deepEqual(t, {
      type: 'table',
      align: [null],
      children: [{
        type: 'tableRow',
        children: [{ type: 'tableCell', children: [{ type: 'text', value: 'a' }] }],
      }],
    });
    // The built nodes are real: they print to canonical Markdown.
    assert.equal(toMarkdown([heading(2, [text('Title')])]), '## Title\n');
    assert.equal(toMarkdown([t]), '| a |\n| --- |\n');
  });

  it('custom builds both the childless and the container form', function () {
    // No children argument -> a leaf-shaped custom node (no `children`).
    assert.deepEqual(custom('box', { k: 1 }),
      { type: 'custom', name: 'box', data: { k: 1 } });
    // With children -> a container-shaped custom node.
    assert.deepEqual(custom('box', { k: 1 }, [text('x')]),
      { type: 'custom', name: 'box', data: { k: 1 }, children: [{ type: 'text', value: 'x' }] });
  });

  it('isContainerNode is true for children-holders, false for leaves', function () {
    assert.equal(isContainerNode(paragraph([])), true);              // CONTAINER_TYPES member
    assert.equal(isContainerNode(heading(1, [])), true);
    assert.equal(isContainerNode(custom('c', null, [text('y')])), true); // has a children array
    assert.equal(isContainerNode(text('t')), false);
    assert.equal(isContainerNode(thematicBreak()), false);
    assert.equal(isContainerNode(custom('c', null)), false);         // not a container type, no children
  });
});

// ------------------------------------------------------------------
// ast.js: visitAst / compileVisitorTable / visitNode
// ------------------------------------------------------------------

describe('visitAst / compileVisitorTable / visitNode', function () {
  it('dispatches function specs, {enter,exit} specs and the * wildcard', function () {
    const ast = [
      heading(1, [text('T')]),
      paragraph([text('a'), emphasis([text('b')])]),
    ];
    const events = [];
    const spec = {
      heading: (node) => { events.push('h:' + node.depth); },        // function form (enter only)
      paragraph: {                                                    // {enter, exit} form
        enter: () => { events.push('p-enter'); return false; },       // false skips the children
        exit: () => { events.push('p-exit'); },
      },
      '*': {                                                          // wildcard (object form)
        enter: (node) => { events.push('*enter:' + node.type); },
        exit: (node) => { events.push('*exit:' + node.type); },
      },
    };
    visitAst(ast, spec);
    assert.deepEqual(events, [
      'h:1',                          // heading's own enter
      '*enter:text', '*exit:text',    // heading's child falls to the wildcard
      '*exit:heading',                // heading has no exit spec -> wildcard exit
      'p-enter',                      // returns false -> emphasis/text are skipped
      'p-exit',                       // exit still runs after a skipped descent
    ]);

    // Passing the SAME spec object again serves the compiled table from
    // the WeakMap memo (compileVisitorTable's fast path).
    events.length = 0;
    visitAst(ast, spec);
    assert.deepEqual(events, [
      'h:1', '*enter:text', '*exit:text', '*exit:heading', 'p-enter', 'p-exit',
    ]);
  });

  it('accepts a single-node root and a bare-function wildcard', function () {
    const order = [];
    // A single node (not an array) as the root, and '*' as a plain
    // function (enter only, no exit).
    visitAst(paragraph([text('solo'), emphasis([text('deep')])]),
      { '*': (node) => { order.push(node.type); } });
    assert.deepEqual(order, ['paragraph', 'text', 'emphasis', 'text']);
  });
});

// ------------------------------------------------------------------
// compiler.js: CompiledMd.visit()
// ------------------------------------------------------------------

describe('CompiledMd.visit()', function () {
  it('walks the parsed AST through the compiled per-type visitor', function () {
    const md = compileMarkdown('# Head\n\nSome *text*.\n');
    const seen = [];
    md.visit({
      heading: (node) => { seen.push('heading@' + node.depth); },
      '*': (node) => { seen.push(node.type); },
    });
    // Pre-order, document order: heading (own spec) + its text (wildcard),
    // then the whole paragraph subtree (all wildcard).
    assert.deepEqual(seen, [
      'heading@1', 'text',
      'paragraph', 'text', 'emphasis', 'text', 'text',
    ]);
  });
});

// ------------------------------------------------------------------
// to-md.js: html (inline + block) and custom printers
// ------------------------------------------------------------------

describe('toMarkdown: html and custom nodes', function () {
  it('prints inline raw HTML verbatim', function () {
    // parseMarkdown yields inline `html` nodes for the tags.
    const doc = parseMarkdown('a <b>c</b> d');
    assert.equal(doc.ast[0].children[1].type, 'html');
    assert.equal(toMarkdown(doc), 'a <b>c</b> d\n');
  });

  it('prints a block-level raw HTML node verbatim', function () {
    const doc = parseMarkdown('<div class="x">\nraw\n</div>\n\npara');
    assert.equal(doc.ast[0].type, 'html');
    assert.equal(toMarkdown(doc), '<div class="x">\nraw\n</div>\n\npara\n');
  });

  it('prints a custom container by printing its children, and an empty one as nothing', function () {
    const withChildren = custom('sec', {}, [heading(2, [text('Hi')]), paragraph([text('body')])]);
    assert.equal(toMarkdown([withChildren]), '## Hi\n\nbody\n');
    assert.equal(toMarkdown([custom('empty', {})]), '');
  });
});

// ------------------------------------------------------------------
// to-vnode.js: html, custom and fallbackVnode
// ------------------------------------------------------------------

describe('mdToVnode: html, custom and honest fallbacks', function () {
  it('shows inline raw HTML as text with html:"text" and drops it by default', function () {
    const doc = parseMarkdown('a <b>c</b> d');
    assert.equal(renderToString(mdToVnode(doc, { html: 'text' })),
      '<article class="md"><p>a &lt;b&gt;c&lt;/b&gt; d</p></article>');
    assert.equal(renderToString(mdToVnode(doc)),
      '<article class="md"><p>a c d</p></article>');
  });

  it('renders a custom container as a div.md-custom and a childless custom as nothing', function () {
    assert.equal(
      renderToString(mdToVnode([custom('sec', {}, [paragraph([text('hi')])])])),
      '<article class="md"><div class="md-custom"><p>hi</p></div></article>');
    // No value and no children -> fallbackVnode returns null.
    assert.equal(
      renderToString(mdToVnode([custom('empty', {})])),
      '<article class="md"></article>');
  });

  it('degrades unknown inline nodes to code/span and unknown blocks to pre', function () {
    // Unknown inline with a string value -> <code class="md-*">.
    assert.equal(
      renderToString(mdToVnode([paragraph([{ type: 'xinline', value: 'XV' }])])),
      '<article class="md"><p><code class="md-xinline">XV</code></p></article>');
    // Unknown inline with children -> <span class="md-*">.
    assert.equal(
      renderToString(mdToVnode([paragraph([{ type: 'xspan', children: [text('IN')] }])])),
      '<article class="md"><p><span class="md-xspan">IN</span></p></article>');
    // Unknown block with a string value -> <pre class="md-*">.
    assert.equal(
      renderToString(mdToVnode([{ type: 'rawblock', value: 'RAWBODY' }])),
      '<article class="md"><pre class="md-rawblock">RAWBODY</pre></article>');
  });
});

// ------------------------------------------------------------------
// The default hydrate-error sinks (component + renderer)
// ------------------------------------------------------------------

/** A plugin whose hydrate throws, to drive the error path. */
function boomPlugin(message) {
  return definePlugin({
    name: 'boom',
    fences: ['boom'],
    node: 'boom',
    render: (node, h) => h('div', {
      class: 'boom',
      'data-md-hydrate': 'boom',
      'data-md-hash': hashContent(node.value),
    }),
    hydrate: () => { throw new Error(message); },
  });
}

/** Run `fn` with console.error captured; returns the captured call args. */
async function withCapturedConsoleError(fn) {
  /** @type {any[][]} */
  const logs = [];
  // eslint-disable-next-line no-console
  const original = console.error;
  // eslint-disable-next-line no-console
  console.error = (...args) => { logs.push(args); };
  try {
    await fn();
  }
  finally {
    // eslint-disable-next-line no-console
    console.error = original;
  }
  return logs;
}

describe('default hydrate-error sinks', function () {
  it('createMdComponent logs a thrown hydrate to console.error by default', async function () {
    const md = createMdComponent({ plugins: [boomPlugin('kaput')] }); // no onHydrateError -> default sink
    md.view('```boom\nX\n```\n');                                      // indexes the hydratable node
    const hash = hashContent('X\n');
    const el = { getAttribute: (n) => (n === 'data-md-hydrate' ? 'boom' : hash) };
    const container = { querySelectorAll: () => [el] };

    const logs = await withCapturedConsoleError(() => { md.hydrate(container); });
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'md hydrate:');
    assert.equal(logs[0][1].message, 'kaput');
  });

  it('createMdRenderer logs a thrown hydrate to console.error by default', async function () {
    const plugins = [boomPlugin('kaboom')];
    const { document, container } = createStubHost();
    const render = createMdRenderer({ container, document, plugins }); // no onHydrateError -> default sink

    const logs = await withCapturedConsoleError(async () => {
      render(compileMarkdown('```boom\nboom body\n```\n', { plugins }));
      await new Promise((resolve) => setTimeout(resolve, 0));         // let the hydrate microtask run
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'md hydrate:');
    assert.equal(logs[0][1].message, 'kaboom');
  });
});
