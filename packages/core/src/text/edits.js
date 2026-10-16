//@ts-check
/** Pure, bounded edits over file values. Filesystem policy belongs to the host. */
import { hashContent, utf8ByteLength } from '../string.js';
import { CodedError } from '../errors.js';

/** @typedef {{ path: string, text: string, hash: string }} TextFile */
/** @typedef {{ op: 'create_file'|'insert_before'|'insert_after'|'replace_section'|'delete_section',
 * path: string, baseHash?: string, anchor?: string, to?: string, replacement?: string,
 * group?: string, requires?: string[] }} TextEdit */
/** @typedef {{ path: string, baseHash: string|null, baseText: string|null, start: number, end: number,
 * replacement: string, source: number, group: string, members: number[], requires: string[] }} TextHunk */
/**
 * The exclusive end line of a section whose anchor occupies lines `[start, end)` and has no `to`.
 * @typedef {(lines: readonly string[], start: number, end: number) => number} TextSectionEnd
 */
/** @typedef {{ hash?: (text: string) => string, maxFiles?: number, maxEdits?: number, maxBytes?: number,
 * anchor?: 'line'|'widen', overlap?: 'withhold-both'|'first-wins', sectionEnd?: TextSectionEnd }} TextEditOptions */
/** @typedef {{ edit: number, reason: string, conflict?: number }} TextEditWithheld */

/**
 * The codes a `TextEditError` (a {@link CodedError}) thrown by `compileTextEdits`
 * or `applyTextEdits` carries. Its `docPath` points into `{ configuration, files,
 * edits, hunks, result }`, naming the option, file, edit or hunk at fault.
 * @type {Readonly<Record<'JE0001'|'JE0002'|'JE0003'|'JE0004'|'JE0005'|'JE0006'|'JE0007'|'JE0008'|'JE0009'
 * |'JE0010'|'JE0011'|'JE0012'|'JE0013'|'JE0014'|'JE0015'|'JE0016'|'JE0017', string>>}
 */
export const TEXT_EDIT_CODES = Object.freeze({
  JE0001: 'an option is invalid: a limit outside its range, a hash or section hook that is not a function, or an unknown anchor or overlap policy',
  JE0002: 'the files, edits or hunks argument is not an array',
  JE0003: 'a file lacks a safe relative path, its text or its hash, or repeats another file\'s path',
  JE0004: 'a file\'s hash does not match its content under the configured hash',
  JE0005: 'more files than maxFiles, given or produced',
  JE0006: 'more edits or hunks than maxEdits',
  JE0007: 'more group dependency references than maxEdits',
  JE0008: 'the files\' UTF-8 text exceeds maxBytes',
  JE0009: 'the edits\' paths, anchors, groups and dependencies exceed maxBytes',
  JE0010: 'the replacements exceed maxBytes',
  JE0011: 'the applied files\' UTF-8 text exceeds maxBytes',
  JE0012: 'a supplied hunk is malformed',
  JE0013: 'a supplied hunk\'s file no longer has the hunk\'s base hash and text',
  JE0014: 'a supplied hunk\'s line interval lies outside its file',
  JE0015: 'the supplied hunks do not carry every member of their groups and every group they require',
  JE0016: 'two supplied hunks overlap under the configured overlap policy',
  JE0017: 'the section hook answered an end that is not a line from the anchor\'s end to the file\'s end',
});

/** @param {keyof typeof TEXT_EDIT_CODES} code @param {string} reason @param {string} docPath */
const refusal = (code, reason, docPath) => new CodedError('TextEditError', code, reason, docPath);

const safePath = path => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !/[\\:]/.test(path) && !Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !path.split('/').some(part => !part || part === '.' || part === '..');
const linesOf = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const overlaps = (a, b) => a.path === b.path && (a.start === a.end
  ? b.start <= a.start && a.start <= b.end : b.start === b.end
    ? a.start <= b.start && b.start <= a.end : a.start < b.end && b.start < a.end);
