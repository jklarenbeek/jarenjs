//@ts-check
/**
 * @file The two Gantt switches that live in the diagram's config rather
 * than in its body: `topAxis` (a second row of date labels) and
 * `displayMode: compact` (tasks that do not overlap share a row). Every
 * expected lane, order and count was read from the render of the
 * Mermaid version `fixtures/gantt-grammar.json` names, driven through
 * its own database and renderer; the geometry is this engine's own and
 * is pinned as exact numbers against its layout constants.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMermaid, toMermaid, layoutDiagram, renderMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';
import { textWidth } from '@jarenjs/view/helpers';

import { layoutGantt } from '../../components/mermaid/src/layout/gantt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAMMAR = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'gantt-grammar.json'), 'utf8'));

const COMPACT = '---\ndisplayMode: compact\n---\n';
const BODY = 'gantt\ndateFormat YYYY-MM-DD\n';

/** Two sections; Mermaid packs A into lanes 0,1,0 and B into lane 0. */
const TWO_SECTIONS = BODY
  + 'section A\nt1 : a1, 2024-01-01, 3d\nt2 : a2, 2024-01-02, 2d\nt3 : a3, 2024-01-04, 2d\n'
  + 'section B\nu1 : b1, 2024-01-01, 5d';

/** Ties, a milestone, and a weekend push; the lanes are Mermaid's. */
const TIES = BODY + 'excludes weekends\n'
  + 'section A\n'
  + 'w1 : w1, 2024-01-04, 3d\n'
  + 'w2 : w2, 2024-01-08, 1d\n'
  + 'w3 : w3, 2024-01-04, 2d\n'
  + 'm1 : milestone, m1, 2024-01-06, 0d\n'
  + 'section B\n'
  + 'x1 : x1, 2024-01-01, 2d\n'
  + 'x2 : x2, 2024-01-01, 1d\n'
  + 'x3 : x3, 2024-01-02, 1d';

/** @param {string} source @returns {any} */
const scene = (source) => layoutDiagram(parseMermaid(source));

/** @param {any} s @returns {Record<string, number>} */
const lanes = (s) => Object.fromEntries(s.rows.map((r) => [r.id, r.lane]));

//#region where the switches are read from ---------------------------

describe('displayMode is a front-matter key that lands in the gantt config', () => {
  it('should copy a top-level displayMode into config.gantt, as Mermaid does', () => {
    assert.deepStrictEqual(parseMermaid(COMPACT + TWO_SECTIONS).config,
      { gantt: { displayMode: 'compact' } });
  });

  it('should let the top-level key win over config.gantt.displayMode', () => {
    const doc = parseMermaid('---\ndisplayMode: compact\nconfig:\n  gantt:\n'
      + '    displayMode: normal\n    topAxis: true\n---\n' + TWO_SECTIONS);
    assert.deepStrictEqual(doc.config, { gantt: { displayMode: 'compact', topAxis: true } });
  });

  it('should let an init directive win over the front matter', () => {
    const doc = parseMermaid(COMPACT + '%%{init: {"gantt": {"displayMode": ""}}}%%\n' + TWO_SECTIONS);
    assert.strictEqual(doc.config.gantt.displayMode, '');
    assert.strictEqual(layoutDiagram(doc).compact, false);
  });

  it('should write nothing for a falsy displayMode, and keep a non-string as its text', () => {
    assert.deepStrictEqual(parseMermaid('---\ndisplayMode: 0\n---\n' + TWO_SECTIONS).config, {});
    assert.deepStrictEqual(parseMermaid('---\ndisplayMode: 1\n---\n' + TWO_SECTIONS).config,
      { gantt: { displayMode: '1' } });
  });

  it('should print back as an init directive that parses to the same config', () => {
    const doc = parseMermaid(COMPACT + TWO_SECTIONS);
    const again = parseMermaid(toMermaid(doc));
    assert.deepStrictEqual(again.config, doc.config);
    assert.deepStrictEqual(layoutDiagram(again), layoutDiagram(doc));
    assert.strictEqual(layoutDiagram(again).compact, true);
  });

  it('should leave a body line "displayMode: compact" a task row, which fails as it does in Mermaid', () => {
    assert.throws(() => parseMermaid(BODY + 'displayMode: compact\nsection A\nt1 : a1, 2024-01-01, 3d'),
      (err) => err.line === 3 && /no start date/.test(err.message));
    assert.throws(() => parseMermaid(BODY + 'section A\nt1 : a1, 2024-01-01, 3d\ndisplayMode: compact'),
      (err) => err.line === 5 && /neither a date/.test(err.message));
  });
});

