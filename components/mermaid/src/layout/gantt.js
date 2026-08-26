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
 * Two decisions are made here rather than in the renderer, because both
 * are geometry:
 *
 * - **Tick labels thin out.** `tickInterval 1day` over two years is 730
 *   ticks; the marks all stay, and labels are kept at the largest
 *   stride that leaves them from overlapping. The scene says which.
 * - **Row names elide.** A name wider than the label column is cut with
 *   an ellipsis at layout time, so the measured width and the drawn text
 *   are the same string.
 */

import { textWidth } from '@jarenjs/view/helpers';
import {
  compileDateFormat, axisTicksTime, timeTicksEvery, partsFromEpoch,
} from '@jarenjs/core/dates';
import { coord as round } from '../utils.js';
import { strftimeToLdml } from '../parser/gantt-grammar.js';
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

/**
 * @param {any} ast gantt AST (`parser/gantt.js`)
 * @param {{ dateNames?: import('@jarenjs/core/dates').DateNames }} [options]
 * @returns {any} PositionedDiagram
 */
export function layoutGantt(ast, options = {}) {
  const rules = ast.rules;
  const title = ast.meta.title ?? null;

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
    for (const task of section.tasks) {
      const milestone = task.flags.includes('milestone');
      const barW = milestone ? 0 : Math.max(MIN_BAR_W, xOf(task.end) - xOf(task.start));
      // a task far shorter than a pixel still has to be visible, and the
      // minimum width would otherwise push the last bar of a long
      // schedule past the right edge of its own plot
      const barX = milestone
        ? xOf((task.start + task.end) / 2)
        : Math.min(xOf(task.start), plotX + plotW - barW);
      const row = {
        index,
        id: task.id,
        name: elide(task.name, labelW - 2 * LABEL_PAD),
        line: task.line,
        start: task.start,
        end: task.end,
        milestone,
        flags: task.flags,
        after: task.after,
        y,
        h: ROW_H,
        labelX: MARGIN + LABEL_PAD,
        labelY: round(y + ROW_H / 2),
        x: round(barX),
        w: round(barW),
        barY: round(y + (ROW_H - BAR_H) / 2),
        barH: BAR_H,
        r: MILESTONE_R,
        classes: classesFor(task.flags),
      };
      rows.push(row);
      byId.set(task.id, row);
      y += ROW_H;
      index++;
    }
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
  const height = plotBottom + MARGIN;

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

  const adapted = strftimeToLdml(rules.axisFormat);
  // the parser already refused an unsupported specifier, so this compiles
  const label = compileDateFormat(adapted.value, dateNames);
  const parts = at.map((ms) => label(partsFromEpoch(ms)));

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
  const excluder = createExcluder(rules.excludes, rules.weekendStart);
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
 * @param {string[]} flags
 * @returns {string}
 */
function classesFor(flags) {
  let out = 'mm-gantt-task';
  for (const flag of flags) out += ` mm-gantt-${flag}`;
  return out;
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