// Under `first-wins` an insertion conflicts only strictly inside another hunk's lines: two
// insertions at one boundary, or one at a replaced section's edge, all apply. Two creates of
// one path always conflict (only a create targets a missing file).
const crosses = (a, b) => a.path === b.path && (a.baseText === null || (a.start === a.end
  ? b.start < a.start && a.start < b.end : b.start === b.end
    ? a.start < b.start && b.start < a.end : a.start < b.end && b.start < a.end));
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Canonical order: path, start, end, replacement, group, then edit index — content first,
 * so reordering the edits changes neither the text nor which rewrite loses, unless two
 * edits compile to the same hunk. */
const canonical = (a, b) => byCodeUnits(a.path, b.path) || a.start - b.start || a.end - b.end
  || byCodeUnits(a.replacement, b.replacement) || byCodeUnits(a.group, b.group) || a.source - b.source;
const POLICIES = { anchor: ['line', 'widen'], overlap: ['withhold-both', 'first-wins'] };

function settings(options) {
  const value = { hash: hashContent, maxFiles: 256, maxEdits: 256, maxBytes: 4 * 1024 * 1024, ...options };
  const limits = 'text edits require finite file, edit and byte limits and a synchronous hash';
  if (typeof value.hash !== 'function') throw refusal('JE0001', limits, '/configuration/hash');
  for (const [key, most] of [['maxFiles', 4096], ['maxEdits', 4096], ['maxBytes', 64 * 1024 * 1024]])
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > most) throw refusal('JE0001', limits, '/configuration/' + key);
  for (const [key, allowed] of Object.entries(POLICIES)) {
    value[key] ??= allowed[0];
    if (!allowed.includes(value[key])) throw refusal('JE0001', `${key} is one of ${allowed.map(name => `'${name}'`).join(', ')}`, '/configuration/' + key);
  }
  if (value.sectionEnd !== undefined && typeof value.sectionEnd !== 'function')
    throw refusal('JE0001', 'sectionEnd is a function of (lines, start, end)', '/configuration/sectionEnd');
  return value;
}

function fileMap(files, options, root = 'files') {
  if (!Array.isArray(files)) throw refusal('JE0002', 'text files must be an array', '/' + root);
  if (files.length > options.maxFiles) throw refusal('JE0005', 'text file limit exceeded', '/' + root);
  const map = new Map(); let bytes = 0;
  for (const [index, file] of files.entries()) {
    if (!file || !safePath(file.path) || typeof file.text !== 'string' || typeof file.hash !== 'string' || map.has(file.path))
      throw refusal('JE0003', 'text files need unique safe paths, text and hashes', `/${root}/${index}`);
    if (file.text.length > options.maxBytes || (bytes += utf8ByteLength(file.text)) > options.maxBytes)
      throw refusal(root === 'result' ? 'JE0011' : 'JE0008', 'text byte limit exceeded', `/${root}/${index}/text`);
    const hash = options.hash(file.text);
    if (typeof hash !== 'string' || !hash || hash !== file.hash)
      throw refusal('JE0004', 'text file hash does not match its content', `/${root}/${index}/hash`);
    map.set(file.path, { ...file });
  }
  return map;
}

/** Exact, unambiguous anchors. In `line` mode an anchor spans complete lines (the
 * last newline may be omitted); in `widen` mode it may start and end inside lines
 * and owns every line it touches. */
