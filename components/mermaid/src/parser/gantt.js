//@ts-check
/**
 * @file Gantt grammar → gantt AST: a schedule, resolved.
 *
 * Header directives (`title`, `dateFormat`, `axisFormat`, `excludes`,
 * `tickInterval`, `weekday`, `weekend`, `todayMarker`) are kept verbatim
 * in `meta` so the printer stays a fixed point, and are *also*
 * interpreted into `rules` — a compiled date parser, an axis pattern, a
 * tick step, a working calendar. `section` groups tasks; a task row
 * keeps its raw metadata string (`:done, id, 2014-01-06, 3d`) in `info`
 * for the same printing reason and gains the semantic members a
 * timeline needs: `{ id, flags, start, end, duration, after, line }`,
 * with `start`/`end` epoch milliseconds and the interval half-open.
 *
 * The AST stays geometry-free and plain JSON: no compiled closure and
 * no coordinate crosses this boundary. Layout re-compiles the axis
 * pattern from `rules`, once per diagram.
 *
 * Three refusals are the whole difference from a permissive reader, and
 * each one is a `JM` error carrying its source line:
 *
 * 1. **No clock.** Mermaid starts an undated first task *today*. This
 *    engine has no clock (`docs/ROADMAP.md`, "there is no now"), so a
 *    schedule with no dated anchor is an error rather than a diagram
 *    that means something different tomorrow.
 * 2. **No silent literals.** An unsupported `dateFormat` or
 *    `axisFormat` token is refused by name; Mermaid passes it through as
 *    literal text, which turns a typo into a date that reads as
 *    something else.
 * 3. **No guessed dependencies.** A missing id, a duplicate id, a cycle
 *    and a reversed or empty span are all errors.
 */

import { fail } from '../errors.js';
import { compileDateParser, epochOfRFC3339Parts, addToParts, partsFromEpoch } from '@jarenjs/core/dates';
import {
  DEFAULT_DATE_FORMAT, DEFAULT_AXIS_FORMAT,
  momentToLdml, strftimeToLdml, ldmlNeedsNames,
  parseTickInterval, parseTaskDuration, parseWeekday, parseWeekend,
  ISO_WEEKDAYS,
} from './gantt-grammar.js';
import { createExcluder, pushEndPastExclusions, dayIndexOf, DAY_MS } from '../gantt-calendar.js';

const HEADER_KEYS = new Set([
  'title', 'dateFormat', 'axisFormat', 'excludes', 'todayMarker',
  'tickInterval', 'weekday', 'weekend',
]);

/** The task flags Mermaid documents, in the order the AST lists them. */
const FLAGS = Object.freeze(['done', 'active', 'crit', 'milestone']);
const FLAG_SET = new Set(FLAGS);

/**
 * @param {string[]} lines
 * @param {number} [offset] - 0-based index of `lines[0]` in the source
 * @param {string} [_header]
 * @param {{ dateNames?: import('@jarenjs/core/dates').DateNames }} [options]
 * @returns {object}
 */
export function parseGantt(lines, offset = 0, _header = '', options = {}) {
  const { meta, metaLine, sections } = scan(lines, offset);
  const rules = interpret(meta, metaLine, options.dateNames);
  resolve(sections, rules);
  return { meta, rules: rules.published, sections, domain: domainOf(sections) };
}

//#region scanning ---------------------------------------------------

/**
 * Read the source into raw meta and raw task rows. Nothing is
 * interpreted here, so the printer's inputs exist even for a document
 * that later fails to resolve.
 * @param {string[]} lines
 * @param {number} offset
 * @returns {{ meta: any, metaLine: any, sections: any[] }}
 */
function scan(lines, offset) {
  /** @type {Record<string, string>} */
  const meta = {};
  /** @type {Record<string, number>} */
  const metaLine = {};
  const sections = [];
  let current = { name: null, tasks: [] };
  sections.push(current);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === '' || line.startsWith('%%')) continue;
    const at = offset + li + 1;
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);

    if (HEADER_KEYS.has(key)) {
      meta[key] = sp === -1 ? '' : line.slice(sp + 1).trim();
      metaLine[key] = at;
      continue;
    }
    if (key === 'section') {
      current = { name: line.slice('section'.length).trim(), tasks: [] };
      sections.push(current);
      continue;
    }
    // Task row: `Name : meta`
    const colon = line.indexOf(':');
    if (colon !== -1) {
      const name = line.slice(0, colon).trim();
      const info = line.slice(colon + 1).trim();
      current.tasks.push({
        name, info,
        id: null, flags: [], start: 0, end: 0, duration: 0, after: [],
        line: at,
      });
    }
  }

  // Drop a leading empty default section if unused.
  const trimmed = sections[0].name === null && sections[0].tasks.length === 0
    ? sections.slice(1) : sections;
  return { meta, metaLine, sections: trimmed };
}

