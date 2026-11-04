//@ts-check
/**
 * The vnode emitter memoizes a block per node, and a streamed document
 * reuses the nodes it already had. A heading id is numbered against the
 * emission that rendered it, so a reused block's ids are replayed against
 * the current one — kept when they come out the same, rendered afresh
 * (with the counter restored) when an earlier heading took their number.
 * Every emission numbers its headings exactly as a fresh one would.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileMarkdown, createIncrementalParser, mdToVnode, toHtml } from '@jarenjs/md';

/** @param {any} vnode */
const ids = (vnode) => [...JSON.stringify(vnode).matchAll(/"id":"([^"]*)"/g)].map((match) => match[1]);
/** @param {string} source */
const nodes = (source) => compileMarkdown(source).doc.ast;
/** @param {any[]} ast the ids a fresh emission (the string emitter keeps no memo) gives */
const fresh = (ast) => [...toHtml(ast, { headingIds: true }).matchAll(/ id="([^"]*)"/g)].map((match) => match[1]);

describe('md heading ids over reused blocks', () => {
  it('number a streamed document\'s repeated heading as a fresh render does', () => {
    const parser = createIncrementalParser();
    const first = parser.feed('# Setup\n\nfirst\n\n');
    parser.feed('more\n\n# Setup\n\nsecond\n');
    const done = parser.end();
    assert.deepEqual(ids(mdToVnode(first, { headingIds: true })), ['setup']);
    assert.equal(done.ast[0], first[0]);
    assert.deepEqual(ids(mdToVnode(done.ast, { headingIds: true })), ['setup', 'setup-1']);
  });

  it('renumber a reused heading that a new heading before it now outranks', () => {
    const [setup] = nodes('# Setup\n');
    assert.deepEqual(ids(mdToVnode([setup], { headingIds: true })), ['setup']);
    const ast = [...nodes('# Setup\n'), setup];
    assert.deepEqual(ids(mdToVnode(ast, { headingIds: true })), ['setup', 'setup-1']);
    assert.deepEqual(ids(mdToVnode(ast, { headingIds: true })), fresh(ast));
  });

  it('restore the counter when only part of a reused block replays', () => {
    const [quote] = nodes('> # A\n>\n> # B\n');
    assert.deepEqual(ids(mdToVnode([quote], { headingIds: true })), ['a', 'b']);
    const ast = [...nodes('# B\n'), quote, ...nodes('# A\n')];
    assert.deepEqual(fresh(ast), ['b', 'a', 'b-1', 'a-1']);
    assert.deepEqual(ids(mdToVnode(ast, { headingIds: true })), fresh(ast));
  });

  it('carry a reused heading\'s id into the record of a new block around it', () => {
    const [quote] = nodes('> # A\n');
    mdToVnode([quote], { headingIds: true });
    // a new container around the same heading node: the heading is reused inside it
    const wrapper = { ...quote, children: [...quote.children] };
    assert.deepEqual(ids(mdToVnode([wrapper], { headingIds: true })), ['a']);
    const ast = [...nodes('# A\n'), wrapper];
    assert.deepEqual(ids(mdToVnode(ast, { headingIds: true })), ['a', 'a-1']);
  });

  it('keep a reused block and its vnode when its ids replay unchanged', () => {
    const ast = nodes('# Intro\n\ntext\n\n# Usage\n');
    const before = mdToVnode(ast, { headingIds: true });
    const after = mdToVnode([...ast, ...nodes('# Intro\n')], { headingIds: true });
    assert.equal(after[2][0], before[2][0]);
    assert.equal(after[2][2], before[2][2]);
    assert.deepEqual(ids(after), ['intro', 'usage', 'intro-1']);
  });
});
