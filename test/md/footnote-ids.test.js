//@ts-check
/**
 * Heading ids and footnote ids share one page: an emission reserves the
 * ids its footnotes carry before it numbers its headings, so no two
 * elements share an id whatever `slugPrefix` is — and the vnode emitter's
 * per-node memo keeps a block rendered under one footnote prefix out of a
 * render under another.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileMarkdown, mdToVnode, toHtml } from '@jarenjs/md';

const SOURCE = '# fn 1\n\nA claim[^1] and again[^1].\n\n# fnref 1\n\n# fnref 1 2\n\n[^1]: The source.\n';

/** @param {string} html */
const htmlIds = (html) => [...html.matchAll(/ id="([^"]*)"/g)].map((match) => match[1]);
/** @param {any} vnode */
const vnodeIds = (vnode) => [...JSON.stringify(vnode).matchAll(/"id":"([^"]*)"/g)].map((match) => match[1]);
/** @param {string[]} ids */
const duplicates = (ids) => ids.filter((id, i) => ids.indexOf(id) !== i);

describe('md heading and footnote ids', () => {
  for (const [name, prefix] of /** @type {const} */ ([['an empty prefix', ''], ['no prefix', undefined],
    ['the user-content- prefix', 'user-content-']])) {
    it(`never repeat under ${name}, in either emitter`, () => {
      const { doc } = compileMarkdown(SOURCE);
      const options = prefix === undefined ? { headingIds: true } : { headingIds: true, slugPrefix: prefix };
      const ids = htmlIds(toHtml(doc, options));
      assert.deepEqual(duplicates(ids), []);
      assert.deepEqual(vnodeIds(mdToVnode(doc, options)), ids);
    });
  }

  it('number a heading past the footnote ids it would share, and leave the footnotes as they were', () => {
    const { doc } = compileMarkdown(SOURCE);
    assert.deepEqual(htmlIds(toHtml(doc, { headingIds: true, slugPrefix: '' })),
      ['fn-1-1', 'fnref-1', 'fnref-1-2', 'fnref-1-1', 'fnref-1-2-1', 'fn-1']);
    // under the default prefixes the two spaces are apart, and nothing moves
    assert.deepEqual(htmlIds(toHtml(doc, { headingIds: true })),
      ['fn-1', 'user-content-fnref-1', 'user-content-fnref-1-2', 'fnref-1', 'fnref-1-2', 'user-content-fn-1']);
    // a heading that spells a default footnote id numbers past it
    assert.deepEqual(htmlIds(toHtml(compileMarkdown('# user-content-fn-1\n\nA[^1]\n\n[^1]: x\n').doc,
      { headingIds: true })), ['user-content-fn-1-1', 'user-content-fnref-1', 'user-content-fn-1']);
  });

  it('keep every heading id of a document without footnotes', () => {
    const ids = htmlIds(toHtml(compileMarkdown('# fn 1\n\n# fnref 1\n').doc, { headingIds: true, slugPrefix: '' }));
    assert.deepEqual(ids, ['fn-1', 'fnref-1']);
  });

  it('follow each render\'s footnote prefix when one document renders with an empty prefix and then without one', () => {
    const { doc } = compileMarkdown(SOURCE);
    const bare = mdToVnode(doc, { headingIds: true, slugPrefix: '' });
    const prefixed = mdToVnode(doc, { headingIds: true });
    const again = mdToVnode(doc, { headingIds: true, slugPrefix: '' });
    assert.match(JSON.stringify(prefixed), /"href":"#user-content-fn-1"/);
    assert.doesNotMatch(JSON.stringify(prefixed), /"href":"#fn-1"/);
    assert.deepEqual(vnodeIds(prefixed), htmlIds(toHtml(doc, { headingIds: true })));
    assert.deepEqual(again, bare);
  });
});