describe('a bare topAxis header line is honoured, where Mermaid fails on it', () => {
  const LINE = BODY + 'topAxis\nsection A\nt1 : a1, 2024-01-01, 3d';

  it('should keep the line in meta and turn the second axis on', () => {
    const doc = parseMermaid(LINE);
    assert.strictEqual(doc.ast.meta.topAxis, '');
    assert.strictEqual(typeof layoutDiagram(doc).bottomAxis?.labelY, 'number');
  });

  it('should draw what the config route draws', () => {
    const viaConfig = scene('%%{init: {"gantt": {"topAxis": true}}}%%\n' + BODY
      + 'section A\nt1 : a1, 2024-01-01, 3d');
    // the rows differ only in the source line the extra header shifts
    const unlined = (sc) => ({ ...sc, rows: sc.rows.map(({ line: _line, ...rest }) => rest) });
    assert.deepStrictEqual(unlined(scene(LINE)), unlined(viaConfig));
  });

  it('should print back and read again as the same diagram', () => {
    const doc = parseMermaid(LINE);
    assert.match(toMermaid(doc), /^topAxis$/m);
    assert.deepStrictEqual(parseMermaid(toMermaid(doc)).ast, doc.ast);
  });

  it('should ignore a trailing comment and anything else after the word', () => {
    assert.strictEqual(parseMermaid(BODY + 'topAxis %% on\nsection A\nt : a, 2024-01-01, 1d')
      .ast.meta.topAxis, '');
    assert.notStrictEqual(scene(BODY + 'topAxis extra\nsection A\nt : a, 2024-01-01, 1d')
      .bottomAxis, null);
  });

  it('should leave a diagram without the line on one row of labels', () => {
    assert.strictEqual(parseMermaid(TWO_SECTIONS).ast.meta.topAxis, undefined);
    assert.strictEqual(scene(TWO_SECTIONS).bottomAxis, null);
  });

  it('should keep a row that merely starts with the word', () => {
    const doc = parseMermaid(BODY + 'section A\ntopAxis support : t1, 2024-01-01, 3d');
    assert.strictEqual(doc.ast.sections[0].tasks[0].name, 'topAxis support');
    assert.strictEqual(layoutDiagram(doc).bottomAxis, null);
  });
});

//#endregion
//#region topAxis ----------------------------------------------------

