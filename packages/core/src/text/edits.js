//@ts-check
/** Pure, bounded edits over file values. Filesystem policy belongs to the host. */
import { hashContent, utf8ByteLength } from '../string.js';

/** @typedef {{ path: string, text: string, hash: string }} TextFile */
/** @typedef {{ op: 'create_file'|'insert_before'|'insert_after'|'replace_section'|'delete_section',
 * path: string, baseHash?: string, anchor?: string, to?: string, replacement?: string,
 * group?: string, requires?: string[] }} TextEdit */
/** @typedef {{ path: string, baseHash: string|null, baseText: string|null, start: number, end: number,
 * replacement: string, source: number, group: string, members: number[], requires: string[] }} TextHunk */
/** @typedef {{ hash?: (text: string) => string, maxFiles?: number, maxEdits?: number, maxBytes?: number }} TextEditOptions */

const safePath = path => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !/[\\:]/.test(path) && !Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !path.split('/').some(part => !part || part === '.' || part === '..');
const linesOf = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const overlaps = (a, b) => a.path === b.path && (a.start === a.end
  ? b.start <= a.start && a.start <= b.end : b.start === b.end
    ? a.start <= b.start && b.start <= a.end : a.start < b.end && b.start < a.end);

function settings(options) {
  const value = { hash: hashContent, maxFiles: 256, maxEdits: 256, maxBytes: 4 * 1024 * 1024, ...options };
  if (typeof value.hash !== 'function' || ['maxFiles', 'maxEdits', 'maxBytes'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 1)
    || value.maxFiles > 4096 || value.maxEdits > 4096 || value.maxBytes > 64 * 1024 * 1024)
    throw new RangeError('text edits require finite file, edit and byte limits and a synchronous hash');
  return value;
}

function fileMap(files, options) {
  if (!Array.isArray(files) || files.length > options.maxFiles) throw new RangeError('text file limit exceeded');
  const map = new Map(); let bytes = 0;
  for (const file of files) {
    if (!file || !safePath(file.path) || typeof file.text !== 'string' || typeof file.hash !== 'string' || map.has(file.path))
      throw new TypeError('text files need unique safe paths, text and hashes');
    if (file.text.length > options.maxBytes) throw new RangeError('text byte limit exceeded');
    bytes += utf8ByteLength(file.text);
    if (bytes > options.maxBytes) throw new RangeError('text byte limit exceeded');
    const hash = options.hash(file.text);
    if (typeof hash !== 'string' || !hash || hash !== file.hash) throw new TypeError('text file hash does not match its content');
    map.set(file.path, { ...file });
  }
  return map;
}

/** Exact, unambiguous anchors must span complete lines (the last newline may be omitted). */
function anchorAt(text, anchor) {
  if (typeof anchor !== 'string' || !anchor) return { reason: 'invalid-edit' };
  const at = text.indexOf(anchor);
  if (at < 0) return { reason: 'anchor-not-found' };
  if (text.indexOf(anchor, at + 1) >= 0) return { reason: 'anchor-ambiguous' };
  if (at > 0 && text[at - 1] !== '\n') return { reason: 'anchor-not-line-boundary' };
  let end = at + anchor.length;
  if (text[end - 1] !== '\n' && end < text.length) {
    if (text[end] === '\r' && text[end + 1] === '\n') end += 2;
    else if (text[end] === '\n') end++;
    else return { reason: 'anchor-not-line-boundary' };
  }
  return { start: linesOf(text.slice(0, at)).length, end: linesOf(text.slice(0, end)).length };
}

/**
 * Compile exact line edits against frozen file values. Sections have explicit
 * inclusive end anchors; absent `to`, only the anchor's lines are replaced.
 * Shared group names and explicit group dependencies express atomicity without
 * interpreting Markdown links or domain content. Partial independent groups are
 * returned, but valid is false whenever any edit was withheld.
 * @param {readonly TextFile[]} files @param {readonly TextEdit[]} edits
 * @param {TextEditOptions} [configuration]
 * @returns {{ valid: boolean, hunks: TextHunk[], withheld: { edit: number, reason: string }[], groups: string[][] }}
 */
