//@ts-check
/**
 * The emitters' option sets are closed. `mdToVnode`, `toHtml` and
 * `createMdRenderer` refuse an unknown member — naming the nearest one —
 * and a member of the wrong type, instead of rendering with a default the
 * caller did not ask for. The heading-id prefix is the case that matters:
 * a host rendering Markdown it did not author sets `slugPrefix` so author
 * text cannot mint ids that collide with its own, and a misspelt or
 * mistyped prefix used to switch that guard off without a word.
 *
 * Valid options, and members passed explicitly as `undefined` (the shape a
 * forwarding caller builds), render exactly as before.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, mdToVnode, toHtml, createMdRenderer, compileMarkdown } from '@jarenjs/md';
import { renderToString } from '@jarenjs/view';
import { createStubHost } from '../view/dom.stub.js';

const doc = parseMarkdown('# config\n\ntext');
/** @param {any} options */
const vnodeHtml = (options) => renderToString(mdToVnode(doc, options));

/**
 * @param {() => unknown} run @param {RegExp} message
 */
function refuses(run, message) {
  assert.throws(run, (/** @type {any} */ err) => {
    assert.equal(err instanceof TypeError, true, `a TypeError, got ${err?.name}: ${err?.message}`);
    assert.match(err.message, message);
    return true;
  });
}

describe('mdToVnode — a closed option set', function () {
  it('renders valid options, and explicit undefined members, exactly as before', function () {
    const expected = '<article class="md"><h1 id="user-content-config">config</h1><p>text</p></article>';
    assert.equal(vnodeHtml({ headingIds: true, slugPrefix: 'user-content-' }), expected);
    assert.equal(vnodeHtml({
      headingIds: true, slugPrefix: 'user-content-', plugins: undefined, html: undefined,
      parseHtml: undefined, sanitizeUrl: undefined, headingAnchors: undefined,
      footnotesLabel: undefined, keyed: undefined,
    }), expected);
    assert.equal(vnodeHtml(undefined), '<article class="md"><h1>config</h1><p>text</p></article>');
  });

  it('refuses a misspelt member, naming the one it meant', function () {
    refuses(() => mdToVnode(doc, { headingIds: true, slugprefix: 'user-content-' }),
      /^md mdToVnode: unknown option 'slugprefix' — did you mean 'slugPrefix'\?$/);
    refuses(() => mdToVnode(doc, { headingids: true }), /did you mean 'headingIds'\?/);
  });

  it('refuses a member of the wrong type', function () {
    refuses(() => mdToVnode(doc, { headingIds: true, slugPrefix: 5 }),
      /^md mdToVnode: option 'slugPrefix' must be a string, got 5$/);
    refuses(() => mdToVnode(doc, { headingIds: true, slugPrefix: null }),
      /option 'slugPrefix' must be a string, got null/);
    refuses(() => mdToVnode(doc, { headingIds: 'false' }),
      /option 'headingIds' must be a boolean, got "false"/);
    refuses(() => mdToVnode(doc, { html: 'Vnode' }),
      /^md mdToVnode: option 'html' must be 'skip', 'text' or 'vnode', got "Vnode" — did you mean 'vnode'\?$/);
    // a policy no member is close to is answered with the list alone
    refuses(() => mdToVnode(doc, { html: 'raw' }),
      /^md mdToVnode: option 'html' must be 'skip', 'text' or 'vnode', got "raw"$/);
    refuses(() => mdToVnode(doc, { sanitizeUrl: null }), /option 'sanitizeUrl' must be a function, got null/);
    refuses(() => mdToVnode(doc, { parseHtml: 'x' }), /option 'parseHtml' must be a function/);
    refuses(() => mdToVnode(doc, { keyed: 0 }), /option 'keyed' must be a boolean, got 0/);
    refuses(() => mdToVnode(doc, { plugins: {} }), /option 'plugins' must be an array, got an object/);
  });

  it('refuses options that are not a plain object', function () {
    refuses(() => mdToVnode(doc, /** @type {any} */ (null)),
      /^md mdToVnode: options must be a plain object, got null$/);
    refuses(() => mdToVnode(doc, /** @type {any} */ ([])), /options must be a plain object, got an array/);
  });

  it('a compiled document checks the options it was compiled with when it projects', function () {
    refuses(() => compileMarkdown('# a', /** @type {any} */ ({ html: 'RAW' })).toVnode(),
      /option 'html' must be 'skip', 'text' or 'vnode'/);
  });
});