function anchorAt(text, anchor, widen) {
  if (typeof anchor !== 'string' || !anchor) return { reason: 'invalid-edit' };
  const at = text.indexOf(anchor);
  if (at < 0) return { reason: 'anchor-not-found' };
  if (text.indexOf(anchor, at + 1) >= 0) return { reason: 'anchor-ambiguous' };
  if (widen) return { start: linesOf(text.slice(0, at)).length - (at > 0 && text[at - 1] !== '\n' ? 1 : 0),
    end: linesOf(text.slice(0, at + anchor.length)).length };
  if (at > 0 && text[at - 1] !== '\n') return { reason: 'anchor-not-line-boundary' };
  let end = at + anchor.length;
  if (text[end - 1] !== '\n' && end < text.length) {
    if (text[end] === '\r' && text[end + 1] === '\n') end += 2;
    else if (text[end] === '\n') end++;
    else return { reason: 'anchor-not-line-boundary' };
  }
  return { start: linesOf(text.slice(0, at)).length, end: linesOf(text.slice(0, end)).length };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/, FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/, ATX = /^ {0,3}(#{1,6})(?:[ \t]|$)/;

/**
 * A {@link TextSectionEnd} for Markdown: when the anchor's first line is an ATX
 * heading of level n (up to three spaces of indentation, one to six `#`, then a
 * space, a tab or the end of the line), the section runs to the first line after
 * the anchor that is an ATX heading of level n or less, or to the end of the
 * file. Lines inside a fenced code block (three or more backticks or tildes,
 * closed by a run of the same character at least as long) are never headings;
 * setext headings are not read. Any other anchor owns only its own lines.
 * @type {TextSectionEnd}
 */
export function markdownSectionEnd(lines, start, end) {
  let fence = '', level = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r?\n$/, '');
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = '';
      if (index >= start && !level) return end;
      continue;
    }
    const open = FENCE.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      if (index >= start && !level) return end;
      continue;
    }
    if (index < start) continue;
    const heading = ATX.exec(line);
    if (!level) {
      if (!heading) return end;
      level = heading[1].length;
    }
    else if (index >= end && heading && heading[1].length <= level) return index;
  }
  return level ? lines.length : end;
}

/**
 * Compile exact line edits against frozen file values. Sections have explicit
 * inclusive end anchors; absent `to`, only the anchor's lines are replaced,
 * unless a `sectionEnd` hook (such as {@link markdownSectionEnd}) extends them.
 * Shared group names and explicit group dependencies express atomicity without
 * interpreting Markdown links or domain content. Partial independent groups are
 * returned, but valid is false whenever any edit was withheld. Overlapping hunks
 * are both withheld by default; under `overlap: 'first-wins'` groups compete whole
 * in canonical order of their first hunk, and a later crossing hunk is withheld
 * with `conflict` naming the kept edit.
 * @param {readonly TextFile[]} files @param {readonly TextEdit[]} edits
 * @param {TextEditOptions} [configuration]
 * @returns {{ valid: boolean, hunks: TextHunk[], withheld: TextEditWithheld[], groups: string[][] }}
 * @throws {CodedError} `TextEditError` with a {@link TEXT_EDIT_CODES} code for an invalid option, argument or bound
 */
