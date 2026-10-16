//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hashContent } from '@jarenjs/core/string';
import { CodedError } from '@jarenjs/core/errors';
import * as textEdits from '@jarenjs/core/text/edits';

// Read through the namespace so a missing export fails its own test, not the file.
const { compileTextEdits, applyTextEdits } = textEdits;
const edits = /** @type {any} */ (textEdits);

const file = (path, text) => ({ path, text, hash: hashContent(text) });
const edit = (base, op, rest = {}) => ({ op, path: base.path, baseHash: base.hash, ...rest });
const span = plan => plan.hunks.map(hunk => [hunk.start, hunk.end]);
const applied = (files, plan, options) => applyTextEdits(files, plan.hunks, options).files[0].text;

const page = file('guide.md', [
  '# Tabular answers\n', '\n', 'Answer one question about one table.\n', '\n',
  '## Reading the table\n', '\n', '- The first line is the header.\n', '\n',
  '## Answer format\n', '\n', '- A count is a bare integer.\n', '- A decimal uses a period separator.\n', '\n',
  '```sh\n', '# not a heading\n', 'wc -l table.csv\n', '```\n', '\n',
  '### Rounding\n', '\n', '- Round half to even.\n', '\n',
  '## Sources\n', '\n', '- inputs/ only.\n'].join(''));

