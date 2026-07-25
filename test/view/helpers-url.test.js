//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { sanitizeHref, sanitizeUrl } from '@jarenjs/view/helpers';

const TAB = String.fromCharCode(0x09);
const LF = String.fromCharCode(0x0a);
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);

describe('view/helpers — sanitizeHref (allow-list)', () => {
  it('permits safe schemes', () => {
    assert.equal(sanitizeHref('https://ok.test'), 'https://ok.test');
    assert.equal(sanitizeHref('http://ok.test'), 'http://ok.test');
    assert.equal(sanitizeHref('mailto:a@b.c'), 'mailto:a@b.c');
    assert.equal(sanitizeHref('#anchor'), '#anchor');
    assert.equal(sanitizeHref('/path'), '/path');
    assert.equal(sanitizeHref('./rel'), './rel');
  });
  it('rejects dangerous or non-string input', () => {
    assert.equal(sanitizeHref('javascript:alert(1)'), null);
    assert.equal(sanitizeHref('data:text/html,x'), null);
    assert.equal(sanitizeHref(42), null);
    assert.equal(sanitizeHref(null), null);
  });
  it('trims before testing', () => {
    assert.equal(sanitizeHref('  https://ok.test  '), 'https://ok.test');
  });
  it('rejects a scheme-less relative reference, which is why authored content needs sanitizeUrl', () => {
    assert.equal(sanitizeHref('image.png'), null);
    assert.equal(sanitizeHref('docs/guide.md'), null);
  });
});

describe('view/helpers — sanitizeUrl (deny-list)', () => {
  it('rejects the schemes that execute script', () => {
    assert.equal(sanitizeUrl('javascript:alert(1)'), null);
    assert.equal(sanitizeUrl('vbscript:msgbox(1)'), null);
  });

  it('rejects schemes that stand in for a document', () => {
    assert.equal(sanitizeUrl('data:text/html,<script>1</script>'), null);
    assert.equal(sanitizeUrl('file:///etc/passwd'), null);
  });

  it('is case-insensitive on the scheme', () => {
    assert.equal(sanitizeUrl('JaVaScRiPt:alert(1)'), null);
    assert.equal(sanitizeUrl('JAVASCRIPT:alert(1)'), null);
    assert.equal(sanitizeUrl('DATA:text/html,x'), null);
  });

  it('strips the whitespace and controls a browser drops before parsing the scheme', () => {
    // Each of these navigates as `javascript:` once the browser has
    // removed the noise, so a plain prefix test would wave them through.
    assert.equal(sanitizeUrl('java' + TAB + 'script:alert(1)'), null);
    assert.equal(sanitizeUrl('java' + LF + 'script:alert(1)'), null);
    assert.equal(sanitizeUrl('java' + NUL + 'script:alert(1)'), null);
    assert.equal(sanitizeUrl('java' + DEL + 'script:alert(1)'), null);
    assert.equal(sanitizeUrl('java script:alert(1)'), null);
    assert.equal(sanitizeUrl('  javascript:alert(1)'), null);
  });

  it('passes scheme-less relative references, which prose depends on', () => {
    assert.equal(sanitizeUrl('image.png'), 'image.png');
    assert.equal(sanitizeUrl('docs/guide.md'), 'docs/guide.md');
    assert.equal(sanitizeUrl('u v'), 'u v');
    assert.equal(sanitizeUrl(''), '');
  });

  it('passes ordinary safe URLs untouched', () => {
    assert.equal(sanitizeUrl('https://ok.test/a?b=1#c'), 'https://ok.test/a?b=1#c');
    assert.equal(sanitizeUrl('mailto:a@b.c'), 'mailto:a@b.c');
    assert.equal(sanitizeUrl('#anchor'), '#anchor');
    assert.equal(sanitizeUrl('/path'), '/path');
    assert.equal(sanitizeUrl('../up'), '../up');
  });

  it('passes an unknown scheme, which is the point of a deny-list', () => {
    assert.equal(sanitizeUrl('myapp://open/thing'), 'myapp://open/thing');
    // A relative filename that merely contains a colon is not a scheme.
    assert.equal(sanitizeUrl('note:this'), 'note:this');
  });

  it('does not mistake a path segment for a scheme', () => {
    // A `/` before the colon makes the URL relative; a browser resolves
    // these against the base URL and never as a scheme, so must we.
    assert.equal(sanitizeUrl('foo/javascript:alert(1)'), 'foo/javascript:alert(1)');
    assert.equal(sanitizeUrl('./javascript:alert(1)'), './javascript:alert(1)');
    assert.equal(sanitizeUrl('/a/data:text/html,x'), '/a/data:text/html,x');
    // Percent-encoding is not decoded before the scheme is read, by us or
    // by a browser, so this stays a relative reference.
    assert.equal(sanitizeUrl('%6Aavascript:alert(1)'), '%6Aavascript:alert(1)');
  });

  it('permits raster data: images but not svg or html', () => {
    assert.equal(sanitizeUrl('data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
    assert.equal(sanitizeUrl('data:image/gif;base64,AAA'), 'data:image/gif;base64,AAA');
    assert.equal(sanitizeUrl('data:image/jpeg,AAA'), 'data:image/jpeg,AAA');
    assert.equal(sanitizeUrl('data:image/jpg,AAA'), 'data:image/jpg,AAA');
    assert.equal(sanitizeUrl('data:image/webp,AAA'), 'data:image/webp,AAA');
    // SVG can carry script; the contexts that make it inert are not ours
    // to assume, so it is rejected with the rest.
    assert.equal(sanitizeUrl('data:image/svg+xml;base64,AAA'), null);
    assert.equal(sanitizeUrl('data:image/svg+xml,<svg/>'), null);
  });

  it('trims, and rejects non-strings', () => {
    assert.equal(sanitizeUrl('  https://ok.test  '), 'https://ok.test');
    assert.equal(sanitizeUrl(42), null);
    assert.equal(sanitizeUrl(null), null);
    assert.equal(sanitizeUrl(undefined), null);
  });
});
