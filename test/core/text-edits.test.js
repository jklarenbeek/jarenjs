//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { hashContent } from '@jarenjs/core/string';
import { compileTextEdits, applyTextEdits } from '@jarenjs/core/text/edits';

const file = (path, text) => ({ path, text, hash: hashContent(text) });
const edit = (base, op, rest = {}) => ({ op, path: base.path, baseHash: base.hash, ...rest });

it('compiles explicit sections and insertions against immutable line coordinates', () => {
  const base = file('docs/a.txt', 'head\r\none\r\ntwo\r\ntail');
  const files = [base], before = structuredClone(files);
  const plan = compileTextEdits(files, [edit(base, 'replace_section', { anchor: 'one', to: 'two', replacement: 'new\r\n' })]);
  assert.equal(plan.valid, true); assert.deepEqual([plan.hunks[0].start, plan.hunks[0].end], [1, 3]);
  const result = applyTextEdits(files, plan.hunks);
  assert.equal(result.files[0].text, 'head\r\nnew\r\ntail');
  assert.match(result.diff, /@@ -1,4 \+1,3 @@/); assert.match(result.diff, /No newline at end of file/);
  assert.deepEqual(files, before);
  assert.equal(compileTextEdits(files, [edit(base, 'replace_section', { anchor: 'one\r\ntwo', to: 'one', replacement: '' })]).withheld[0].reason, 'invalid-edit');
  assert.throws(() => applyTextEdits(result.files, plan.hunks), /stale-base/);
  for (const [op, expected] of [['insert_before', 'x\nhead\r\none\r\ntwo\r\ntail'], ['insert_after', 'head\r\nx\none\r\ntwo\r\ntail']]) {
    const inserted = compileTextEdits(files, [edit(base, op, { anchor: 'head', replacement: 'x\n' })]);
    assert.equal(applyTextEdits(files, inserted.hunks).files[0].text, expected);
  }
  const deleted = compileTextEdits(files, [edit(base, 'delete_section', { anchor: 'tail' })]);
  assert.equal(applyTextEdits(files, deleted.hunks).files[0].text, 'head\r\none\r\ntwo\r\n');
});

it('withholds ambiguous, stale, unsafe, missing and overlapping edits without guesses', () => {
  const base = file('a.txt', 'one\none\nlast\n');
  const cases = [
    [edit(base, 'replace_section', { anchor: 'one', replacement: '' }), 'anchor-ambiguous'],
    [edit(base, 'replace_section', { anchor: 'absent', replacement: '' }), 'anchor-not-found'],
    [edit(base, 'replace_section', { anchor: 'ast', replacement: '' }), 'anchor-not-line-boundary'],
    [edit(base, 'replace_section', { anchor: 'last', replacement: '', baseHash: 'old' }), 'stale-base'],
    [edit(base, 'replace_section', { anchor: 'last', replacement: '', path: 'missing.txt' }), 'missing-target'],
  ];
  for (const [input, reason] of cases) assert.equal(compileTextEdits([base], [input]).withheld[0].reason, reason);
  for (const path of ['../a', '/a', 'x/../a', 'x\\a', 'C:/a', 'a\0', 'a\nb', 'x//a', './a'])
    assert.equal(compileTextEdits([], [{ op: 'create_file', path, replacement: '' }]).withheld[0].reason, 'path-unsafe');
  const overlap = compileTextEdits([base], [edit(base, 'insert_before', { anchor: 'last', replacement: 'a' }),
    edit(base, 'insert_before', { anchor: 'last', replacement: 'b' })]);
  assert.equal(overlap.hunks.length, 0); assert.ok(overlap.withheld.every(row => row.reason === 'overlap'));
});

it('keeps create/link groups atomic and propagates missing, failed and cyclic dependencies', () => {
  const base = file('index.txt', 'index\n');
  const inputs = [{ op: 'create_file', path: 'new.txt', replacement: 'new\n', group: 'page' },
    edit(base, 'insert_after', { anchor: 'index', replacement: 'new.txt\n', group: 'page' })];
  const plan = compileTextEdits([base], inputs);
  assert.equal(plan.valid, true); assert.deepEqual(plan.groups, [['new.txt', 'index.txt']]);
  assert.equal(applyTextEdits([base], plan.hunks).files.length, 2);
  assert.throws(() => applyTextEdits([base], plan.hunks.slice(0, 1)), /group-incomplete/);
  inputs[1].anchor = 'missing';
  assert.equal(compileTextEdits([base], inputs).hunks.length, 0);
  for (const requirements of [['missing', undefined], ['two', 'one']]) {
    const broken = compileTextEdits([], [{ op: 'create_file', path: 'one', replacement: '', group: 'one', requires: [requirements[0]] },
      { op: 'create_file', path: 'two', replacement: '', group: 'two', requires: requirements[1] ? [requirements[1]] : ['one'] }]);
    assert.equal(broken.hunks.length, 0); assert.equal(broken.valid, false);
  }
});

it('revalidates supplied hunks, full base text, hashes and finite budgets', () => {
  const base = file('a', 'a\nb\nc\n');
  const plan = compileTextEdits([base], [edit(base, 'replace_section', { anchor: 'b', replacement: 'B\n' })]);
  for (const patch of [{ start: -1 }, { end: 99 }, { baseText: 'wrong' }, { path: '../a' }, { replacement: null }])
    assert.throws(() => applyTextEdits([base], [{ ...plan.hunks[0], ...patch }]));
  assert.throws(() => applyTextEdits([base], [plan.hunks[0], { ...plan.hunks[0], source: 2, group: ':2', members: [2] }]), /overlap/);
  assert.throws(() => compileTextEdits([{ ...base, hash: 'wrong' }], []));
  assert.throws(() => compileTextEdits([base, base], []));
  assert.throws(() => compileTextEdits([base], [], { maxBytes: 1 }));
  assert.throws(() => compileTextEdits([], [{ op: 'create_file', path: 'a', replacement: 'long' }], { maxBytes: 1 }));
  assert.throws(() => applyTextEdits([base], plan.hunks, { maxBytes: 1 }));
  assert.deepEqual(applyTextEdits([base], []).files, [base]);
  const custom = { hash: text => 'v1:' + text };
  const customBase = { path: 'a', text: 'a', hash: 'v1:a' };
  const customPlan = compileTextEdits([customBase], [edit(customBase, 'delete_section', { anchor: 'a' })], custom);
  assert.equal(applyTextEdits([customBase], customPlan.hunks, custom).files[0].hash, 'v1:');
});

it('bounds proposal metadata/dependencies and resolves deep group chains without recursion', () => {
  const chain = Array.from({ length: 1000 }, (_, i) => ({ op: 'create_file', path: 'file-' + i,
    replacement: '', group: 'group-' + i, requires: i ? ['group-' + (i - 1)] : [] }));
  const result = compileTextEdits([], chain, { maxFiles: 1000, maxEdits: 1000 });
  assert.equal(result.valid, true); assert.equal(result.hunks.length, 1000);
  assert.throws(() => compileTextEdits([], [{ op: 'create_file', path: 'a', replacement: '', anchor: 'x'.repeat(100) }], { maxBytes: 10 }), /metadata/);
  assert.throws(() => compileTextEdits([], [{ op: 'create_file', path: 'a', replacement: '', requires: ['x', 'y'] },
    { op: 'create_file', path: 'b', replacement: '', requires: ['x'] }], { maxEdits: 2 }), /dependency/);
});