describe('topAxis draws the date labels a second time', () => {
  const plain = scene(TWO_SECTIONS);
  const INIT = '%%{init: {"gantt": {"topAxis": true}}}%%\n';

  it('should draw one row of labels without the switch', () => {
    assert.strictEqual(plain.bottomAxis, null);
  });

  it('should add a bottom row of labels and the height it needs', () => {
    const both = scene(INIT + TWO_SECTIONS);
    assert.strictEqual(both.height - plain.height, 26);
    assert.deepStrictEqual(both.bottomAxis, {
      y: plain.plot.y + plain.plot.h,
      labelY: plain.plot.y + plain.plot.h + 20,
    });
    assert.deepStrictEqual(both.ticks, plain.ticks, 'same ticks, same labels');
    assert.deepStrictEqual(both.rows, plain.rows, 'the rows do not move');
  });

  it('should read the switch as JavaScript truthiness, as Mermaid does', () => {
    const on = (value) => scene(`%%{init: {"gantt": {"topAxis": ${value}}}}%%\n${TWO_SECTIONS}`)
      .bottomAxis !== null;
    assert.strictEqual(on('true'), true);
    assert.strictEqual(on('"false"'), true, 'the string "false" is truthy');
    assert.strictEqual(on('1'), true);
    assert.strictEqual(on('false'), false);
    assert.strictEqual(on('0'), false);
    assert.strictEqual(on('""'), false);
    assert.strictEqual(on('null'), false);
  });

  it('should read it from front-matter config too', () => {
    const doc = '---\nconfig:\n  gantt:\n    topAxis: true\n---\n' + TWO_SECTIONS;
    assert.strictEqual(typeof scene(doc).bottomAxis?.labelY, 'number');
  });

  it('should not mistake a config that is not an object for the switch', () => {
    assert.strictEqual(scene('%%{init: {"gantt": 5}}%%\n' + TWO_SECTIONS).bottomAxis, null);
    assert.strictEqual(scene('%%{init: {"gantt": null}}%%\n' + TWO_SECTIONS).bottomAxis, null);
    assert.strictEqual(scene('%%{init: {"gantt": ["topAxis"]}}%%\n' + TWO_SECTIONS).bottomAxis, null);
  });

  it('should render every surviving tick label twice', () => {
    const labels = (src) => (renderToString(renderMermaid(src)).match(/mm-gantt-tick/g) ?? []).length;
    const once = labels(TWO_SECTIONS);
    assert.ok(once >= 2);
    assert.strictEqual(labels(INIT + TWO_SECTIONS), 2 * once);
    const svg = renderToString(renderMermaid(INIT + TWO_SECTIONS));
    assert.strictEqual((svg.match(/mm-gantt-axis"/g) ?? []).length, 2, 'one axis line per row of labels');
  });

  it('should draw the bottom labels under the last row', () => {
    const both = scene(INIT + TWO_SECTIONS);
    const svg = renderToString(renderMermaid(INIT + TWO_SECTIONS));
    const at = [...svg.matchAll(/class="mm-gantt-tick"[^>]*?\sy="([^"]+)"|\sy="([^"]+)"[^>]*?class="mm-gantt-tick"/g)]
      .map((m) => Number(m[1] ?? m[2]));
    assert.deepStrictEqual([...new Set(at)].sort((a, b) => a - b),
      [both.axisY - 8, both.bottomAxis.labelY]);
  });
});

//#endregion
//#region displayMode: compact ---------------------------------------

describe('compact mode packs the tasks of a section into the fewest rows', () => {
  it('should leave every task on its own row without the switch', () => {
    const normal = scene(TWO_SECTIONS);
    assert.strictEqual(normal.compact, false);
    assert.deepStrictEqual(lanes(normal), { a1: 0, a2: 1, a3: 2, b1: 0 });
    assert.deepStrictEqual(normal.rows.map((r) => r.y), [60, 84, 108, 154]);
  });

  it('should reuse a row once its task has ended, exactly where Mermaid does', () => {
    const compact = scene(COMPACT + TWO_SECTIONS);
    assert.strictEqual(compact.compact, true);
    // Mermaid: a1, a2, a3, b1 at rows 0, 1, 0 and 2 of the whole chart;
    // a3 starts the instant a1 ends, and that is enough to share its row
    assert.deepStrictEqual(lanes(compact), { a1: 0, a2: 1, a3: 0, b1: 0 });
    assert.deepStrictEqual(compact.rows.map((r) => r.y), [60, 84, 60, 130]);
    assert.deepStrictEqual(compact.sections.map((s) => [s.y, s.h]), [[38, 70], [108, 46]]);
    assert.strictEqual(compact.height, 166);
    assert.strictEqual(compact.plot.h, 154 - 38);
  });

  it('should break ties by source order and use the end Mermaid uses', () => {
    const compact = scene(COMPACT + TIES);
    // Mermaid: w1 0, w3 1, m1 2, w2 1 in A (w3 is pushed past the
    // weekend, so the milestone cannot take its row); x1 0, x2 1, x3 1 in B
    assert.deepStrictEqual(lanes(compact),
      { w1: 0, w2: 1, w3: 1, m1: 2, x1: 0, x2: 1, x3: 1 });
  });

  it('should pack every section from lane zero, and size it by its lanes', () => {
    const compact = scene(COMPACT + TIES);
    assert.deepStrictEqual(compact.sections.map((s) => s.h), [22 + 3 * 24, 22 + 2 * 24]);
    const [a, b] = compact.sections;
    assert.strictEqual(b.y, a.y + a.h);
  });

  it('should let a 0-length milestone share the row of a task that ended at it', () => {
    const s = scene(COMPACT + BODY + 'section A\nt1 : a1, 2024-01-01, 2d\n'
      + 'm : milestone, m1, 2024-01-03, 0d\nt2 : a2, 2024-01-03, 1d');
    assert.deepStrictEqual(lanes(s), { a1: 0, m1: 0, a2: 0 });
  });

  it('should keep the rows in source order, whatever the packing order', () => {
    const compact = scene(COMPACT + BODY + 'section A\nlate : l1, 2024-01-05, 1d\n'
      + 'early : e1, 2024-01-01, 1d');
    assert.deepStrictEqual(compact.rows.map((r) => r.id), ['l1', 'e1']);
    assert.deepStrictEqual(lanes(compact), { l1: 0, e1: 0 });
  });

  it('should pack a section on its own and keep it in place, whatever its name', () => {
    // Mermaid groups by name: the second "A" would pack with the first
    // (p2 on row 1 of A) and the section named 2024 would come first
    const same = scene(COMPACT + BODY + 'section A\np1 : p1, 2024-01-01, 3d\n'
      + 'section B\nq1 : q1, 2024-01-01, 3d\nsection A\np2 : p2, 2024-01-01, 3d');
    assert.deepStrictEqual(lanes(same), { p1: 0, q1: 0, p2: 0 });
    assert.deepStrictEqual(same.sections.map((s) => s.name), ['A', 'B', 'A']);
    const numeric = scene(COMPACT + BODY + 'section Beta\nq1 : q1, 2024-01-01, 3d\n'
      + 'section 2024\nn1 : n1, 2024-01-01, 3d');
    assert.deepStrictEqual(numeric.rows.map((r) => [r.id, r.y]), [['q1', 60], ['n1', 106]]);
  });

  it('should read the switch strictly: only the exact word "compact"', () => {
    for (const word of ['Compact', 'compacted', ' ']) {
      const s = scene(`%%{init: {"gantt": {"displayMode": "${word}"}}}%%\n` + TWO_SECTIONS);
      assert.strictEqual(s.compact, false, word);
    }
    assert.strictEqual(scene('%%{init: {"gantt": {"displayMode": "compact"}}}%%\n' + TWO_SECTIONS)
      .compact, true);
  });

  it('should work together with topAxis', () => {
    const both = scene('---\nconfig:\n  gantt:\n    topAxis: true\n    displayMode: compact\n---\n'
      + TWO_SECTIONS);
    assert.strictEqual(both.compact, true);
    assert.strictEqual(typeof both.bottomAxis?.labelY, 'number');
    assert.deepStrictEqual(lanes(both), { a1: 0, a2: 1, a3: 0, b1: 0 });
  });

  it('should hand the same scene to a host through layoutDiagram and the renderer', () => {
    const doc = parseMermaid(COMPACT + TWO_SECTIONS);
    assert.deepStrictEqual(layoutDiagram(doc), layoutGantt(doc.ast, { config: doc.config }));
    assert.strictEqual(layoutDiagram(doc).compact, true);
    const svg = renderToString(renderMermaid(COMPACT + TWO_SECTIONS));
    assert.match(svg, /data-id="a3"/);
  });

  it('should stay near-linear in the number of tasks that overlap', () => {
    // every task starts the same day, so n tasks need n rows: a first-fit
    // scan over the rows is quadratic here, the heap is n log n
    const build = (n) => COMPACT + BODY + 'section S\n'
      + Array.from({ length: n }, (_, i) => `T${i} : t${i}, 2024-01-01, 400d`).join('\n');
    const small = parseMermaid(build(500));
    const large = parseMermaid(build(4000));
    // `layoutDiagram` memoizes per document, so time the layout itself
    const time = (doc) => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = process.hrtime.bigint();
        layoutGantt(doc.ast, { config: doc.config });
        best = Math.min(best, Number(process.hrtime.bigint() - t0));
      }
      return best;
    };
    assert.strictEqual(layoutDiagram(large).rows.at(-1).lane, 3999);
    const growth = time(large) / time(small);
    assert.ok(growth < 24, `8x the tasks took ${growth.toFixed(1)}x (quadratic would be ~64x)`);
  });
});

describe('compact mode names a task on its bar', () => {
  const wide = scene(COMPACT + BODY + 'section A\n'
    + 'Roomy : r1, 2024-01-01, 20d\n'
    + 'A rather long name for so short a bar : s1, 2024-01-10, 1d\n'
    + 'Edge task with a long name : e1, 2024-01-20, 1d');
  const byId = Object.fromEntries(wide.rows.map((r) => [r.id, r]));
  const edge = scene(COMPACT + BODY + 'section A\n'
    + 'Roomy : r1, 2024-01-01, 20d\n'
    + 'A long name on a short last bar : z1, 2024-01-21, 1d');

  it('should centre a name that fits inside its bar', () => {
    const r = byId.r1;
    assert.strictEqual(r.labelAnchor, 'middle');
    assert.strictEqual(r.labelX, Math.round((r.x + r.w / 2) * 100) / 100);
  });

  it('should keep a long name whole when it fits on a long bar', () => {
    const name = 'A name of more than forty characters, so long that the label column would cut it';
    const long = scene(COMPACT + BODY + 'section A\n' + name + ' : l1, 2024-01-01, 25d\n'
      + 'Tail : l2, 2024-01-30, 1d');
    const r = long.rows[0];
    assert.ok(textWidth(name, 13) > long.labelWidth, 'wider than the label column');
    assert.ok(textWidth(name, 13) <= r.w);
    assert.strictEqual(r.name, name);
    assert.strictEqual(r.labelAnchor, 'middle');
  });

  it('should cut a name only to the room left before a bar it has to precede', () => {
    const name = 'abcdefghij '.repeat(12).trim();
    const tight = scene(COMPACT + BODY + 'section A\nLong first : f1, 2024-01-01, 28d\n'
      + name + ' : z1, 2024-01-02, 1d');
    const r = tight.rows[1];
    assert.ok(textWidth(name, 13) > tight.plot.w, 'wider than the whole plot');
    assert.strictEqual(r.labelAnchor, 'end');
    assert.match(r.name, /^abcdefghij .*…$/);
    assert.ok(r.labelX - textWidth(r.name, 13) >= 12, 'stays inside the left margin');
  });

  it('should put a name wider than its bar after the bar', () => {
    const r = byId.s1;
    assert.ok(textWidth(r.name, 13) > r.w);
    assert.strictEqual(r.labelAnchor, 'start');
    assert.strictEqual(r.labelX, r.x + r.w + 5);
  });

  it('should put it before the bar when it would run off the right edge', () => {
    const r = edge.rows[1];
    assert.ok(r.x + r.w + 5 + textWidth(r.name, 13) > edge.width - 12);
    assert.strictEqual(r.labelAnchor, 'end');
    assert.strictEqual(r.labelX, r.x - 5);
  });

  it('should keep the label column for names in the normal mode', () => {
    const normal = scene(BODY + 'section A\nRoomy : r1, 2024-01-01, 20d');
    assert.strictEqual(normal.rows[0].labelAnchor, 'start');
    assert.strictEqual(normal.rows[0].labelX, 22);
  });

  it('should render the anchor into the text, and only when it is not the default', () => {
    const source = COMPACT + BODY + 'section A\nRoomy : r1, 2024-01-01, 20d\n'
      + 'A rather long name for so short a bar : s1, 2024-01-10, 1d\n'
      + 'Edge task with a long name : e1, 2024-01-20, 1d';
    const labels = (src) => renderToString(renderMermaid(src)).match(/<text[^>]*mm-gantt-label[^>]*>/g);
    const [roomy, beside, before] = /** @type {string[]} */ (labels(source));
    assert.match(roomy, /text-anchor="middle"/);
    assert.doesNotMatch(beside, /text-anchor/);
    assert.match(before, /text-anchor="end"/);
    for (const tag of /** @type {string[]} */ (labels(TWO_SECTIONS)))
      assert.doesNotMatch(tag, /text-anchor/, 'the normal mode draws what it always drew');
  });
});

//#endregion
//#region the conformance table --------------------------------------

describe('the conformance table lists the two config switches', () => {
  it('should say where Mermaid reads topAxis and displayMode from', () => {
    assert.strictEqual(GRAMMAR.topAxis.config, 'gantt.topAxis');
    assert.strictEqual(GRAMMAR.topAxis.headerLine, false);
    assert.strictEqual(GRAMMAR.displayMode.config, 'gantt.displayMode');
    assert.strictEqual(GRAMMAR.displayMode.frontMatterKey, 'displayMode');
    assert.deepStrictEqual(GRAMMAR.displayMode.values, ['compact']);
    assert.strictEqual(GRAMMAR.displayMode.headerLine, false);
  });

  it('should list the header line this engine honours as a divergence', () => {
    const named = GRAMMAR.divergences.find((d) => /topAxis/.test(d.what));
    assert.match(named.mermaid, /TopAxis is not a function/);
    assert.match(named.jaren, /second axis/);
    assert.doesNotThrow(() => parseMermaid(BODY + 'topAxis\nsection A\nt1 : a1, 2024-01-01, 1d'));
  });
});

//#endregion
