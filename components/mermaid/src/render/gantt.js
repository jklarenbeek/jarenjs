//@ts-check
/**
 * @file Gantt renderer: a positioned schedule → pure-vnode SVG. A real
 * timeline — an aligned time axis, section bands, task bars, milestone
 * diamonds, dependency connectors and shaded excluded days — where the
 * engine used to draw a list of strings in a box.
 *
 * It imports `@jarenjs/core` and `@jarenjs/view` and nothing else: the
 * tick ladder is core's, so this file acquires no dependency on the
 * chart component to draw a time axis.
 *
 * Accessibility: the root carries a `<title>` (the diagram's own title,
 * or a generic one) and a `<desc>` naming the span and the task count,
 * so a screen reader gets the shape of the schedule rather than a
 * hundred unlabelled rectangles. Bars carry `data-id` and a status
 * class, which is also what an interactive host hit-tests on.
 */

import { svgRoot, group, rect, path, polygon, textAt, num } from '@jarenjs/view/helpers';
import { compileDateFormat, partsFromEpoch } from '@jarenjs/core/dates';

// the summary line is a date range, and it is the one label on the
// diagram that is NOT the document's axisFormat: it must stay readable
// when the axis is showing bare month numbers
const SUMMARY_DATE = compileDateFormat('yyyy-MM-dd');

/**
 * @param {any} scene PositionedDiagram (gantt)
 * @param {{ tokens: Record<string,string>, cssVars: Record<string,string> }} theme
 * @param {string} hash
 * @returns {any}
 */
export function renderGantt(scene, theme, hash) {
  const t = theme.tokens;
  const fs = scene.fontSize;
  const children = [];
  const plot = scene.plot;

  children.push(['title', {}, titleText(scene)]);
  children.push(['desc', {}, descText(scene)]);

  // Section bands (behind everything).
  for (const section of scene.sections) {
    if (!section.band) continue;
    children.push(rect(0, section.y, scene.width, section.h, {
      class: 'mm-gantt-band', fill: t.clusterFill, key: 'band-' + section.index,
    }));
  }

  // Excluded days.
  for (let i = 0; i < scene.bands.length; i++) {
    const band = scene.bands[i];
    children.push(rect(band.x, plot.y, band.w, plot.h, {
      class: 'mm-gantt-excluded', fill: t.activationFill, key: 'excl-' + i,
    }));
  }

  // Grid lines and axis labels.
  for (let i = 0; i < scene.ticks.length; i++) {
    const tick = scene.ticks[i];
    children.push(path(`M${num(tick.x)},${num(plot.y)} V${num(plot.y + plot.h)}`, {
      class: 'mm-gantt-grid', stroke: t.clusterStroke, 'stroke-width': 1, key: 'grid-' + i,
    }));
    if (tick.label !== null) {
      children.push(textAt(tick.x, scene.axisY - 8, tick.label, fs - 1, {
        class: 'mm-gantt-tick', 'text-anchor': 'middle', fill: t.nodeText, key: 'tick-' + i,
      }));
    }
  }
  children.push(path(`M${num(plot.x)},${num(plot.y)} H${num(plot.x + plot.w)}`, {
    class: 'mm-gantt-axis', stroke: t.lineColor, 'stroke-width': 1,
  }));

  // Dependency connectors, under the bars.
  for (let i = 0; i < scene.links.length; i++) {
    const link = scene.links[i];
    children.push(path(polyline(link.points), {
      class: 'mm-gantt-link', fill: 'none', stroke: t.lineColor,
      'stroke-width': 1, 'stroke-dasharray': '3 3', key: 'link-' + i,
    }));
  }

  // Section headings.
  for (const section of scene.sections) {
    if (section.name === null) continue;
    children.push(textAt(0 + 12, section.labelY + 4, section.name, fs, {
      class: 'mm-gantt-section', 'font-weight': 'bold', fill: t.nodeText,
      key: 'sect-' + section.index,
    }));
  }

  // Rows: the name, then the bar or the milestone.
  for (const row of scene.rows) {
    children.push(group({ class: row.classes, key: 'row-' + row.id, 'data-id': row.id }, [
      textAt(row.labelX, row.labelY + 4, row.name, fs, {
        class: 'mm-gantt-label', fill: t.nodeText,
      }),
      row.milestone
        ? polygon(diamond(row.x, row.labelY, row.r), {
          class: 'mm-gantt-shape', fill: fillFor(row.flags, t), stroke: strokeFor(row.flags, t),
          'stroke-width': 1,
        })
        : rect(row.x, row.barY, row.w, row.barH, {
          class: 'mm-gantt-shape', rx: 3, fill: fillFor(row.flags, t),
          stroke: strokeFor(row.flags, t), 'stroke-width': 1,
        }),
    ]));
  }

  // The title last, so nothing paints over it.
  if (scene.title !== null) {
    children.push(textAt(12, scene.titleY, scene.title, fs + 3, {
      class: 'mm-gantt-title', 'font-weight': 'bold', fill: t.nodeText,
    }));
  }

  return svgRoot('mermaid mm-svg mm-gantt', scene.width, scene.height, theme, children,
    'mmgantt-' + hash, { fit: false });
}

/**
 * A task's fill: `crit` is the warning ink, `done` the muted panel and
 * `active` the accent, which is the precedence Mermaid documents.
 * @param {string[]} flags @param {Record<string,string>} t
 * @returns {string}
 */
function fillFor(flags, t) {
  if (flags.includes('crit')) return t.noteFill;
  if (flags.includes('done')) return t.activationFill;
  return t.nodeFill;
}

/** @param {string[]} flags @param {Record<string,string>} t @returns {string} */
function strokeFor(flags, t) {
  if (flags.includes('crit')) return t.noteStroke;
  if (flags.includes('done')) return t.activationStroke;
  return t.nodeStroke;
}

/** @param {number[][]} points @returns {string} */
function polyline(points) {
  let d = '';
  for (let i = 0; i < points.length; i++)
    d += (i === 0 ? 'M' : 'L') + num(points[i][0]) + ',' + num(points[i][1]) + ' ';
  return d.trim();
}

/** @param {number} cx @param {number} cy @param {number} r @returns {{x:number,y:number}[]} */
function diamond(cx, cy, r) {
  return [
    { x: cx, y: cy - r }, { x: cx + r, y: cy },
    { x: cx, y: cy + r }, { x: cx - r, y: cy },
  ];
}

/** @param {any} scene @returns {string} */
function titleText(scene) {
  return scene.title === null ? 'Gantt chart' : `Gantt chart: ${scene.title}`;
}

/** @param {any} scene @returns {string} */
function descText(scene) {
  const count = scene.rows.length;
  const tasks = `${count} task${count === 1 ? '' : 's'}`;
  if (count === 0) return 'An empty schedule.';
  const from = SUMMARY_DATE(partsFromEpoch(scene.domain.start));
  const to = SUMMARY_DATE(partsFromEpoch(scene.domain.end));
  return `${tasks} from ${from} to ${to}.`;
}
