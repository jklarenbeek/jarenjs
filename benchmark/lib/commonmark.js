//@ts-check
/**
 * @file The spec-corpus oracle: pulling examples out of a CommonMark- or
 * GFM-format specification, and comparing rendered HTML the way the
 * spec's own test runner does.
 *
 * Both the benchmark (`benchmark/markdown.js`, which publishes the
 * scorecard) and the test suite (`test/md/*.test.js`, which asserts it)
 * read the corpus through this module. Two copies of the comparison rule
 * would mean the published number and the asserted number could drift
 * apart while both looked green — and the comparison rule is exactly
 * where a conformance claim can be quietly bought.
 */

/**
 * Extract a spec's embedded examples: 32-backtick fences, `.` separating
 * the markdown from the expected HTML, `→` standing for a tab. The
 * opening fence may carry extension words (`example autolink`), which is
 * how the GFM spec tags its extension corpora.
 *
 * Each example also carries the `## Section` it appeared under, so a
 * caller can score one dialect extension without scoring the whole
 * document.
 *
 * @param {string} spec the raw spec text
 * @returns {{ number: number, section: string, markdown: string, html: string }[]}
 */
export function extractExamples(spec) {
  // the spec is a submodule checkout, so its line endings are whatever the
  // platform wrote; every pattern below is anchored on a bare newline
  spec = spec.replaceAll('\r\n', '\n');
  const headings = [];
  const heading = /^#{1,6} (.+)$/gm;
  let hm;
  while ((hm = heading.exec(spec)) !== null) headings.push({ at: hm.index, name: hm[1].trim() });

  const out = [];
  const re = /^`{32} example(?: [^\n]*)?\n([\s\S]*?)^\.\n([\s\S]*?)^`{32}$/gm;
  let match;
  let cursor = 0;
  let section = '';
  while ((match = re.exec(spec)) !== null) {
    while (cursor < headings.length && headings[cursor].at < match.index) {
      section = headings[cursor].name;
      cursor++;
    }
    out.push({
      number: out.length + 1,
      section,
      markdown: match[1].replace(/→/g, '\t'),
      html: match[2].replace(/→/g, '\t'),
    });
  }
  return out;
}

/**
 * Tags whose surrounding whitespace is formatting, never content: the
 * block-level elements CommonMark output is built from, plus `<br>`.
 */
const LAYOUT_TAG = 'p|div|ul|ol|li|blockquote|pre|h[1-6]|hr|table|thead|tbody|tr|td|th|section';
const RE_BEFORE_BLOCK = new RegExp(`\\s+(?=</?(?:${LAYOUT_TAG})[ >])`, 'g');
const RE_AFTER_BREAK = /(<br>)\s+/g;
const RE_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'=<>`/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const RE_ATTR = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * The spec's normalization, approximated: collapse whitespace runs, drop
 * whitespace between tags, normalize self-closing voids, and put every
 * start tag's attributes in one canonical serialization.
 *
 * The comparison is of RENDERED meaning, not of source formatting — so
 * whitespace that only lays the markup out is dropped on both sides. The
 * reference implementations print a newline after `<br />` and before a
 * nested `<ul>`; a producer that emits a vnode tree has no place to put
 * one, and treating that as a difference would score pretty-printing
 * rather than conformance. Attribute ORDER and the empty-value spelling
 * of a boolean attribute (`disabled` vs `disabled=""`) are the same kind
 * of difference: `<input type="checkbox" disabled>` and `<input
 * disabled="" type="checkbox">` are one element, and a scorecard that
 * called them two would be measuring a serializer.
 *
 * Every rule here applies to every engine, and each sweep that added one
 * checked that no engine's score moved for a reason other than the rule
 * itself (the attribute rule moved none of the five, on any of the 655
 * CommonMark examples).
 *
 * Whitespace next to an INLINE tag is left alone: the space in
 * `<p>a <em>b</em></p>` is content, and collapsing it would hide a real
 * difference.
 *
 * @param {string} html
 * @returns {string}
 */
export function normalizeHtml(html) {
  return html
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .replace(/ \/>/g, '>')
    .replace(RE_BEFORE_BLOCK, '')
    .replace(RE_AFTER_BREAK, '$1')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim()
    .replace(RE_TAG, normalizeTag);
}

/**
 * @param {string} whole @param {string} name @param {string} attrs @param {string} slash
 * @returns {string}
 */
function normalizeTag(whole, name, attrs, slash) {
  if (attrs === '') return '<' + name + slash + '>';
  /** @type {[string, string][]} */
  const pairs = [];
  RE_ATTR.lastIndex = 0;
  let m;
  while ((m = RE_ATTR.exec(attrs)) !== null) {
    pairs.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let out = '<' + name;
  for (let i = 0; i < pairs.length; i++) out += ' ' + pairs[i][0] + '="' + pairs[i][1] + '"';
  return out + slash + '>';
}