it('widens an anchor found inside a line to the lines it touches, only when asked', () => {
  const insert = edit(page, 'insert_after', { anchor: 'period separator', replacement: '- Never group thousands.\n' });
  assert.deepEqual(compileTextEdits([page], [insert]).withheld, [{ edit: 0, reason: 'anchor-not-line-boundary' }]);
  const plan = compileTextEdits([page], [insert], { anchor: 'widen' });
  assert.equal(plan.valid, true); assert.deepEqual(span(plan), [[12, 12]]);
  assert.match(applied([page], plan), /- A decimal uses a period separator\.\n- Never group thousands\.\n\n```sh/);
  // An anchor that starts and ends inside lines owns every line it touches.
  const across = compileTextEdits([page], [edit(page, 'replace_section', { anchor: 'bare integer.\n- A decimal', replacement: 'X\n' })], { anchor: 'widen' });
  assert.deepEqual(span(across), [[10, 12]]);
  // `to` widens the same way; a whole-line anchor answers what the line mode answers.
  const ranged = compileTextEdits([page], [edit(page, 'delete_section', { anchor: 'count is', to: 'period' })], { anchor: 'widen' });
  assert.deepEqual(span(ranged), [[10, 12]]);
  const whole = edit(page, 'delete_section', { anchor: '- The first line is the header.' });
  assert.deepEqual(span(compileTextEdits([page], [whole], { anchor: 'widen' })), span(compileTextEdits([page], [whole])));
  // Widening never guesses: an anchor found twice, or not at all, is still withheld.
  for (const [anchor, reason] of [['table', 'anchor-ambiguous'], ['absent text', 'anchor-not-found'], ['', 'invalid-edit']])
    assert.deepEqual(compileTextEdits([page], [edit(page, 'insert_before', { anchor, replacement: 'x\n' })], { anchor: 'widen' }).withheld,
      [{ edit: 0, reason }]);
});

it('extends a heading section to the next heading of its level or higher through a section hook', () => {
  const end = edits.markdownSectionEnd;
  assert.equal(typeof end, 'function');
  const lines = page.text.match(/[^\n]*\n|[^\n]+$/g);
  // A fenced `# comment` is code, not a heading: the section runs past it.
  assert.equal(end(lines, 8, 9), 22);
  assert.equal(end(lines, 18, 19), 22);
  assert.equal(end(lines, 0, 1), 25);
  assert.equal(end(lines, 22, 23), 25);
  // A line inside a fence, or any non-heading line, owns only the anchor's lines.
  assert.equal(end(lines, 14, 15), 15);
  assert.equal(end(lines, 10, 12), 12);
  // ATX only: 0-3 spaces of indentation, 1-6 marks, then a space, a tab or the line's end.
  const rule = text => end(text.match(/[^\n]*\n|[^\n]+$/g), 0, 1);
  assert.equal(rule('## a\nx\n   ## b\ny\n'), 2);
  assert.equal(rule('## a\nx\n##\ny\n'), 2);
  assert.equal(rule('## a\r\nx\r\n#\tb\r\n'), 2);
  assert.equal(rule('## a\nx\n    ## code\n#hash\n####### seven\n### deeper\n'), 6);
  assert.equal(rule('#hash\nx\n# b\n'), 1);
  assert.equal(rule('## a\n~~~\n# in tilde fence\n```\n~~~~\n# b\n'), 5);
  assert.equal(rule('## a\n```js `x`\n# not a fence opener above, so a heading\n'), 2);
  assert.equal(rule('## a\n```\n# open fence to the end\n'), 3);

  const section = edit(page, 'replace_section', { anchor: '## Answer format', replacement: '## Answer format\n\n- Answers are bare values.\n\n' });
  assert.deepEqual(span(compileTextEdits([page], [section])), [[8, 9]]);
  const plan = compileTextEdits([page], [section], { sectionEnd: end });
  assert.deepEqual(span(plan), [[8, 22]]);
  assert.equal(applied([page], plan).slice(page.text.indexOf('## Answer format')),
    '## Answer format\n\n- Answers are bare values.\n\n## Sources\n\n- inputs/ only.\n');
  const removed = compileTextEdits([page], [edit(page, 'delete_section', { anchor: '### Rounding' })], { sectionEnd: end });
  assert.equal(applied([page], removed).includes('Round half'), false);
  assert.match(applied([page], removed), /```\n\n## Sources/);
  // An explicit `to` and the insertions never consult the hook.
  const calls = [];
  const spy = (...args) => { calls.push(args.slice(1)); return end(...args); };
  compileTextEdits([page], [edit(page, 'replace_section', { anchor: '## Answer format', to: '- A count is a bare integer.', replacement: '' }),
    edit(page, 'insert_after', { anchor: '## Sources', replacement: 'x\n' })], { sectionEnd: spy });
  assert.deepEqual(calls, []);
  compileTextEdits([page], [section], { sectionEnd: spy });
  assert.deepEqual(calls, [[8, 9]]);
});

it('refuses a section hook that answers outside the file or before the anchor ends, coded', () => {
  const section = edit(page, 'delete_section', { anchor: '## Answer format' });
  for (const answer of [8, 26, 9.5, '22', undefined])
    assert.throws(() => compileTextEdits([page], [section], { sectionEnd: () => answer }),
      error => error instanceof CodedError && error.code === 'JE0017' && error.docPath === '/edits/0');
  assert.throws(() => compileTextEdits([page], [section], /** @type {any} */ ({ sectionEnd: 'markdown' })),
    error => error.code === 'JE0001' && error.docPath === '/configuration/sectionEnd');
});

it('keeps the first hunk in canonical order and withholds the later one, naming the survivor', () => {
  const longer = edit(page, 'replace_section', { anchor: '## Answer format', group: 'format-a', replacement: '## Answer format\n\n- A weight converts at 2.20462 lb per kg.\n\n' });
  const shorter = edit(page, 'replace_section', { anchor: '## Answer format', group: 'format-b', replacement: '## Answer format\n\n- Report pounds to one decimal.\n\n' });
  const options = { sectionEnd: edits.markdownSectionEnd, overlap: 'first-wins' };
  // The default withholds both, with rows that name only the edit and the reason.
  assert.deepEqual(compileTextEdits([page], [longer, shorter], { sectionEnd: edits.markdownSectionEnd }).withheld,
    [{ edit: 0, reason: 'overlap' }, { edit: 1, reason: 'overlap' }]);
  for (const order of [[longer, shorter], [shorter, longer]]) {
    const plan = compileTextEdits([page], order, /** @type {any} */ (options));
    const survivor = order.indexOf(longer), loser = order.indexOf(shorter);
    assert.equal(plan.valid, false);
    assert.deepEqual(plan.hunks.map(hunk => hunk.replacement), [longer.replacement]);
    assert.deepEqual(plan.withheld, [{ edit: loser, reason: 'overlap', conflict: survivor }]);
  }
});

it('lets a later hunk lose only to a surviving earlier hunk', () => {
  const text = file('chain.txt', 'a\nb\nc\nd\ne\n');
  const first = edit(text, 'replace_section', { anchor: 'a', to: 'b', replacement: 'A\n' });
  const middle = edit(text, 'replace_section', { anchor: 'b', to: 'c', replacement: 'B\n' });
  const last = edit(text, 'replace_section', { anchor: 'c', to: 'd', replacement: 'C\n' });
  const plan = compileTextEdits([text], [last, middle, first], /** @type {any} */ ({ overlap: 'first-wins' }));
  assert.deepEqual(plan.withheld, [{ edit: 1, reason: 'overlap', conflict: 2 }]);
  assert.equal(applied([text], plan, /** @type {any} */ ({ overlap: 'first-wins' })), 'A\nC\ne\n');
  // A hunk already withheld for its own reason never wins.
  const stale = { ...first, baseHash: 'old' };
  assert.deepEqual(compileTextEdits([text], [stale, middle], /** @type {any} */ ({ overlap: 'first-wins' })).withheld,
    [{ edit: 0, reason: 'stale-base' }]);
  // Nor does one its group withholds: edit 1 falls with its stale partner, so edit 2 stands.
  const grouped = compileTextEdits([text], [{ ...stale, group: 'pair' }, { ...first, group: 'pair' }, middle],
    /** @type {any} */ ({ overlap: 'first-wins' }));
  assert.deepEqual(grouped.withheld, [{ edit: 0, reason: 'stale-base' }, { edit: 1, reason: 'group-incomplete' }]);
  assert.deepEqual(grouped.hunks.map(hunk => hunk.source), [2]);
});

it('keeps groups whole under first-wins, so a conflict always names an edit that applies', () => {
  const text = file('pair.txt', 'a\nb\nc\nd\n');
  const options = /** @type {any} */ ({ overlap: 'first-wins' });
  const replace = (anchor, replacement, rest = {}) => edit(text, 'replace_section', { anchor, replacement, ...rest });
  // Two proposals cross in two places: the group whose first hunk sorts first keeps both of its hunks.
  const crossing = compileTextEdits([text], [replace('a', 'A1\n', { group: 'p' }), replace('a', 'B\n'),
    replace('c', 'Z\n', { group: 'p' }), replace('c', 'C\n')], options);
  assert.deepEqual(crossing.withheld, [{ edit: 1, reason: 'overlap', conflict: 0 }, { edit: 3, reason: 'overlap', conflict: 2 }]);
  assert.equal(applied([text], crossing, options), 'A1\nb\nZ\nd\n');
  // A group competes together with the groups it requires.
  const required = compileTextEdits([text], [replace('a', 'G\n', { group: 'g', requires: ['h'] }),
    replace('b', 'H\n', { group: 'h' }), replace('b', 'A\n')], options);
  assert.deepEqual(required.withheld, [{ edit: 2, reason: 'overlap', conflict: 1 }]);
  assert.equal(applied([text], required, options), 'G\nH\nc\nd\n');
  // A group that contradicts itself is withheld without a survivor, and frees the lines.
  const contradiction = compileTextEdits([text], [replace('c', 'X\n', { group: 's' }), replace('c', 'Y\n', { group: 's' }),
    replace('c', 'Z\n')], options);
  assert.deepEqual(contradiction.withheld, [{ edit: 0, reason: 'overlap' }, { edit: 1, reason: 'overlap' }]);
  assert.equal(applied([text], contradiction, options), 'a\nb\nZ\nd\n');
  // So does one that crosses a group it requires; the required group still applies alone.
  const against = compileTextEdits([text], [replace('a', 'G\n', { group: 'g', requires: ['h'] }),
    replace('a', 'H\n', { group: 'h' })], options);
  assert.deepEqual(against.withheld, [{ edit: 0, reason: 'overlap' }]);
  assert.equal(applied([text], against, options), 'H\nb\nc\nd\n');
});

it('keeps insertions at one boundary, and at a replaced section edge, in canonical order', () => {
  const text = file('list.txt', 'one\ntwo\nthree\n');
  const options = /** @type {any} */ ({ overlap: 'first-wins' });
  const inputs = [edit(text, 'insert_after', { anchor: 'one', replacement: 'b\n' }),
    edit(text, 'insert_before', { anchor: 'two', replacement: 'a\n' }),
    edit(text, 'insert_after', { anchor: 'one', replacement: 'c\n' })];
  for (const order of [inputs, [...inputs].reverse(), [inputs[2], inputs[0], inputs[1]]]) {
    const plan = compileTextEdits([text], order, options);
    assert.equal(plan.valid, true);
    assert.equal(applied([text], plan, options), 'one\na\nb\nc\ntwo\nthree\n');
    assert.equal(applyTextEdits([text], [...plan.hunks].reverse(), options).files[0].text, 'one\na\nb\nc\ntwo\nthree\n');
    assert.throws(() => applyTextEdits([text], plan.hunks), error => error.code === 'JE0016' && /overlap/.test(error.message));
  }
  const around = [edit(text, 'insert_after', { anchor: 'two', replacement: 'after\n' }),
    edit(text, 'replace_section', { anchor: 'two', replacement: 'TWO\n' }),
    edit(text, 'insert_before', { anchor: 'two', replacement: 'before\n' })];
  const plan = compileTextEdits([text], around, options);
  assert.equal(plan.valid, true);
  assert.equal(applied([text], plan, options), 'one\nbefore\nTWO\nafter\nthree\n');
  // An insertion strictly inside a replaced section still conflicts.
  const inside = compileTextEdits([text], [edit(text, 'replace_section', { anchor: 'one', to: 'three', replacement: 'all\n' }),
    edit(text, 'insert_after', { anchor: 'two', replacement: 'x\n' })], options);
  assert.deepEqual(inside.withheld, [{ edit: 1, reason: 'overlap', conflict: 0 }]);
  assert.throws(() => applyTextEdits([text], [...inside.hunks, { ...compileTextEdits([text], [edit(text, 'insert_after', { anchor: 'two', replacement: 'x\n' })]).hunks[0], source: 1, group: ':1', members: [1] }], options),
    error => error.code === 'JE0016' && error.docPath === '/hunks/1');
});

it('withholds the later of two creates of one path under first-wins', () => {
  const creates = [{ op: 'create_file', path: 'new.md', replacement: 'zeta\n' }, { op: 'create_file', path: 'new.md', replacement: 'alpha\n' }];
  const plan = compileTextEdits([], creates, /** @type {any} */ ({ overlap: 'first-wins' }));
  assert.deepEqual(plan.withheld, [{ edit: 0, reason: 'overlap', conflict: 1 }]);
  assert.equal(applyTextEdits([], plan.hunks, /** @type {any} */ ({ overlap: 'first-wins' })).files[0].text, 'alpha\n');
});

it('applies a model-authored patch: a mid-line anchor, a heading section and two analysts on one section', () => {
  // Two analysts each rewrote one section and appended a rule after the same line, with an
  // injected synchronous SHA-256 as the file identity.
  const sha256 = text => createHash('sha256').update(text).digest('hex');
  const options = /** @type {any} */ ({ hash: sha256, anchor: 'widen', sectionEnd: edits.markdownSectionEnd, overlap: 'first-wins' });
  const guide = { path: 'guide.md', text: page.text, hash: sha256(page.text) };
  const patch = [
    { op: 'replace_section', path: 'guide.md', baseHash: guide.hash, anchor: 'Answer format', group: 'format-b',
      replacement: '## Answer format\n\n- Report pounds to one decimal.\n\n' },
    { op: 'insert_after', path: 'guide.md', baseHash: guide.hash, anchor: 'first line is the header', group: 'header-a',
      replacement: '- A Markdown table\'s second row is its alignment rule.\n' },
    { op: 'replace_section', path: 'guide.md', baseHash: guide.hash, anchor: 'Answer format', group: 'format-a',
      replacement: '## Answer format\n\n- A weight converts at 2.20462 lb per kg.\n\n' },
    { op: 'insert_after', path: 'guide.md', baseHash: guide.hash, anchor: 'first line is the header', group: 'header-b',
      replacement: '- Match a column by its header name.\n' },
  ];
  const plan = compileTextEdits([guide], patch, options);
  assert.deepEqual(plan.withheld, [{ edit: 0, reason: 'overlap', conflict: 2 }]);
  const result = applyTextEdits([guide], plan.hunks, options);
  assert.equal(result.files[0].hash, sha256(result.files[0].text));
  assert.equal(result.files[0].text.slice(result.files[0].text.indexOf('## Reading')),
    '## Reading the table\n\n- The first line is the header.\n- A Markdown table\'s second row is its alignment rule.\n'
    + '- Match a column by its header name.\n\n## Answer format\n\n- A weight converts at 2.20462 lb per kg.\n\n## Sources\n\n- inputs/ only.\n');
  // No reordering of the patch changes the text or which rewrite loses.
  const rotations = patch.map((_, at) => [...patch.slice(at), ...patch.slice(0, at)]).concat([[...patch].reverse()]);
  for (const order of rotations) {
    const again = compileTextEdits([guide], order, options);
    assert.deepEqual(again.withheld.map(row => order[row.edit].group), ['format-b']);
    assert.equal(applyTextEdits([guide], again.hunks, options).files[0].text, result.files[0].text);
  }
});

it('refuses an unknown policy value instead of ignoring it', () => {
  for (const [key, value] of [['anchor', 'widen '], ['anchor', true], ['overlap', 'last-wins']])
    assert.throws(() => compileTextEdits([], [], /** @type {any} */ ({ [key]: value })),
      error => error instanceof CodedError && error.code === 'JE0001' && error.docPath === '/configuration/' + key);
  assert.equal(compileTextEdits([], [], /** @type {any} */ ({ anchor: undefined, overlap: undefined, sectionEnd: undefined })).valid, true);
});

it('throws a registered TextEditError naming the code, the place and the reason', () => {
  const codes = edits.TEXT_EDIT_CODES;
  assert.equal(Object.isFrozen(codes), true);
  const base = file('a', 'a\nb\nc\n');
  const plan = compileTextEdits([base], [edit(base, 'replace_section', { anchor: 'b', replacement: 'B\n' })]);
  const hunk = plan.hunks[0];
  const cases = [
    [() => compileTextEdits([], [], { maxBytes: 0 }), 'JE0001', '/configuration/maxBytes', /finite file, edit and byte limits/],
    [() => compileTextEdits([], [], /** @type {any} */ ({ hash: 'sha' })), 'JE0001', '/configuration/hash', /synchronous hash/],
    [() => compileTextEdits(/** @type {any} */ ('files'), []), 'JE0002', '/files', /array/],
    [() => compileTextEdits([], /** @type {any} */ ({})), 'JE0002', '/edits', /array/],
    [() => applyTextEdits([], /** @type {any} */ (null)), 'JE0002', '/hunks', /array/],
    [() => compileTextEdits([base, base], []), 'JE0003', '/files/1', /unique safe paths/],
    [() => compileTextEdits([{ ...base, hash: 'wrong' }], []), 'JE0004', '/files/0/hash', /does not match its content/],
    [() => compileTextEdits([file('x', ''), file('y', '')], [], { maxFiles: 1 }), 'JE0005', '/files', /file limit exceeded/],
    [() => compileTextEdits([], [{}, {}], { maxEdits: 1 }), 'JE0006', '/edits', /edit limit exceeded/],
    [() => applyTextEdits([base], [hunk, hunk], { maxEdits: 1 }), 'JE0006', '/hunks', /edit limit exceeded/],
    [() => compileTextEdits([], [{ op: 'create_file', path: 'a', replacement: '', requires: ['x', 'y'] },
      { op: 'create_file', path: 'b', replacement: '', requires: ['x'] }], { maxEdits: 2 }), 'JE0007', '/edits/1/requires', /dependency limit/],
    [() => compileTextEdits([base], [], { maxBytes: 3 }), 'JE0008', '/files/0/text', /text byte limit/],
    [() => compileTextEdits([], [{ op: 'create_file', path: 'a', replacement: '', anchor: 'x'.repeat(100) }], { maxBytes: 10 }), 'JE0009', '/edits/0', /metadata byte limit/],
    [() => compileTextEdits([], [{ op: 'create_file', path: 'a', replacement: 'long' }], { maxBytes: 1 }), 'JE0010', '/edits/0/replacement', /replacement byte limit/],
    [() => applyTextEdits([base], [{ ...hunk, replacement: 'x'.repeat(10) }], { maxBytes: 9 }), 'JE0010', '/hunks/0/replacement', /replacement byte limit/],
    [() => applyTextEdits([base], [{ ...hunk, replacement: 'x'.repeat(6) }], { maxBytes: 9 }), 'JE0011', '/result/0/text', /text byte limit/],
    [() => applyTextEdits([base], [{ ...hunk, path: '../a' }]), 'JE0012', '/hunks/0', /invalid text hunk/],
    [() => applyTextEdits([file('a', 'moved\n')], [hunk]), 'JE0013', '/hunks/0', /stale-base/],
    [() => applyTextEdits([base], [{ ...hunk, end: 99 }]), 'JE0014', '/hunks/0', /invalid text interval/],
    [() => applyTextEdits([base], [{ ...hunk, members: [0, 5] }]), 'JE0015', '/hunks/0', /group-incomplete/],
    [() => applyTextEdits([base], [hunk, { ...hunk, source: 2, group: ':2', members: [2] }]), 'JE0016', '/hunks/1', /overlap.*hunk 0/],
  ];
  const seen = new Set();
  for (const [run, code, docPath, words] of cases) {
    assert.throws(run, error => {
      assert.ok(error instanceof CodedError, String(error));
      assert.equal(error.name, 'TextEditError'); assert.equal(error.code, code); assert.equal(error.docPath, docPath);
      assert.match(error.message, words); assert.ok(error.message.startsWith(code + ': '));
      return true;
    }, code);
    seen.add(code);
  }
  seen.add('JE0017');
  assert.deepEqual([...seen].sort(), Object.keys(codes ?? {}).sort());
});

it('runs the README example for model-authored patches and answers what its comments say', async () => {
  const readme = readFileSync(new URL('../../packages/core/README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## Text edits for model-authored patches'));
  const fence = section.slice(section.indexOf('```js\n') + 6, section.indexOf('\n```', section.indexOf('```js\n')));
  // Bare specifiers do not resolve from a data: URL, so point them at the resolved modules.
  const code = fence.replace(/from '(@jarenjs\/[^']+)'/g, (_, name) => `from '${import.meta.resolve(name)}'`)
    + '\nexport { patch, proposal, preview, files };\n';
  const { patch, proposal, preview, files } = await import('data:text/javascript,' + encodeURIComponent(code));
  assert.deepEqual(proposal.withheld, [{ edit: 0, reason: 'overlap', conflict: 2 }]);
  assert.equal(preview.files[0].text, '# Guide\n\n## Format\n\n- A count is a bare integer.\n- A decimal uses a period.\n\n'
    + '## Sources\n\n- inputs/ only.\n- Never read outside inputs/.\n');
  // What the prose says the same patch does without the options.
  const plain = compileTextEdits(files, patch);
  assert.deepEqual(plain.withheld, [{ edit: 0, reason: 'anchor-not-line-boundary' }, { edit: 1, reason: 'anchor-not-line-boundary' }]);
  assert.equal(applyTextEdits(files, plain.hunks).files[0].text, '# Guide\n\n## Format\n\n- A count is a bare integer.\n- A decimal uses a period.\n\n'
    + '\n- A count is a bare integer.\n\n## Sources\n\n- inputs/ only.\n');
});