export function compileTextEdits(files, edits, configuration = {}) {
  const options = settings(configuration), map = fileMap(files, options);
  if (!Array.isArray(edits) || edits.length > options.maxEdits) throw new RangeError('text edit limit exceeded');
  const failed = new Map(), groups = new Map(), candidates = [];
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
    if (dependencyCount > options.maxEdits) throw new RangeError('text dependency limit exceeded');
    for (const value of [edit.path, edit.group ?? '', edit.anchor ?? '', edit.to ?? '', ...(edit.requires ?? [])]) {
      if (typeof value !== 'string') { refuse(source, 'invalid-edit'); return; }
      if (value.length > options.maxBytes || (metadataBytes += utf8ByteLength(value)) > options.maxBytes)
        throw new RangeError('text metadata byte limit exceeded');
    }
    const replacement = edit.op === 'delete_section' ? '' : edit.replacement;
    if (typeof replacement !== 'string') { refuse(source, 'invalid-edit'); return; }
    if (replacement.length > options.maxBytes) throw new RangeError('replacement byte limit exceeded');
    bytes += utf8ByteLength(replacement);
    if (bytes > options.maxBytes) throw new RangeError('replacement byte limit exceeded');
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
      const anchor = anchorAt(file.text, edit.anchor);
      if (anchor.reason) { refuse(source, anchor.reason); return; }
      hunk.start = anchor.start; hunk.end = anchor.end;
      if (edit.op === 'insert_before') hunk.end = hunk.start;
      else if (edit.op === 'insert_after') hunk.start = hunk.end;
      else if (edit.to !== undefined) {
        const end = anchorAt(file.text, edit.to);
        if (end.reason || end.start < anchor.start || end.end < anchor.end) { refuse(source, end.reason ?? 'invalid-edit'); return; }
        hunk.end = end.end;
      }
    }
    candidates.push(hunk);
  });
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++)
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
  let changed;
  do {
    const count = failed.size;
    for (const [group, members] of groups) if (members.some(index => failed.has(index))
      || dependencies(group).some(required => !groups.has(required) || groups.get(required).some(index => failed.has(index))))
      for (const index of members) refuse(index, 'group-incomplete');
    changed = count !== failed.size;
  } while (changed);
  const hunks = candidates.filter(hunk => !failed.has(hunk.source)).map(hunk => ({ ...hunk,
    members: [...groups.get(hunk.group)], requires: dependencies(hunk.group) }));
  return { valid: failed.size === 0, hunks,
    withheld: [...failed].sort(([a], [b]) => a - b).map(([edit, reason]) => ({ edit, reason })),
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

/** Apply complete groups to copies; recheck bases and intervals even for supplied hunks.
 * @param {readonly TextFile[]} files @param {readonly TextHunk[]} hunks
 * @param {TextEditOptions} [configuration] @returns {{ files: TextFile[], diff: string }} */
export function applyTextEdits(files, hunks, configuration = {}) {
  const options = settings(configuration), map = fileMap(files, options);
  if (!Array.isArray(hunks) || hunks.length > options.maxEdits) throw new RangeError('text edit limit exceeded');
  const sources = new Set(), byGroup = new Map(); let bytes = 0;
  for (const hunk of hunks) {
    if (!hunk || !safePath(hunk.path) || typeof hunk.replacement !== 'string' || !Number.isSafeInteger(hunk.source)
      || hunk.source < 0 || sources.has(hunk.source) || typeof hunk.group !== 'string' || hunk.group.length > 128
      || !Array.isArray(hunk.members) || hunk.members.length > options.maxEdits || !Array.isArray(hunk.requires) || hunk.requires.length > options.maxEdits
      || hunk.members.some(source => !Number.isSafeInteger(source) || source < 0)
      || hunk.requires.some(group => typeof group !== 'string' || group.length > 128))
      throw new TypeError('invalid text hunk');
    sources.add(hunk.source);
    const group = byGroup.get(hunk.group) ?? new Set(); group.add(hunk.source); byGroup.set(hunk.group, group);
    if (hunk.replacement.length > options.maxBytes) throw new RangeError('replacement byte limit exceeded');
    bytes += utf8ByteLength(hunk.replacement);
    if (bytes > options.maxBytes) throw new RangeError('replacement byte limit exceeded');
    const file = map.get(hunk.path);
    if (file ? file.hash !== hunk.baseHash || file.text !== hunk.baseText : hunk.baseHash !== null || hunk.baseText !== null)
      throw new TypeError('stale-base');
    const length = file ? linesOf(file.text).length : 0;
    if (!Number.isSafeInteger(hunk.start) || !Number.isSafeInteger(hunk.end) || hunk.start < 0 || hunk.end < hunk.start || hunk.end > length)
      throw new RangeError('invalid text interval');
  }
  for (const hunk of hunks) if (new Set(hunk.members).size !== byGroup.get(hunk.group).size
    || hunk.members.some(source => !byGroup.get(hunk.group).has(source))
    || hunk.requires.some(group => !byGroup.has(group))) throw new TypeError('group-incomplete');
  for (let i = 0; i < hunks.length; i++) for (let j = i + 1; j < hunks.length; j++)
    if (overlaps(hunks[i], hunks[j])) throw new TypeError('overlap');
  let diff = '';
  for (const path of [...new Set(hunks.map(hunk => hunk.path))].sort()) {
    const before = map.get(path)?.text ?? null, lines = linesOf(before ?? '');
    for (const hunk of hunks.filter(hunk => hunk.path === path).sort((a, b) => b.start - a.start))
      lines.splice(hunk.start, hunk.end - hunk.start, hunk.replacement);
    const text = lines.join('');
    map.set(path, { path, text, hash: options.hash(text) });
    if (before !== text) diff += unified(path, before, text);
  }
  const result = [...map.values()]; fileMap(result, options);
  return { files: result, diff };
}
