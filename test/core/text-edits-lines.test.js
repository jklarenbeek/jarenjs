//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { hashContent } from '@jarenjs/core/string';
import { compileTextEdits, applyTextEdits, markdownSectionEnd } from '@jarenjs/core/text/edits';

const file = (path, text) => ({ path, text, hash: hashContent(text) });
/** Compile one or more edits against one file and apply them under the same options. */
function run(text, edits, options = {}) {
  const base = file('a.md', text);
  const plan = compileTextEdits([base], edits.map(edit => ({ path: base.path, baseHash: base.hash, ...edit })), options);
  assert.deepEqual(plan.withheld, []);
  return applyTextEdits([base], plan.hunks, options).files[0].text;
}

it('ends a replacement that would run into the next line with the file\'s line ending', () => {
  assert.equal(run('one\ntwo\nthree\n', [{ op: 'replace_section', anchor: 'two', replacement: 'TWO' }]), 'one\nTWO\nthree\n');
  assert.equal(run('# A\n\nold\n\n# B\n', [{ op: 'replace_section', anchor: '# A', replacement: '# A\n\nnew' }], { sectionEnd: markdownSectionEnd }),
    '# A\n\nnew\n# B\n');
});

it('ends an insertion that would run into the line after it', () => {
  assert.equal(run('one\ntwo\n', [{ op: 'insert_before', anchor: 'two', replacement: 'x' }]), 'one\nx\ntwo\n');
  assert.equal(run('one\ntwo\n', [{ op: 'insert_after', anchor: 'one', replacement: 'x' }]), 'one\nx\ntwo\n');
  assert.equal(run('one\ntwo\n', [{ op: 'insert_before', anchor: 'one', replacement: 'x' }]), 'x\none\ntwo\n');
});

it('ends an unterminated last line before an insertion after it', () => {
  assert.equal(run('a\nb', [{ op: 'insert_after', anchor: 'b', replacement: 'X\n' }]), 'a\nb\nX\n');
  assert.equal(run('a\nb', [{ op: 'insert_after', anchor: 'b', replacement: 'X' }]), 'a\nb\nX');
  assert.equal(run('b', [{ op: 'insert_after', anchor: 'b', replacement: 'X' }]), 'b\nX');
});

it('keeps a CRLF file CRLF', () => {
  assert.equal(run('one\r\ntwo\r\n', [{ op: 'replace_section', anchor: 'one', replacement: 'ONE' }]), 'ONE\r\ntwo\r\n');
  assert.equal(run('a\r\nb', [{ op: 'insert_after', anchor: 'b', replacement: 'X\r\n' }]), 'a\r\nb\r\nX\r\n');
  assert.equal(run('b', [{ op: 'insert_after', anchor: 'b', replacement: 'X\r\nY' }]), 'b\r\nX\r\nY');
});

it('ends each of two insertions at one boundary that would run together', () => {
  assert.equal(run('one\ntwo\n', [{ op: 'insert_after', anchor: 'one', replacement: 'b' }, { op: 'insert_after', anchor: 'one', replacement: 'a' }],
    { overlap: 'first-wins' }), 'one\na\nb\ntwo\n');
});

it('leaves every edit that joined no lines byte-identical', () => {
  // A last line keeps its missing final newline; a terminated replacement, a deletion
  // and a replacement of the last line are untouched.
  assert.equal(run('a\nb', [{ op: 'replace_section', anchor: 'b', replacement: 'B' }]), 'a\nB');
  assert.equal(run('a\nb\n', [{ op: 'replace_section', anchor: 'b', replacement: 'B' }]), 'a\nB');
  assert.equal(run('a\nb\nc', [{ op: 'delete_section', anchor: 'c' }]), 'a\nb\n');
  assert.equal(run('a\nb\nc\n', [{ op: 'replace_section', anchor: 'b', replacement: 'B\r\n' }]), 'a\nB\r\nc\n');
  assert.equal(run('a\n', [{ op: 'insert_after', anchor: 'a', replacement: 'tail' }]), 'a\ntail');
  assert.equal(run('a\nb\nc', [{ op: 'replace_section', anchor: 'b', replacement: 'B' }, { op: 'delete_section', anchor: 'c' }]), 'a\nB');
  assert.equal(applyTextEdits([], compileTextEdits([], [{ op: 'create_file', path: 'n', replacement: 'no newline' }]).hunks).files[0].text, 'no newline');
});