//#endregion
//#region header interpretation --------------------------------------

/**
 * Turn the raw header strings into the compiled rules the resolver and
 * the layout need. Every failure names its own source line.
 * @param {Record<string, string>} meta
 * @param {Record<string, number>} metaLine
 * @param {any} dateNames
 * @returns {any}
 */
function interpret(meta, metaLine, dateNames) {
  const dateFormat = meta.dateFormat === undefined || meta.dateFormat === ''
    ? DEFAULT_DATE_FORMAT : meta.dateFormat;
  const axisFormat = meta.axisFormat === undefined || meta.axisFormat === ''
    ? DEFAULT_AXIS_FORMAT : meta.axisFormat;

  const readDate = compilePattern(dateFormat, metaLine.dateFormat ?? 0,
    momentToLdml, 'dateFormat', dateNames, true);
  // the axis pattern is only VALIDATED here; layout compiles it, so no
  // closure lands in the AST
  compilePattern(axisFormat, metaLine.axisFormat ?? 0,
    strftimeToLdml, 'axisFormat', dateNames, false);

  let tick = null;
  if (meta.tickInterval !== undefined && meta.tickInterval !== '') {
    const got = parseTickInterval(meta.tickInterval);
    if (got.error !== null) fail(got.error, metaLine.tickInterval);
    tick = got.value;
  }

  let weekStart = 1;
  if (meta.weekday !== undefined && meta.weekday !== '') {
    const got = parseWeekday(meta.weekday);
    if (got.error !== null) fail(got.error, metaLine.weekday);
    weekStart = got.value;
  }

  let weekendStart = ISO_WEEKDAYS.saturday;
  if (meta.weekend !== undefined && meta.weekend !== '') {
    const got = parseWeekend(meta.weekend);
    if (got.error !== null) fail(got.error, metaLine.weekend);
    weekendStart = got.value;
  }

  const excludes = readExcludes(meta.excludes, metaLine.excludes ?? 0, readDate);
  const excluder = createExcluder(excludes, weekendStart);

  return {
    readDate,
    excluder,
    published: {
      dateFormat, axisFormat, tick, weekStart, weekendStart,
      excludes, todayMarker: meta.todayMarker ?? null,
    },
  };
}

/**
 * Adapt a Mermaid pattern to LDML and compile it, turning both the
 * adapter's refusal and the core compiler's into a line-aware `JM`.
 * @param {string} pattern
 * @param {number} line
 * @param {(p: string) => { value: any, error: string | null }} adapt
 * @param {string} directive - `'dateFormat'` or `'axisFormat'`
 * @param {any} names
 * @param {boolean} asParser
 * @returns {any}
 */
function compilePattern(pattern, line, adapt, directive, names, asParser) {
  const adapted = adapt(pattern);
  if (adapted.error !== null) fail(adapted.error, line);
  const needed = ldmlNeedsNames(adapted.value);
  if (needed !== null && (names === undefined || names === null)) {
    fail(`${directive} '${pattern}' asks for a locale name, so it needs a`
      + " 'dateNames' provider (parseMermaid(source, { dateNames }));"
      + ' this engine ships no month or weekday names of its own', line);
  }
  if (!asParser) return null;
  try {
    return compileDateParser(adapted.value, names);
  }
  catch (err) {
    return fail(`${directive} '${pattern}' cannot be read: ${err.message}`, line);
  }
}

/**
 * Parse the `excludes` terms: `weekends`, weekday names, and explicit
 * dates in the document's own `dateFormat` (or plain ISO, which Mermaid
 * also accepts).
 * @param {string | undefined} text
 * @param {number} line
 * @param {(s: string) => any} readDate
 * @returns {{ weekends: boolean, weekdays: number[], days: number[] }}
 */