describe('toHtml — a closed option set', function () {
  it('renders valid options, explicit undefined members and a null wrap exactly as before', function () {
    assert.equal(toHtml(doc, { headingIds: true, slugPrefix: 'user-content-' }),
      '<h1 id="user-content-config">config</h1><p>text</p>');
    assert.equal(toHtml(doc, {
      headingIds: true, slugPrefix: 'user-content-', html: undefined, sanitizeUrl: undefined,
      plugins: undefined, headingAnchors: undefined, footnotesLabel: undefined, wrap: null,
    }), '<h1 id="user-content-config">config</h1><p>text</p>');
    assert.equal(toHtml(doc, { wrap: 'article class="md"' }),
      '<article class="md"><h1>config</h1><p>text</p></article>');
  });

  it('refuses misspelt members and wrong types', function () {
    refuses(() => toHtml(doc, { headingIds: true, slugprefix: 'user-content-' }),
      /^md toHtml: unknown option 'slugprefix' — did you mean 'slugPrefix'\?$/);
    refuses(() => toHtml(doc, { slugPrefix: 5 }), /^md toHtml: option 'slugPrefix' must be a string, got 5$/);
    refuses(() => toHtml(doc, { html: 'RAW' }),
      /^md toHtml: option 'html' must be 'escape', 'skip' or 'raw', got "RAW" — did you mean 'raw'\?$/);
    refuses(() => toHtml(doc, { html: 'vnode' }),
      /^md toHtml: option 'html' must be 'escape', 'skip' or 'raw', got "vnode"$/);
    refuses(() => toHtml(doc, { sanitizeUrl: null }), /option 'sanitizeUrl' must be a function, got null/);
    refuses(() => toHtml(doc, { wrap: 5 }), /option 'wrap' must be a string or null, got 5/);
    refuses(() => toHtml(doc, { parseHtml: () => [] }), /unknown option 'parseHtml'/);
    refuses(() => toHtml(doc, /** @type {any} */ (null)), /^md toHtml: options must be a plain object, got null$/);
  });
});

describe('createMdRenderer — a closed option set', function () {
  it('accepts every option it honours', function () {
    const { document, container } = createStubHost();
    const render = createMdRenderer({
      container, document, plugins: undefined, html: 'vnode', sanitizeUrl: (url) => url,
      headingIds: true, slugPrefix: 'user-content-', headingAnchors: false,
      onEvent: () => {}, onHydrateError: () => {},
    });
    render(doc);
    assert.equal(container.childNodes.length, 1);
  });

  it('refuses, when it is created, what it would have ignored', function () {
    const { document, container } = createStubHost();
    refuses(() => createMdRenderer({ container, document, slugprefix: 'user-content-' }),
      /^md createMdRenderer: unknown option 'slugprefix' — did you mean 'slugPrefix'\?$/);
    refuses(() => createMdRenderer({ container, document, slugPrefix: null }),
      /option 'slugPrefix' must be a string, got null/);
    refuses(() => createMdRenderer({ container, document, html: 'raw' }),
      /option 'html' must be 'skip', 'text' or 'vnode', got "raw"/);
    // the vnode-only members it does not forward are refused, not dropped
    refuses(() => createMdRenderer({ container, document, footnotesLabel: 'Notes' }),
      /unknown option 'footnotesLabel'/);
    refuses(() => createMdRenderer(/** @type {any} */ ({ document })),
      /^md createMdRenderer: option 'container' is required$/);
    refuses(() => createMdRenderer(/** @type {any} */ (null)),
      /^md createMdRenderer: options must be a plain object, got null$/);
  });
});