export function compileTextEdits(files, edits, configuration = {}) {
  const options = settings(configuration), map = fileMap(files, options);
  if (!Array.isArray(edits)) throw refusal('JE0002', 'text edits must be an array', '/edits');
  if (edits.length > options.maxEdits) throw refusal('JE0006', 'text edit limit exceeded', '/edits');
  const widen = options.anchor === 'widen', firstWins = options.overlap === 'first-wins', fileLines = new Map();
  const failed = new Map(), groups = new Map(), candidates = [], conflicts = new Map();
  let bytes = 0, metadataBytes = 0, dependencyCount = 0;
  const groupOf = (edit, i) => edit?.group ?? `:${i}`;
  const refuse = (index, reason) => { if (!failed.has(index)) failed.set(index, reason); };
  edits.forEach((edit, source) => {
    const group = groupOf(edit, source), members = groups.get(group) ?? [];
    members.push(source); groups.set(group, members);
    if (!edit || !safePath(edit.path)) { refuse(source, 'path-unsafe'); return; }
    if (edit.group !== undefined && (typeof edit.group !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(edit.group))) {
      refuse(source, 'invalid-edit'); return;
    }
    if (edit.requires !== undefined && (!Array.isArray(edit.requires) || edit.requires.length > edits.length
      || edit.requires.some(name => typeof name !== 'string'))) { refuse(source, 'invalid-edit'); return; }
    dependencyCount += edit.requires?.length ?? 0;
    if (dependencyCount > options.maxEdits) throw refusal('JE0007', 'text dependency limit exceeded', `/edits/${source}/requires`);
    for (const value of [edit.path, edit.group ?? '', edit.anchor ?? '', edit.to ?? '', ...(edit.requires ?? [])]) {
      if (typeof value !== 'string') { refuse(source, 'invalid-edit'); return; }
      if (value.length > options.maxBytes || (metadataBytes += utf8ByteLength(value)) > options.maxBytes)
        throw refusal('JE0009', 'text metadata byte limit exceeded', `/edits/${source}`);
    }
    const replacement = edit.op === 'delete_section' ? '' : edit.replacement;
    if (typeof replacement !== 'string') { refuse(source, 'invalid-edit'); return; }
    if (replacement.length > options.maxBytes || (bytes += utf8ByteLength(replacement)) > options.maxBytes)
      throw refusal('JE0010', 'replacement byte limit exceeded', `/edits/${source}/replacement`);
    const file = map.get(edit.path);
    const hunk = { path: edit.path, baseHash: file?.hash ?? null, baseText: file?.text ?? null,
      start: 0, end: 0, replacement, source, group, members: [], requires: [...new Set(edit.requires ?? [])] };
    if (edit.op === 'create_file') {
      if (file || edit.baseHash !== undefined) { refuse(source, 'stale-base'); return; }
    }
    else {
      if (!['insert_before', 'insert_after', 'replace_section', 'delete_section'].includes(edit.op)) { refuse(source, 'invalid-edit'); return; }
      if (!file) { refuse(source, 'missing-target'); return; }
      if (edit.baseHash !== file.hash) { refuse(source, 'stale-base'); return; }
      const anchor = anchorAt(file.text, edit.anchor, widen);
      if (anchor.reason) { refuse(source, anchor.reason); return; }
      hunk.start = anchor.start; hunk.end = anchor.end;
      if (edit.op === 'insert_before') hunk.end = hunk.start;
      else if (edit.op === 'insert_after') hunk.start = hunk.end;
      else if (edit.to !== undefined) {
        const end = anchorAt(file.text, edit.to, widen);
        if (end.reason || end.start < anchor.start || end.end < anchor.end) { refuse(source, end.reason ?? 'invalid-edit'); return; }
        hunk.end = end.end;
      }
      else if (options.sectionEnd) {
        let lines = fileLines.get(file.path);
        if (!lines) fileLines.set(file.path, lines = Object.freeze(linesOf(file.text)));
        const end = options.sectionEnd(lines, hunk.start, hunk.end);
        if (!Number.isSafeInteger(end) || end < hunk.end || end > lines.length)
          throw refusal('JE0017', `the section hook answered ${typeof end === 'number' ? end : typeof end} for lines ${hunk.start}-${hunk.end} of ${lines.length}`, `/edits/${source}`);
        hunk.end = end;
      }
    }
    candidates.push(hunk);
  });
  if (!firstWins) for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++)
    if (overlaps(candidates[i], candidates[j])) { refuse(candidates[i].source, 'overlap'); refuse(candidates[j].source, 'overlap'); }
  const edges = new Map([...groups].map(([group, members]) => [group, [...new Set(members.flatMap(index =>
    Array.isArray(edits[index]?.requires) ? edits[index].requires : []))]]));
  const dependencies = group => edges.get(group);
  // Iterative topological walk: cycles and anything depending on a cycle
  // remain pending, without consuming the JavaScript call stack.
  const pending = new Map(), dependents = new Map();
  for (const group of groups.keys()) {
    const existing = dependencies(group).filter(required => groups.has(required));
    if (existing.length !== dependencies(group).length) for (const index of groups.get(group)) refuse(index, 'group-incomplete');
    pending.set(group, existing.length);
    for (const required of existing) {
      const next = dependents.get(required) ?? []; next.push(group); dependents.set(required, next);
    }
  }
  const ready = [...pending].filter(([, count]) => count === 0).map(([group]) => group);
  for (let i = 0; i < ready.length; i++) for (const next of dependents.get(ready[i]) ?? []) {
    pending.set(next, pending.get(next) - 1);
    if (pending.get(next) === 0) ready.push(next);
  }
  for (const [group, count] of pending) if (count > 0) for (const index of groups.get(group)) refuse(index, 'group-incomplete');
  const propagate = () => {
    let changed;
    do {
      const count = failed.size;
      for (const [group, members] of groups) if (members.some(index => failed.has(index))
        || dependencies(group).some(required => !groups.has(required) || groups.get(required).some(index => failed.has(index))))
        for (const index of members) refuse(index, 'group-incomplete');
      changed = count !== failed.size;
    } while (changed);
  };
  propagate();
  if (firstWins) {
    // Groups compete whole, in canonical order of their first standing hunk, and are kept
    // only with every group they require; a kept hunk never falls afterwards, so `conflict`
    // always names an applied edit. A group whose own members cross each other, or cross
    // a group it requires, withholds them without a `conflict`: nothing of it applies.
    const standing = candidates.filter(hunk => !failed.has(hunk.source)).sort(canonical);
    const hunksOf = new Map(), accepted = new Set(), kept = [];
    const clash = list => list.some((hunk, i) => list.slice(0, i).some(other => crosses(other, hunk)));
    for (const hunk of standing) hunksOf.set(hunk.group, [...hunksOf.get(hunk.group) ?? [], hunk]);
    for (const [group, own] of hunksOf) {
      if (accepted.has(group)) continue;
      const unit = [group];
      for (let i = 0; i < unit.length; i++) for (const required of dependencies(unit[i]))
        if (!accepted.has(required) && !unit.includes(required)) unit.push(required);
      const required = unit.slice(1).flatMap(name => hunksOf.get(name) ?? []);
      let lost = false;
      for (const [i, hunk] of own.entries()) {
        const winner = kept.find(other => crosses(other, hunk));
        if (winner) { refuse(hunk.source, 'overlap'); conflicts.set(hunk.source, winner.source); lost = true; continue; }
        const rival = own.slice(0, i).find(other => crosses(other, hunk)) ?? required.find(other => crosses(other, hunk));
        if (rival) { refuse(hunk.source, 'overlap'); if (rival.group === group) refuse(rival.source, 'overlap'); lost = true; }
      }
      // A required group that cannot stand is withheld on its own turn; this one then falls with it.
      if (lost || clash(required) || required.some(hunk => kept.some(other => crosses(other, hunk)))) continue;
      for (const name of unit) accepted.add(name);
      kept.push(...own, ...required);
    }
    propagate();
  }
  const hunks = candidates.filter(hunk => !failed.has(hunk.source)).map(hunk => ({ ...hunk,
    members: [...groups.get(hunk.group)], requires: dependencies(hunk.group) }));
  return { valid: failed.size === 0, hunks,
    withheld: [...failed].sort(([a], [b]) => a - b).map(([edit, reason]) => conflicts.has(edit)
      ? { edit, reason, conflict: conflicts.get(edit) } : { edit, reason }),
    groups: [...groups.values()].filter(members => members.every(index => !failed.has(index)))
      .map(members => [...new Set(members.map(index => edits[index].path))]) };
}

