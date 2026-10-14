//@ts-check
/**
 * @file Gantt layout: a resolved schedule → a deterministic
 * `PositionedDiagram` scene. Pure, host-free and vnode-free, so the
 * geometry can be asserted without rendering anything.
 *
 * The time axis is not this file's invention: the domain comes from the
 * AST, the tick positions come from `@jarenjs/core/dates` — either the
 * document's own `tickInterval` through `timeTicksEvery`, or the shared
 * step ladder through `axisTicksTime`, the same one the chart component
 * draws its time axis with — and the tick labels come from the
 * document's `axisFormat` compiled once here. A second tick ladder in a
 * renderer would be a second set of positions.
 *
 * Four decisions are made here rather than in the renderer, because all
 * are geometry:
 *
 * - **Tick labels thin out.** `tickInterval 1day` over two years is 730
 *   ticks; the marks all stay, and labels are kept at the largest
 *   stride that leaves them from overlapping. The scene says which.
 * - **Row names elide.** A name wider than the label column is cut with
 *   an ellipsis at layout time, so the measured width and the drawn text
 *   are the same string.
 * - **Compact mode packs rows.** With `displayMode: compact` in the
 *   document's config, the tasks of a section that do not overlap in time
 *   share a row, and each name moves from the label column onto its bar.
 * - **`topAxis` repeats the labels.** The axis here is drawn above the
 *   rows; Mermaid draws it below and `topAxis` adds the other one. Both
 *   engines end up with a row of date labels on each side when it is on,
 *   so the switch adds the row that was missing here.
 *
 * Both switches are Mermaid config (`gantt.displayMode`, `gantt.topAxis`),
 * so they arrive as `options.config`; only a `topAxis` header line is in
 * the AST, as a `meta` member.
 *
 * The one URL policy lives here too: a row's `href` is the `click` link
 * that passed `sanitizeHref`, or `null`, so the renderer draws what the
 * scene says and cannot bypass the filter.
 */

import { textWidth, sanitizeHref, encodeUrlAttribute } from '@jarenjs/view/helpers';
import { axisTicksTime, timeTicksEvery } from '@jarenjs/core/dates';
import { coord as round } from '../utils.js';
import { compileAxisFormat } from '../parser/gantt-grammar.js';
import { createExcluder, DAY_MS } from '../gantt-calendar.js';

const FONT_SIZE = 13;
const MARGIN = 12;
const TITLE_H = 30;
const AXIS_H = 26;
const ROW_H = 24;
const BAR_H = 15;
const SECTION_H = 22;
const LABEL_PAD = 10;
const LABEL_MAX = 220;
const PLOT_W = 640;
const TICK_LABEL_GAP = 12;
const MILESTONE_R = 7;
const MIN_BAR_W = 2;
const LINK_INSET = 6;
const LABEL_GAP = 5;

/**
 * @param {any} ast gantt AST (`parser/gantt.js`)
 * @param {{ dateNames?: import('@jarenjs/core/dates').DateNames,
 *   config?: any }} [options] - `config` is the document's config record,
 *   whose `gantt` member holds `displayMode` and `topAxis`
 * @returns {any} PositionedDiagram
 */