function readExcludes(text, line, readDate) {
  const out = { weekends: false, weekdays: [], days: [] };
  if (text === undefined || text === '') return out;
  for (const term of text.toLowerCase().split(/[\s,]+/)) {
    if (term === '') continue;
    if (term === 'weekends') { out.weekends = true; continue; }
    const weekday = ISO_WEEKDAYS[term];
    if (weekday !== undefined) {
      if (!out.weekdays.includes(weekday)) out.weekdays.push(weekday);
      continue;
    }
    const at = readInstant(term, readDate);
    if (Number.isNaN(at)) {
      fail(`excludes '${term}' is neither 'weekends', a weekday name,`
        + ' nor a date in this diagram\'s dateFormat', line);
    }
    const day = dayIndexOf(at);
    if (!out.days.includes(day)) out.days.push(day);
  }
  out.weekdays.sort((a, b) => a - b);
  out.days.sort((a, b) => a - b);
  return out;
}

/** ISO `yyyy-MM-dd`, which Mermaid accepts for an excluded date whatever the dateFormat is. */
const READ_ISO_DAY = compileDateParser('yyyy-MM-dd');

/**
 * @param {string} text
 * @param {(s: string) => any} readDate
 * @returns {number} epoch milliseconds, or NaN
 */
function readInstant(text, readDate) {
  const parts = readDate(text) ?? READ_ISO_DAY(text);
  if (parts === null) return NaN;
  return epochOfRFC3339Parts(parts);
}

//#endregion
//#region schedule resolution ----------------------------------------

const AFTER = /^after\s+(?<ids>[\w\- ]+)$/;
const UNTIL = /^until\s+(?<ids>[\w\- ]+)$/;

/**
 * Give every task an id, an interval and its dependencies, in an order
 * that respects them.
 * @param {any[]} sections
 * @param {any} rules
 * @returns {void}
 */
function resolve(sections, rules) {
  const tasks = [];
  for (const section of sections)
    for (const task of section.tasks) tasks.push(task);
  if (tasks.length === 0) return;

  /** @type {Map<string, any>} */
  const byId = new Map();
  // the parsed specs live beside the tasks, never on them: a task node
  // is born with its final member set and keeps it, so every task in
  // every diagram shares one hidden class (ast.js §4)
  /** @type {Map<any, any>} */
  const specs = new Map();
  let auto = 0;

  // pass 1: split the raw info into flags, id and the two specs
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const spec = splitInfo(task);
    task.flags = spec.flags;
    task.id = spec.id ?? `task${++auto}`;
    task.after = spec.after;
    spec.previous = i === 0 ? null : tasks[i - 1];
    specs.set(task, spec);
    if (byId.has(task.id)) {
      fail(`task id '${task.id}' is declared twice`, task.line);
    }
    byId.set(task.id, task);
  }

  // pass 2: resolve in dependency order, refusing cycles
  const state = new Map(); // task -> 'open' | 'done'
  for (const task of tasks) resolveTask(task, byId, specs, state, rules);
}

/**
 * Read the flags, the id and the two specs out of a raw `info` string.
 * The field-count rule is Mermaid's own: one field is an end, two are a
 * start and an end, three add an explicit id in front.
 * @param {any} task
 * @returns {any}
 */
function splitInfo(task) {
  const fields = task.info.split(',').map((f) => f.trim());
  const flags = [];
  while (fields.length > 0 && FLAG_SET.has(fields[0].toLowerCase())) {
    const flag = fields.shift().toLowerCase();
    if (!flags.includes(flag)) flags.push(flag);
  }
  flags.sort((a, b) => FLAGS.indexOf(a) - FLAGS.indexOf(b));

  let id = null;
  let startText = null;
  let endText = null;
  if (fields.length === 1) {
    endText = fields[0];
  }
  else if (fields.length === 2) {
    startText = fields[0];
    endText = fields[1];
  }
  else if (fields.length === 3) {
    id = fields[0];
    startText = fields[1];
    endText = fields[2];
  }
  else {
    fail(`task '${task.name}' has ${fields.length} fields after its flags;`
      + ' a task is written as [flags,] [id,] [start,] end', task.line);
  }
  if (id === '') {
    fail(`task '${task.name}' has an empty id`, task.line);
  }
  if (endText === '') {
    fail(`task '${task.name}' has no end, duration or 'until'`, task.line);
  }

  const afterMatch = startText === null ? null : AFTER.exec(startText);
  const untilMatch = UNTIL.exec(endText);
  return {
    flags, id, startText, endText,
    after: afterMatch === null ? [] : idsOf(afterMatch.groups.ids),
    until: untilMatch === null ? [] : idsOf(untilMatch.groups.ids),
    previous: null,
  };
}