function unified(path, before, after) {
  const oldLines = before === null ? [] : linesOf(before), nextLines = linesOf(after);
  const rendered = (lines, prefix) => lines.map(line => prefix + line
    + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n')).join('');
  return `--- ${before === null ? '/dev/null' : JSON.stringify('a/' + path)}\n+++ ${JSON.stringify('b/' + path)}\n`
    + `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${nextLines.length ? 1 : 0},${nextLines.length} @@\n`
    + rendered(oldLines, '-') + rendered(nextLines, '+');
}

const LINE_BREAK = /\r?\n/;

/** Edits are line-granular, so a piece of text without a final line break (a replacement,
 * or the file's unterminated last line) that the next piece would run into gets the file's
 * line ending: its first break, else the edited text's, else LF. A piece with nothing
 * after it keeps its missing final newline. */
function terminateJoins(pieces, before) {
  let ending, last = -1;
  for (let i = 0; i < pieces.length; i++) if (pieces[i]) {
    if (last >= 0 && !pieces[last].endsWith('\n'))
      pieces[last] += ending ??= (LINE_BREAK.exec(before ?? '') ?? LINE_BREAK.exec(pieces.join('')))?.[0] ?? '\n';
    last = i;
  }
}

/** Apply complete groups to copies; recheck bases and intervals even for supplied hunks.
 * Pass the configuration the hunks were compiled under: its `hash`, and its
 * `overlap` policy, which decides whether hunks that touch may apply together
 * (they apply in canonical order, whatever the order of `hunks`).
 * @param {readonly TextFile[]} files @param {readonly TextHunk[]} hunks
 * @param {TextEditOptions} [configuration] @returns {{ files: TextFile[], diff: string }}
 * @throws {CodedError} `TextEditError` with a {@link TEXT_EDIT_CODES} code for an invalid option,
 *   argument, bound or hunk */
export function applyTextEdits(files, hunks, configuration = {}) {
  const options = settings(configuration), map = fileMap(files, options);
  if (!Array.isArray(hunks)) throw refusal('JE0002', 'text hunks must be an array', '/hunks');
  if (hunks.length > options.maxEdits) throw refusal('JE0006', 'text edit limit exceeded', '/hunks');
  const sources = new Set(), byGroup = new Map(); let bytes = 0;
  for (const [index, hunk] of hunks.entries()) {
    if (!hunk || !safePath(hunk.path) || typeof hunk.replacement !== 'string' || !Number.isSafeInteger(hunk.source)
      || hunk.source < 0 || sources.has(hunk.source) || typeof hunk.group !== 'string' || hunk.group.length > 128
      || !Array.isArray(hunk.members) || hunk.members.length > options.maxEdits || !Array.isArray(hunk.requires) || hunk.requires.length > options.maxEdits
      || hunk.members.some(source => !Number.isSafeInteger(source) || source < 0)
      || hunk.requires.some(group => typeof group !== 'string' || group.length > 128))
      throw refusal('JE0012', 'invalid text hunk', `/hunks/${index}`);
    sources.add(hunk.source);
    const group = byGroup.get(hunk.group) ?? new Set(); group.add(hunk.source); byGroup.set(hunk.group, group);
    if (hunk.replacement.length > options.maxBytes || (bytes += utf8ByteLength(hunk.replacement)) > options.maxBytes)
      throw refusal('JE0010', 'replacement byte limit exceeded', `/hunks/${index}/replacement`);
    const file = map.get(hunk.path);
    if (file ? file.hash !== hunk.baseHash || file.text !== hunk.baseText : hunk.baseHash !== null || hunk.baseText !== null)
      throw refusal('JE0013', 'stale-base: the file no longer has the hunk\'s base hash and text', `/hunks/${index}`);
    const length = file ? linesOf(file.text).length : 0;
    if (!Number.isSafeInteger(hunk.start) || !Number.isSafeInteger(hunk.end) || hunk.start < 0 || hunk.end < hunk.start || hunk.end > length)
      throw refusal('JE0014', 'invalid text interval', `/hunks/${index}`);
  }
  for (const [index, hunk] of hunks.entries()) if (new Set(hunk.members).size !== byGroup.get(hunk.group).size
    || hunk.members.some(source => !byGroup.get(hunk.group).has(source))
    || hunk.requires.some(group => !byGroup.has(group))) throw refusal('JE0015', 'group-incomplete', `/hunks/${index}`);
  const conflict = options.overlap === 'first-wins' ? crosses : overlaps;
  for (let i = 0; i < hunks.length; i++) for (let j = i + 1; j < hunks.length; j++)
    if (conflict(hunks[i], hunks[j])) throw refusal('JE0016', `overlap: hunk ${j} overlaps hunk ${i}`, `/hunks/${j}`);
  let diff = '';
  for (const path of [...new Set(hunks.map(hunk => hunk.path))].sort()) {
    const before = map.get(path)?.text ?? null, lines = linesOf(before ?? '');
    // Reverse canonical order: last first, so earlier intervals keep their line numbers;
    // at one start a replaced section before an insertion there, and insertions at one
    // boundary in reverse, so the text reads in canonical order. Only `first-wins` lets
    // hunks share a start: the default refuses them as overlaps.
    for (const hunk of hunks.filter(hunk => hunk.path === path).sort((a, b) => canonical(b, a)))
      lines.splice(hunk.start, hunk.end - hunk.start, hunk.replacement);
    terminateJoins(lines, before);
    const text = lines.join('');
    map.set(path, { path, text, hash: options.hash(text) });
    if (before !== text) diff += unified(path, before, text);
  }
  const result = [...map.values()]; fileMap(result, options, 'result');
  return { files: result, diff };
}