export function layoutGantt(ast, options = {}) {
  const rules = ast.rules;
  const title = ast.meta.title ?? null;
  const switches = ganttSwitches(options.config, ast.meta);

  // --- the label column
  let labelW = 0;
  for (const section of ast.sections)
    for (const task of section.tasks)
      labelW = Math.max(labelW, textWidth(task.name, FONT_SIZE));
  labelW = Math.min(LABEL_MAX, Math.ceil(labelW)) + 2 * LABEL_PAD;

  const plotX = MARGIN + labelW;
  const plotW = PLOT_W;
  const width = plotX + plotW + MARGIN;

  // --- the shared time domain
  const domain = ast.domain;
  const span = domain.end - domain.start || DAY_MS;
  const xOf = (at) => round(plotX + ((at - domain.start) / span) * plotW);

  // --- the link a `click` statement puts on a task
  const hrefs = linkTargets(ast.clicks);

  // --- rows and sections, top to bottom
  const top = (title === null ? 0 : TITLE_H) + AXIS_H + MARGIN;
  const sections = [];
  const rows = [];
  /** @type {Map<string, any>} */
  const byId = new Map();
  let y = top;
  let index = 0;
  for (let si = 0; si < ast.sections.length; si++) {
    const section = ast.sections[si];
    const named = section.name !== null && section.name !== '';
    const sectionTop = y;
    if (named) y += SECTION_H;
    const rowsTop = y;
    const laneOf = switches.compact ? packLanes(section.tasks) : null;
    let laneCount = 0;
    for (let ti = 0; ti < section.tasks.length; ti++) {
      const task = section.tasks[ti];
      const lane = laneOf === null ? ti : laneOf[ti];
      laneCount = Math.max(laneCount, lane + 1);
      const rowY = rowsTop + lane * ROW_H;
      const milestone = task.flags.includes('milestone');
      const barW = milestone ? 0 : Math.max(MIN_BAR_W, xOf(task.end) - xOf(task.start));
      // a task far shorter than a pixel still has to be visible, and the
      // minimum width would otherwise push the last bar of a long
      // schedule past the right edge of its own plot
      const barX = milestone
        ? xOf((task.start + task.end) / 2)
        : Math.min(xOf(task.start), plotX + plotW - barW);
      const x = round(barX);
      const w = round(barW);
      const href = hrefs.get(task.id) ?? null;
      // a milestone is a diamond centred on its instant, so its span is the diamond's
      const label = switches.compact
        ? placeLabel(task.name, milestone ? x - MILESTONE_R : x, milestone ? x + MILESTONE_R : x + w,
          width - MARGIN)
        : {
          name: elide(task.name, labelW - 2 * LABEL_PAD),
          labelX: MARGIN + LABEL_PAD,
          labelAnchor: 'start',
        };
      const row = {
        index,
        id: task.id,
        name: label.name,
        line: task.line,
        start: task.start,
        end: task.end,
        milestone,
        flags: task.flags,
        after: task.after,
        lane,
        y: rowY,
        h: ROW_H,
        labelX: label.labelX,
        labelAnchor: label.labelAnchor,
        labelY: round(rowY + ROW_H / 2),
        x,
        w,
        barY: round(rowY + (ROW_H - BAR_H) / 2),
        barH: BAR_H,
        r: MILESTONE_R,
        href,
        classes: classesFor(task.flags, href !== null),
      };
      rows.push(row);
      byId.set(task.id, row);
      index++;
    }
    y = rowsTop + laneCount * ROW_H;
    sections.push({
      name: named ? section.name : null,
      index: si,
      y: sectionTop,
      h: y - sectionTop,
      labelY: round(sectionTop + SECTION_H / 2),
      band: si % 2 === 1,
    });
  }
  const plotBottom = Math.max(y, top);
  // the second row of labels hangs under the plot with the same gap the
  // first one has above it
  const bottomAxis = switches.topAxis
    ? { y: plotBottom, labelY: plotBottom + MARGIN + 8 }
    : null;
  const height = plotBottom + MARGIN + (bottomAxis === null ? 0 : AXIS_H);

  // --- ticks, positions from the core kernel and labels from axisFormat
  const ticks = planTicks(domain, rules, xOf, options.dateNames);
  // --- excluded days, as shaded bands clipped to the domain
  const bands = planBands(domain, rules, xOf);
  // --- dependency anchors
  const links = planLinks(rows, byId);

  return {
    kind: 'gantt',
    width,
    height,
    fontSize: FONT_SIZE,
    title,
    domain,
    plot: { x: plotX, y: top, w: plotW, h: plotBottom - top },
    axisY: (title === null ? 0 : TITLE_H) + AXIS_H,
    bottomAxis,
    compact: switches.compact,
    titleY: title === null ? 0 : 22,
    labelWidth: labelW,
    ticks,
    bands,
    sections,
    rows,
    links,
  };
}

/**
 * The two Mermaid config switches this layout reads, from the document's
 * config as Mermaid reads them: `displayMode` must be exactly `compact`,
 * and `topAxis` is a JavaScript truthiness test, so the string `"false"`
 * turns it on. A `gantt` member that is not an object holds neither. A
 * `topAxis` header line, kept in the AST's `meta`, turns the second axis
 * on too.
 * @param {any} config
 * @param {Record<string, string>} meta
 * @returns {{ compact: boolean, topAxis: boolean }}
 */
