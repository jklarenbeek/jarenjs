//@ts-check
/**
 * @file mdx = markdown × data: the pure `(doc, data) → doc` pass. The
 * expression compiler is INJECTED (here the real compileJsonQuery, as
 * the website injects it), the template vocabulary is `{$…}` inline
 * interpolation plus `{#if}` / `{#each}` section paragraphs, and a bad
 * template renders its diagnosis instead of throwing.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { parseMarkdown, toMarkdown } from '@jarenjs/md';
import { createMdx } from '@jarenjs/md/mdx';
import { compileJsonQuery } from '@jarenjs/json';

const mdx = createMdx({ compileQuery: compileJsonQuery });
const render = (source, data) => toMarkdown(mdx.transform(parseMarkdown(source), data));

describe('@jarenjs/md/mdx — the markdown × data pass', () => {
  it('requires an injected expression compiler', () => {
    assert.throws(() => createMdx({}), /compileQuery/);
  });

  it('interpolates {$…} expressions in text, leaving plain braces alone', () => {
    const out = render('# Hi {$.name}\n\nBraces like {these} stay.\n', { name: 'Ada' });
    assert.match(out, /# Hi Ada/);
    assert.match(out, /Braces like \{these\} stay\./);
  });

  it('stringifies values honestly: numbers verbatim, null/undefined empty, objects as JSON', () => {
    const out = render('n {$.n} · missing {$.nope} · o {$.o}\n', { n: 4.5, o: { a: 1 } });
    assert.match(out, /n 4\.5/);
    assert.match(out, /missing {2}·/, 'an absent value interpolates to nothing');
    assert.match(out, /o \{"a":1\}/);
  });

  it('never interpolates code spans, code blocks or raw HTML', () => {
    const out = render('`{$.x}`\n\n```\n{$.x}\n```\n', { x: 'NO' });
    assert.doesNotMatch(out, /NO/);
    assert.match(out, /\{\$\.x\}/);
  });

  it('{#if} keeps its section only when the expression is truthy', () => {
    const source = 'Always.\n\n{#if $.paid}\n\nPaid — thank you!\n\n{/if}\n';
    assert.match(render(source, { paid: true }), /Paid — thank you!/);
    assert.doesNotMatch(render(source, { paid: false }), /Paid/);
    assert.doesNotMatch(render(source, {}), /Paid/, 'absent is false');
    assert.doesNotMatch(render('{#if $.items}\n\nyes\n\n{/if}\n', { items: [] }), /yes/, 'an empty list is false');
  });

  it('{#each} repeats its section once per item, binding the external', () => {
    const out = render('{#each $.lines as line}\n\n- {$line.d} at {$line.n}\n\n{/each}\n',
      { lines: [{ d: 'first', n: 1 }, { d: 'second', n: 2 }] });
    assert.match(out, /first at 1/);
    assert.match(out, /second at 2/);
    // a non-list value repeats once; an absent one not at all
    assert.match(render('{#each $.one as x}\n\n{$x}\n\n{/each}\n', { one: 'solo' }), /solo/);
    assert.doesNotMatch(render('{#each $.gone as x}\n\nnever\n\n{/each}\n', {}), /never/);
  });

  it('sections nest: an {#if} inside an {#each} sees the loop binding', () => {
    const source = '{#each $.users as u}\n\n{#if $u.admin}\n\n{$u.name} is an admin\n\n{/if}\n\n{/each}\n';
    const out = render(source, { users: [{ name: 'Ada', admin: true }, { name: 'Alan', admin: false }] });
    assert.match(out, /Ada is an admin/);
    assert.doesNotMatch(out, /Alan/);
  });

  it('the frontmatter binds as externals, exactly as it does for JSLT', () => {
    const out = render('---\ntitle: The digest\n---\n# {$title}\n', {});
    assert.match(out, /# The digest/);
  });

  it('a bad expression, a stray close and an unclosed opener all render their diagnosis', () => {
    assert.match(render('{$.a[[[}\n', {}), /⟨mdx:/, 'a bad inline expression reports in place');
    assert.match(render('{/if}\n', {}), /stray \{\/if\}/);
    assert.match(render('{#if $.x}\n\nnever closed\n', { x: true }), /unclosed \{\\?#if\}/); // the printer may escape the #
    assert.match(render('{#each $.a[[ as x}\n\nbody\n\n{/each}\n', {}), /⟨mdx:/, 'a bad each expression reports');
  });

  it('is pure: the input document is never mutated, and the pass is repeatable', () => {
    const doc = parseMarkdown('# {$.t}\n');
    const before = JSON.stringify(doc);
    const one = mdx.transform(doc, { t: 'X' });
    const two = mdx.transform(doc, { t: 'Y' });
    assert.strictEqual(JSON.stringify(doc), before, 'the parsed doc is untouched');
    assert.match(toMarkdown(one), /# X/);
    assert.match(toMarkdown(two), /# Y/, 'the same doc renders against new data');
  });

  it('directives work inside containers (a blockquote section)', () => {
    const out = render('> {#if $.warn}\n>\n> Careful: {$.warn}\n>\n> {/if}\n', { warn: 'hot' });
    assert.match(out, /Careful: hot/);
    const off = render('> {#if $.warn}\n>\n> Careful: {$.warn}\n>\n> {/if}\n', {});
    assert.doesNotMatch(off, /Careful/);
  });
});