/** @param {string} text @returns {string[]} */
function idsOf(text) {
  return text.split(' ').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Resolve one task, resolving whatever it depends on first.
 * @param {any} task
 * @param {Map<string, any>} byId
 * @param {Map<any, any>} specs
 * @param {Map<any, string>} state
 * @param {any} rules
 * @returns {void}
 */
function resolveTask(task, byId, specs, state, rules) {
  const seen = state.get(task);
  if (seen === 'done') return;
  if (seen === 'open') {
    fail(`task '${task.id}' depends on itself, directly or through a cycle`, task.line);
  }
  state.set(task, 'open');
  const spec = specs.get(task);

  /** @param {string} id @param {string} keyword @returns {any} */
  const need = (id, keyword) => {
    const other = byId.get(id);
    if (other === undefined)
      fail(`task '${task.id}' says '${keyword} ${id}', and no task has that id`, task.line);
    resolveTask(other, byId, specs, state, rules);
    return other;
  };

  // --- start
  let start;
  if (spec.after.length > 0) {
    start = -Infinity;
    for (const id of spec.after) start = Math.max(start, need(id, 'after').end);
  }
  else if (spec.startText !== null) {
    start = readInstant(spec.startText, rules.readDate);
    if (Number.isNaN(start)) {
      fail(`task '${task.id}' starts at '${spec.startText}', which is neither`
        + ` a date in '${rules.published.dateFormat}' nor 'after <id>'`, task.line);
    }
  }
  else if (spec.previous !== null) {
    resolveTask(spec.previous, byId, specs, state, rules);
    start = spec.previous.end;
  }
  else {
    fail(`task '${task.id}' has no start date and no task before it to follow;`
      + ' Mermaid would start it today, and this engine has no clock', task.line);
  }

  // --- end
  let end;
  let fromDuration = false;
  if (spec.until.length > 0) {
    end = Infinity;
    for (const id of spec.until) end = Math.min(end, need(id, 'until').start);
  }
  else {
    const at = readInstant(spec.endText, rules.readDate);
    if (!Number.isNaN(at)) {
      end = at;
    }
    else {
      const duration = parseTaskDuration(spec.endText);
      if (duration.value === null) {
        fail(`task '${task.id}' ends at '${spec.endText}', which is neither`
          + ` a date in '${rules.published.dateFormat}', a duration (3d, 1.5w, 2M)`
          + ", nor 'until <id>'", task.line);
      }
      end = addDurationTo(start, duration.value, task);
      fromDuration = true;
    }
  }

  // --- exclusions, then the span rules
  if (fromDuration) {
    const pushed = pushEndPastExclusions(start, end, rules.excluder);
    if (Number.isNaN(pushed)) {
      fail(`task '${task.id}' can never finish: 'excludes' removes every day`
        + ' it would need', task.line);
    }
    end = pushed;
  }
  if (end < start) {
    fail(`task '${task.id}' ends before it starts`, task.line);
  }
  if (end === start && !task.flags.includes('milestone')) {
    fail(`task '${task.id}' is empty; only a milestone has no width`, task.line);
  }

  task.start = start;
  task.end = end;
  task.duration = end - start;
  state.set(task, 'done');
}

/**
 * Add a Mermaid duration to an instant through the core calendar. A
 * fixed-width unit is integer milliseconds; `M` and `y` are calendar
 * additions, and the core refuses a fractional one rather than
 * approximating a month, which becomes a `JM` error here.
 * @param {number} start
 * @param {{ amount: number, unit: string }} duration
 * @param {any} task
 * @returns {number}
 */
function addDurationTo(start, duration, task) {
  try {
    const parts = addToParts(partsFromEpoch(start), duration.amount, duration.unit);
    return epochOfRFC3339Parts(parts);
  }
  catch (err) {
    return fail(`task '${task.id}' has an unusable duration: ${err.message}`, task.line);
  }
}

/**
 * The half-open span every task falls inside — the shared time domain
 * layout scales against. A schedule of one milestone has no width, so
 * it is padded to a day to stay drawable.
 * @param {any[]} sections
 * @returns {{ start: number, end: number }}
 */
function domainOf(sections) {
  let start = Infinity;
  let end = -Infinity;
  for (const section of sections) {
    for (const task of section.tasks) {
      if (task.start < start) start = task.start;
      if (task.end > end) end = task.end;
    }
  }
  if (start === Infinity) return { start: 0, end: 0 };
  if (start === end) return { start, end: end + DAY_MS };
  return { start, end };
}

//#endregion