function ganttSwitches(config, meta) {
  const line = meta.topAxis !== undefined;
  const gantt = config?.gantt;
  if (gantt === null || typeof gantt !== 'object') return { compact: false, topAxis: line };
  return { compact: gantt.displayMode === 'compact', topAxis: line || Boolean(gantt.topAxis) };
}

/**
 * The row of each task when a section is packed: tasks in start order
 * (source order breaking ties), each into the first row whose last task
 * has ended by its start, so a task starting the instant another ends
 * shares its row. First-fit by scanning the rows is quadratic in the
 * rows; two heaps — rows in use by the time they free up, rows free by
 * their number — give the same answer in n log n.
 * @param {{ start: number, end: number }[]} tasks
 * @returns {number[]} the row per task, in the tasks' own order
 */
function packLanes(tasks) {
  const order = tasks.map((_, i) => i).sort((a, b) => tasks[a].start - tasks[b].start || a - b);
  /** @type {{ end: number, lane: number }[]} */
  const busy = [];
  /** @type {number[]} */
  const free = [];
  const byEnd = (a, b) => a.end - b.end || a.lane - b.lane;
  const byLane = (a, b) => a - b;
  const lanes = new Array(tasks.length);
  let opened = 0;
  for (const i of order) {
    const { start, end } = tasks[i];
    while (busy.length > 0 && busy[0].end <= start) heapPush(free, heapPop(busy, byEnd).lane, byLane);
    const lane = free.length > 0 ? heapPop(free, byLane) : opened++;
    lanes[i] = lane;
    heapPush(busy, { end, lane }, byEnd);
  }
  return lanes;
}

/**
 * @template T
 * @param {T[]} heap
 * @param {T} item
 * @param {(a: T, b: T) => number} cmp
 */
function heapPush(heap, item, cmp) {
  let i = heap.length;
  heap.push(item);
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (cmp(heap[parent], item) <= 0) break;
    heap[i] = heap[parent];
    i = parent;
  }
  heap[i] = item;
}

/**
 * @template T
 * @param {T[]} heap non-empty
 * @param {(a: T, b: T) => number} cmp
 * @returns {T}
 */
function heapPop(heap, cmp) {
  const top = heap[0];
  const last = /** @type {T} */ (heap.pop());
  if (heap.length > 0) {
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= heap.length) break;
      if (child + 1 < heap.length && cmp(heap[child + 1], heap[child]) < 0) child++;
      if (cmp(last, heap[child]) <= 0) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = last;
  }
  return top;
}

/**
 * Where a compact row's name goes, by Mermaid's rule: centred on the bar
 * when it fits, otherwise after the bar, otherwise — when that would run
 * off the right edge — before it. Only a name placed before its bar is cut
 * (to the room left of the bar), so it cannot leave the diagram; Mermaid
 * cuts nothing, and a name that fits is drawn whole.
 * @param {string} name
 * @param {number} left - the bar's left edge
 * @param {number} right - the bar's right edge
 * @param {number} limit - the right-most x a name may reach
 * @returns {{ name: string, labelX: number, labelAnchor: 'start' | 'middle' | 'end' }}
 */
function placeLabel(name, left, right, limit) {
  const wide = textWidth(name, FONT_SIZE);
  if (wide <= right - left) return { name, labelX: round((left + right) / 2), labelAnchor: 'middle' };
  if (right + LABEL_GAP + wide > limit) {
    return {
      name: elide(name, left - LABEL_GAP - MARGIN),
      labelX: round(left - LABEL_GAP),
      labelAnchor: 'end',
    };
  }
  return { name, labelX: round(right + LABEL_GAP), labelAnchor: 'start' };
}

/**
 * Tick positions and the labels that survive collision.
 * @param {{ start: number, end: number }} domain
 * @param {any} rules
 * @param {(at: number) => number} xOf
 * @param {any} dateNames
 * @returns {any[]}
 */
function planTicks(domain, rules, xOf, dateNames) {
  const at = rules.tick === null
    ? axisTicksTime(domain.start, domain.end, Math.max(2, Math.round(PLOT_W / 110)))
    : timeTicksEvery(domain.start, domain.end, rules.tick.unit, rules.tick.amount,
      { weekStart: rules.weekStart });

  // the parser already refused an unsupported specifier, so this compiles
  const parts = at.map(compileAxisFormat(rules.axisFormat, dateNames));

  // keep every `stride`-th label, the smallest stride that fits
  let widest = 0;
  for (const text of parts) widest = Math.max(widest, textWidth(text, FONT_SIZE - 1));
  const need = widest + TICK_LABEL_GAP;
  const step = at.length > 1 ? Math.abs(xOf(at[1]) - xOf(at[0])) : need;
  const stride = step >= need ? 1 : Math.max(1, Math.ceil(need / Math.max(step, 0.5)));

  return at.map((ms, i) => ({
    at: ms,
    x: xOf(ms),
    label: i % stride === 0 ? parts[i] : null,
  }));
}

