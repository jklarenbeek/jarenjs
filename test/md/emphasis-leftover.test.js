//@ts-check
/**
 * When a delimiter run closes and leaves characters behind, what is left of
 * its opener stays an opener. The run had already been weighed as a closer
 * when the scan reached it, so the reference algorithm never asks it again;
 * this parser asked a second time with its reduced length, which let the rule
 * of three (a run that can both open and close must not pair when the two
 * lengths sum to a multiple of three) pass for `*` and `*****` once the
 * second run had been cut down to `***`. Both reference engines in the
 * benchmark read `*a*****b**` as below.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, toHtml } from '@jarenjs/md';

/** @param {string} source */
const html = (source) => toHtml(parseMarkdown(source, { gfm: false, frontmatter: false }));

describe('emphasis — the leftover of a spent opener is not a closer', function () {
  it('does not pair a one-character opener with a five-character run it had refused', () => {
    assert.equal(html('*a*****b**'), '<p>*a***<strong>b</strong></p>');
    assert.equal(html('*.*****.**'), '<p>*.***<strong>.</strong></p>');
    assert.equal(html('*(*****)**'), '<p>*(***<strong>)</strong></p>');
  });

  it('still pairs the runs the rule of three allows', () => {
    assert.equal(html('*a***b**'), '<p><em>a</em><strong>b</strong></p>');
    assert.equal(html('*.***.**'), '<p><em>.</em><strong>.</strong></p>');
    assert.equal(html('*foo**bar**baz*'), '<p><em>foo<strong>bar</strong>baz</em></p>');
    assert.equal(html('***strong emph***'), '<p><em><strong>strong emph</strong></em></p>');
  });
});