/**
 * The excluded days, as bands over the domain. Rebuilt from the AST's
 * published rules rather than carried through it, because a working
 * calendar is a closure and the AST is plain JSON.
 * @param {{ start: number, end: number }} domain
 * @param {any} rules
 * @param {(at: number) => number} xOf
 * @returns {any[]}
 */
function planBands(domain, rules, xOf) {
  const excluder = createExcluder(rules.excludes, rules.weekendStart, rules.includes?.days);
  if (!excluder.any) return [];
  const fromDay = Math.floor(domain.start / DAY_MS);
  const toDay = Math.ceil(domain.end / DAY_MS);
  // a domain wider than a few years shades nothing: the bands would be
  // narrower than a hairline and the answer is the axis, not stripes
  if (toDay - fromDay > 1200) return [];
  return excluder.intervalsIn(fromDay, toDay).map((span) => {
    const start = Math.max(span.start, domain.start);
    const end = Math.min(span.end, domain.end);
    return { start, end, x: xOf(start), w: round(Math.max(0, xOf(end) - xOf(start))) };
  }).filter((band) => band.w > 0);
}

/**
 * One orthogonal connector per `after` dependency: out of the
 * predecessor's right edge, across, and into this row's left edge.
 * @param {any[]} rows
 * @param {Map<string, any>} byId
 * @returns {any[]}
 */
function planLinks(rows, byId) {
  const links = [];
  for (const row of rows) {
    for (const id of row.after) {
      const from = byId.get(id);
      if (from === undefined || from.index >= row.index) continue;
      const x1 = round(from.milestone ? from.x + from.r : from.x + from.w);
      const y1 = round(from.y + from.h / 2);
      const x2 = round(row.milestone ? row.x - row.r : row.x);
      const y2 = round(row.y + row.h / 2);
      if (Math.abs(x2 - x1) < 1) {
        // the successor starts where its predecessor ended: a straight
        // drop reads as "immediately after", a hook reads as a delay
        links.push({ from: id, to: row.id, points: [[x1, y1], [x1, y2]] });
        continue;
      }
      const mid = round(Math.max(x1 + LINK_INSET, x2 - LINK_INSET));
      links.push({ from: id, to: row.id, points: [[x1, y1], [mid, y1], [mid, y2], [x2, y2]] });
    }
  }
  return links;
}

/**
 * The link each task id carries: the last `click ... href` that names it,
 * as Mermaid keeps one, and only when the URL passes the allow-list every
 * Mermaid link goes through. An unsafe or relative-without-a-dot URL leaves
 * the task without a link, and an earlier safe one does not come back. A
 * `call` puts nothing here: it is recorded in the AST and never drawn.
 * @param {{ ids: string[], href: string | null }[] | undefined} clicks
 * @returns {Map<string, string | null>} an id to its attribute-ready URL, or `null`
 */
function linkTargets(clicks) {
  /** @type {Map<string, string | null>} */
  const targets = new Map();
  for (const click of clicks ?? []) {
    if (click.href === null) continue;
    const safe = sanitizeHref(click.href);
    const url = safe === null ? null : encodeUrlAttribute(safe);
    for (const id of click.ids) targets.set(id, url);
  }
  return targets;
}

/**
 * @param {string[]} flags
 * @param {boolean} linked - the task carries a link
 * @returns {string}
 */
function classesFor(flags, linked) {
  let out = 'mm-gantt-task';
  for (const flag of flags) out += ` mm-gantt-${flag}`;
  return linked ? out + ' mm-gantt-clickable' : out;
}

/**
 * Cut a name to the label column, measuring the string that will
 * actually be drawn.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function elide(text, max) {
  if (textWidth(text, FONT_SIZE) <= max) return text;
  let cut = text.length;
  while (cut > 1 && textWidth(text.slice(0, cut) + '…', FONT_SIZE) > max) cut--;
  return text.slice(0, cut) + '…';
}
