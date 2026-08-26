//@ts-check
/**
 * @file The Gantt timeline: the three token grammars, the schedule
 * resolver, the working calendar, the layout geometry and the rendered
 * SVG. The vendored conformance table
 * (`fixtures/gantt-grammar.json`) is checked against the code here, so
 * a token added to one and not the other is a red test rather than a
 * quiet divergence from the Mermaid version this engine claims.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseMermaid, toMermaid, compileMermaid, renderMermaid, layoutDiagram,
} from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';
import { compileDateLocale, nl } from '@jarenjs/locales';

import { layoutGantt } from '../../components/mermaid/src/layout/gantt.js';
import {
  momentToLdml, strftimeToLdml, parseTickInterval, parseTaskDuration,
  parseWeekday, parseWeekend,
  MOMENT_TO_LDML, MOMENT_REFUSED, STRFTIME_TO_LDML, STRFTIME_REFUSED,
} from '../../components/mermaid/src/parser/gantt-grammar.js';
import {
  createExcluder, pushEndPastExclusions, pushEndDayByDay, DAY_MS,
} from '../../components/mermaid/src/gantt-calendar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAMMAR = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'gantt-grammar.json'), 'utf8'));

const UTC = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);

/** A small dated schedule the geometry tests share. */
const PLAN = `gantt
title Release plan
dateFormat YYYY-MM-DD
excludes weekends
section Build
Design : done, a1, 2024-01-04, 3d
Implement : active, a2, after a1, 5d
section Ship
Review : crit, a3, after a2, 2d
Launch : milestone, m1, after a3, 0d`;

//#region the vendored conformance table -----------------------------

describe('the Gantt conformance table is the code', () => {
  it('should name the Mermaid version and where it was read', () => {
    assert.strictEqual(GRAMMAR.provenance.engine, 'mermaid');
    assert.match(GRAMMAR.provenance.version, /^\d+\.\d+\.\d+$/);
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', GRAMMAR.provenance.source)),
      'the file the table was read from must still be in the tree');
  });

  it('should agree with the dateFormat adapter, token for token', () => {
    for (const entry of GRAMMAR.dateFormat.tokens) {
      const got = momentToLdml(entry.token);
      if (entry.supported) {
        assert.strictEqual(got.error, null, `${entry.token} should be supported`);
        assert.strictEqual(MOMENT_TO_LDML[entry.token], entry.ldml, entry.token);
      }
      else {
        assert.notStrictEqual(got.error, null, `${entry.token} should be refused`);
        assert.ok(got.error.includes(entry.token), entry.token);
        assert.ok(MOMENT_REFUSED[entry.token] !== undefined, entry.token);
      }
    }
    // and nothing the code knows is missing from the table
    const listed = new Set(GRAMMAR.dateFormat.tokens.map((e) => e.token));
    for (const token of [...Object.keys(MOMENT_TO_LDML), ...Object.keys(MOMENT_REFUSED)])
      assert.ok(listed.has(token), `${token} is implemented but not in the conformance table`);
  });

  it('should agree with the axisFormat adapter, specifier for specifier', () => {
    for (const entry of GRAMMAR.axisFormat.tokens) {
      const got = strftimeToLdml(entry.token);
      const spec = entry.token.slice(1);
      if (entry.supported) {
        assert.strictEqual(got.error, null, `${entry.token} should be supported`);
        assert.strictEqual(STRFTIME_TO_LDML[spec], entry.ldml, entry.token);
      }
      else {
        assert.notStrictEqual(got.error, null, `${entry.token} should be refused`);
        assert.ok(STRFTIME_REFUSED[spec] !== undefined, entry.token);
      }
    }
    const listed = new Set(GRAMMAR.axisFormat.tokens.map((e) => e.token.slice(1)));
    for (const spec of [...Object.keys(STRFTIME_TO_LDML), ...Object.keys(STRFTIME_REFUSED)])
      assert.ok(listed.has(spec), `%${spec} is implemented but not in the conformance table`);
  });

  it('should cover every token the shipped Mermaid chunk actually parses', () => {
    // The two checks above hold the TABLE and the CODE to each other,
    // which is a closed loop: a token neither of them knows is invisible
    // to both. This one opens it. dayjs' `customParseFormat` expression
    // table is inlined in the very chunk `provenance.source` names, so
    // the vocabulary Mermaid really accepts is READ rather than
    // remembered — and `w`, `ww` and `Y` were missing from the table and
    // from the adapter alike, which turned each of them into LITERAL
    // text and then blamed every task's own start date for not matching.
    const chunk = fs.readFileSync(
      path.join(__dirname, '..', '..', GRAMMAR.provenance.source), 'utf8');
    // `{A:[` opens the expression table and `Z:…,ZZ:…}` closes it
    const open = chunk.indexOf('{A:[');
    const last = chunk.indexOf('ZZ:', open);
    const close = chunk.indexOf('}', last);
    assert.ok(open > 0 && last > open && close > last,
      'the dayjs parse table is no longer recognizable in '
      + `${GRAMMAR.provenance.source}; read the new build and re-vendor the table`);
    const parsed = new Set([...chunk.slice(open, close + 1)
      .matchAll(/[,{]([A-Za-z]{1,4}):/g)].map((m) => m[1]));
    // a broken extraction must fail here rather than pass vacuously
    assert.ok(parsed.size >= 25,
      `only ${parsed.size} tokens read out of the chunk — the extraction moved, not the table`);
    for (const known of ['YYYY', 'MMMM', 'Do', 'ww', 'w', 'Y', 'ZZ'])
      assert.ok(parsed.has(known), `${known} should be in the shipped parse table`);

    const listed = new Set(GRAMMAR.dateFormat.tokens.map((e) => e.token));
    for (const token of parsed) {
      assert.ok(listed.has(token),
        `mermaid ${GRAMMAR.provenance.version} parses '${token}' and the conformance table `
        + 'does not mention it — an unlisted token becomes literal text, so every task '
        + 'that uses it is reported as having a bad start date instead');
    }
  });

  it('should accept and reject exactly the tickIntervals the table lists', () => {
    for (const good of GRAMMAR.tickInterval.examples)
      assert.strictEqual(parseTickInterval(good).error, null, good);
    for (const bad of GRAMMAR.tickInterval.rejects)
      assert.notStrictEqual(parseTickInterval(bad).error, null, bad);
    for (const unit of GRAMMAR.tickInterval.units)
      assert.deepStrictEqual(parseTickInterval(`3${unit}`).value, { amount: 3, unit });
  });

  it('should accept and reject exactly the durations the table lists', () => {
    for (const good of GRAMMAR.duration.examples)
      assert.notStrictEqual(parseTaskDuration(good).value, null, good);
    for (const bad of GRAMMAR.duration.rejects)
      assert.strictEqual(parseTaskDuration(bad).value, null, bad);
    for (const [letter, unit] of Object.entries(GRAMMAR.duration.units))
      assert.deepStrictEqual(parseTaskDuration(`2${letter}`).value, { amount: 2, unit });
  });

  it('should read the weekday and weekend keywords the table lists', () => {
    for (const name of GRAMMAR.weekday.values)
      assert.strictEqual(parseWeekday(name).error, null, name);
    assert.notStrictEqual(parseWeekday('caturday').error, null);
    for (const name of GRAMMAR.weekend.values)
      assert.strictEqual(parseWeekend(name).error, null, name);
    assert.notStrictEqual(parseWeekend('sunday').error, null);
  });
});

//#endregion
//#region the two pattern adapters -----------------------------------

describe('dateFormat and axisFormat are separate grammars', () => {
  it('should read the same letter as two different fields', () => {
    // moment `m` is a minute; strftime `%m` is a month. One shared
    // table would silently mis-read half of every diagram.
    assert.strictEqual(momentToLdml('m').value, 'm');
    assert.strictEqual(strftimeToLdml('%m').value, 'MM');
    assert.strictEqual(momentToLdml('M').value, 'M');
    assert.strictEqual(strftimeToLdml('%M').value, 'mm');
  });

  it('should quote literal runs rather than leaving them to LDML', () => {
    assert.strictEqual(momentToLdml('YYYY-MM-DD').value, "yyyy'-'MM'-'dd");
    assert.strictEqual(momentToLdml('[on] DD MMM').value, "'on 'dd' 'MMM");
    assert.strictEqual(strftimeToLdml('%Y at %H').value, "yyyy' at 'HH");
  });

  it('should never hand a moment token straight to the core compiler', () => {
    // `YYYY` in LDML is the week-numbering year, so an adapter that let
    // it through would answer 2019 for 2018-12-31
    const doc = parseMermaid('gantt\ndateFormat YYYY-MM-DD\nsection S\n'
      + 'T : t1, 2018-12-31, 1d');
    assert.strictEqual(doc.ast.sections[0].tasks[0].start, UTC(2018, 12, 31));
  });

  it('should parse dates in a non-ISO dateFormat', () => {
    const doc = parseMermaid('gantt\ndateFormat DD-MM-YYYY\nsection S\n'
      + 'T : t1, 06-01-2014, 3d');
    assert.strictEqual(doc.ast.sections[0].tasks[0].start, UTC(2014, 1, 6));
  });

  it('should refuse an impossible date in the declared format', () => {
    assert.throws(() => parseMermaid('gantt\ndateFormat DD-MM-YYYY\nsection S\n'
      + 'T : t1, 31-02-2014, 3d'), (err) => err.line === 4 && /starts at '31-02-2014'/.test(err.message));
  });

  it('should refuse an unterminated bracket escape', () => {
    assert.throws(() => parseMermaid('gantt\ndateFormat [on YYYY\nsection S\n'
      + 'T : t1, 2014-01-01, 3d'), /unterminated/);
  });

  it('should refuse a bare trailing percent in axisFormat', () => {
    assert.throws(() => parseMermaid('gantt\naxisFormat %Y%\nsection S\n'
      + 'T : t1, 2014-01-01, 3d'), /bare '%'/);
  });
});

//#endregion
//#region the working calendar ---------------------------------------

describe('excluded days move an end exactly as the day-by-day oracle does', () => {
  /**
   * A deterministic sweep: every start hour of a fortnight, every
   * duration up to three weeks, against three exclusion shapes.
   */
  const SHAPES = [
    { label: 'weekends', rules: { weekends: true, weekdays: [], days: [] }, weekendStart: 6 },
    { label: 'friday weekends', rules: { weekends: true, weekdays: [], days: [] }, weekendStart: 5 },
    { label: 'wednesdays and two dates', weekendStart: 6, rules: {
      weekends: false, weekdays: [3],
      days: [Math.floor(UTC(2024, 1, 11) / DAY_MS), Math.floor(UTC(2024, 1, 12) / DAY_MS)],
    } },
  ];

  it('should agree with the oracle on every case in the sweep', () => {
    let checked = 0;
    for (const shape of SHAPES) {
      const excluder = createExcluder(shape.rules, shape.weekendStart);
      for (let hour = 0; hour < 14 * 24; hour += 7) {
        const start = UTC(2024, 1, 1) + hour * 3600000;
        for (let days = 0; days <= 21; days += 1) {
          const end = start + days * DAY_MS;
          assert.strictEqual(
            pushEndPastExclusions(start, end, excluder),
            pushEndDayByDay(start, end, excluder),
            `${shape.label} start+${hour}h for ${days}d`);
          checked++;
        }
      }
    }
    assert.ok(checked > 3000, `the sweep should be large; it was ${checked}`);
  });

  it('should agree with the oracle across a negative epoch', () => {
    const excluder = createExcluder({ weekends: true, weekdays: [], days: [] }, 6);
    for (let day = -400; day < -380; day++) {
      const start = day * DAY_MS;
      for (let days = 0; days <= 10; days++) {
        const end = start + days * DAY_MS;
        assert.strictEqual(pushEndPastExclusions(start, end, excluder),
          pushEndDayByDay(start, end, excluder), `${day} + ${days}d`);
      }
    }
  });

  it('should leave a schedule with no exclusions alone', () => {
    const excluder = createExcluder({ weekends: false, weekdays: [], days: [] }, 6);
    assert.strictEqual(excluder.any, false);
    const start = UTC(2024, 1, 4);
    assert.strictEqual(pushEndPastExclusions(start, start + 3 * DAY_MS, excluder),
      start + 3 * DAY_MS);
  });

  it('should keep the rule at day granularity, not millisecond', () => {
    // Friday noon plus one day is Monday noon, not Monday midnight
    const excluder = createExcluder({ weekends: true, weekdays: [], days: [] }, 6);
    const friday = UTC(2024, 1, 5, 12);
    assert.strictEqual(pushEndPastExclusions(friday, friday + DAY_MS, excluder),
      UTC(2024, 1, 8, 12));
  });

  it('should refuse a schedule whose exclusions swallow every day', () => {
    assert.throws(() => parseMermaid('gantt\ndateFormat YYYY-MM-DD\n'
      + 'excludes monday tuesday wednesday thursday friday saturday sunday\n'
      + 'section S\nT : t1, 2024-01-04, 3d'), /can never finish/);
  });
});

describe('the excludes directive', () => {
  const parseExcludes = (text) => parseMermaid(`gantt\ndateFormat YYYY-MM-DD\nexcludes ${text}\n`
    + 'section S\nT : t1, 2024-01-04, 1d').ast.rules.excludes;

  it('should read weekends, weekday names and explicit dates', () => {
    assert.deepStrictEqual(parseExcludes('weekends'),
      { weekends: true, weekdays: [], days: [] });
    assert.deepStrictEqual(parseExcludes('monday, friday'),
      { weekends: false, weekdays: [1, 5], days: [] });
    assert.deepStrictEqual(parseExcludes('2024-01-08'),
      { weekends: false, weekdays: [], days: [Math.floor(UTC(2024, 1, 8) / DAY_MS)] });
  });

  it('should read an excluded date in the document dateFormat', () => {
    const rules = parseMermaid('gantt\ndateFormat DD-MM-YYYY\nexcludes 08-01-2024\n'
      + 'section S\nT : t1, 04-01-2024, 1d').ast.rules;
    assert.deepStrictEqual(rules.excludes.days, [Math.floor(UTC(2024, 1, 8) / DAY_MS)]);
  });

  it('should refuse a term that is neither a keyword nor a date', () => {
    assert.throws(() => parseExcludes('bank-holiday'), (err) =>
      err.line === 3 && /neither 'weekends'/.test(err.message));
  });

  it('should move the weekend with the weekend directive', () => {
    const saturday = parseMermaid('gantt\ndateFormat YYYY-MM-DD\nexcludes weekends\n'
      + 'section S\nT : t1, 2024-01-04, 3d').ast.sections[0].tasks[0];
    const friday = parseMermaid('gantt\ndateFormat YYYY-MM-DD\nexcludes weekends\n'
      + 'weekend friday\nsection S\nT : t1, 2024-01-04, 3d').ast.sections[0].tasks[0];
    assert.strictEqual(saturday.end, UTC(2024, 1, 9), 'saturday+sunday are skipped');
    assert.strictEqual(friday.end, UTC(2024, 1, 9), 'friday+saturday are skipped');
    assert.notStrictEqual(saturday.info, undefined);
  });

  it('should not push an end that was written as a date', () => {
    // Mermaid only shifts a DERIVED end; an explicit end date is the
    // author's answer, weekend or not
    const task = parseMermaid('gantt\ndateFormat YYYY-MM-DD\nexcludes weekends\n'
      + 'section S\nT : t1, 2024-01-04, 2024-01-07').ast.sections[0].tasks[0];
    assert.strictEqual(task.end, UTC(2024, 1, 7), 'a Sunday the author asked for');
  });
});

//#endregion
//#region the schedule resolver --------------------------------------

describe('every documented task form resolves to a half-open interval', () => {
  const task = (info, before = '') => parseMermaid('gantt\ndateFormat YYYY-MM-DD\nsection S\n'
    + before + info).ast.sections[0].tasks.at(-1);

  it('should resolve start plus end', () => {
    const t = task('T : des1, 2014-01-06, 2014-01-08');
    assert.strictEqual(t.id, 'des1');
    assert.strictEqual(t.start, UTC(2014, 1, 6));
    assert.strictEqual(t.end, UTC(2014, 1, 8));
    assert.strictEqual(t.duration, 2 * DAY_MS);
  });

  it('should resolve start plus duration', () => {
    const t = task('T : des1, 2014-01-06, 3d');
    assert.strictEqual(t.end, UTC(2014, 1, 9));
  });

  it('should resolve after plus duration, and after several ids', () => {
    const t = task('C : c1, after a1 b1, 1d',
      'A : a1, 2014-01-06, 3d\nB : b1, 2014-01-06, 5d\n');
    assert.strictEqual(t.start, UTC(2014, 1, 11), 'the later of the two ends');
    assert.deepStrictEqual(t.after, ['a1', 'b1']);
  });

  it('should resolve after plus an explicit end, and until', () => {
    const after = task('B : b1, after a1, 2014-01-12', 'A : a1, 2014-01-06, 3d\n');
    assert.strictEqual(after.end, UTC(2014, 1, 12));
    const until = parseMermaid('gantt\ndateFormat YYYY-MM-DD\nsection S\n'
      + 'A : a1, 2014-01-06, 1d\nB : b1, after a1, until c1\nC : c1, 2014-01-20, 1d')
      .ast.sections[0].tasks[1];
    assert.strictEqual(until.end, UTC(2014, 1, 20), 'a forward reference resolves');
  });

  it('should resolve the two- and one-field forms, auto-naming the id', () => {
    const two = task('T : 2014-01-06, 3d');
    assert.strictEqual(two.id, 'task1');
    assert.strictEqual(two.start, UTC(2014, 1, 6));
    const one = parseMermaid('gantt\ndateFormat YYYY-MM-DD\nsection S\n'
      + 'A : a1, 2014-01-06, 3d\nB : 2d').ast.sections[0].tasks[1];
    assert.strictEqual(one.start, UTC(2014, 1, 9), 'it starts where the last one ended');
    assert.strictEqual(one.end, UTC(2014, 1, 11));
  });

  it('should read the four documented flags in any order', () => {
    assert.deepStrictEqual(task('T : crit, done, d1, 2014-01-06, 1d').flags, ['done', 'crit']);
    assert.deepStrictEqual(task('T : active, a1, 2014-01-06, 1d').flags, ['active']);
    const milestone = task('T : milestone, m1, 2014-01-08, 0d');
    assert.deepStrictEqual(milestone.flags, ['milestone']);
    assert.strictEqual(milestone.start, milestone.end, 'a milestone has no width');
    assert.strictEqual(milestone.duration, 0);
  });

  it('should add a calendar duration through the core calendar', () => {
    assert.strictEqual(task('T : t1, 2024-01-31, 1M').end, UTC(2024, 2, 29));
    assert.strictEqual(task('T : t1, 2024-01-01, 1y').end, UTC(2025, 1, 1));
    assert.strictEqual(task('T : t1, 2024-01-01, 1.5d').end, UTC(2024, 1, 2, 12));
  });

  it('should refuse a fractional calendar duration rather than approximating a month', () => {
    assert.throws(() => task('T : t1, 2024-01-01, 0.5M'), /unusable duration/);
  });

  it('should carry the source line of every task', () => {
    const doc = parseMermaid(PLAN);
    const lines = doc.ast.sections.flatMap((s) => s.tasks.map((t) => t.line));
    assert.deepStrictEqual(lines, [6, 7, 9, 10]);
  });

  it('should give the whole schedule one domain', () => {
    const doc = parseMermaid(PLAN);
    assert.strictEqual(doc.ast.domain.start, UTC(2024, 1, 4));
    assert.strictEqual(doc.ast.domain.end,
      doc.ast.sections[1].tasks[1].end, 'the milestone closes the domain');
  });
});

describe('a schedule that cannot be resolved is refused, on its own line', () => {
  const cases = [
    ['gantt\nsection S\nT : 1d', 3, /no clock/, 'no dated anchor'],
    ['gantt\nsection S\nA : a, 2024-01-01, 1d\nB : b, after zz, 1d', 4, /no task has that id/, 'missing id'],
    ['gantt\nsection S\nA : a, after b, 1d\nB : b, after a, 1d', 3, /cycle/, 'a cycle'],
    ['gantt\nsection S\nA : a, 2024-01-01, 1d\nB : a, 2024-01-02, 1d', 4, /declared twice/, 'a duplicate id'],
    ['gantt\nsection S\nA : a, 2024-01-05, 2024-01-01', 3, /ends before it starts/, 'a reversed span'],
    ['gantt\nsection S\nA : a, 2024-01-05, 0d', 3, /is empty/, 'an empty span'],
    ['gantt\nsection S\nA : a, b, c, d, e', 3, /5 fields/, 'too many fields'],
    ['gantt\nsection S\nA : a, 2024-01-05, nonsense', 3, /neither/, 'an unreadable end'],
    ['gantt\ntickInterval 1fortnight\nsection S\nA : a, 2024-01-05, 1d', 2, /tickInterval/, 'a bad tick'],
    ['gantt\nweekday caturday\nsection S\nA : a, 2024-01-05, 1d', 2, /not a day name/, 'a bad weekday'],
    ['gantt\ndateFormat YYYY-Do\nsection S\nA : a, 2024-01-05, 1d', 2, /not supported/, 'a refused token'],
  ];

  for (const [src, line, pattern, label] of cases) {
    it(`should refuse ${label} at its own line`, () => {
      assert.throws(() => parseMermaid(src), (err) => {
        assert.strictEqual(err.name, 'MermaidParseError', label);
        assert.strictEqual(err.line, line, `${label}: ${err.message}`);
        assert.match(err.message, pattern);
        return true;
      });
    });
  }

  it('should render an error box rather than throwing', () => {
    const svg = renderToString(renderMermaid('gantt\nsection S\nT : 1d'));
    assert.match(svg, /mm-error/);
    assert.match(svg, /Line 3/);
  });
});

//#endregion
//#region round trip -------------------------------------------------

describe('the printer is unaffected by the semantic members', () => {
  it('should print the header and the raw task rows verbatim', () => {
    const text = toMermaid(parseMermaid(PLAN));
    assert.strictEqual(text, PLAN + '\n');
  });

  it('should be a fixed point over parse → print → parse', () => {
    const once = parseMermaid(PLAN);
    const twice = parseMermaid(toMermaid(once));
    assert.deepStrictEqual(twice.ast, once.ast);
  });

  it('should keep info as the source of the printer, not the resolver', () => {
    const task = parseMermaid(PLAN).ast.sections[0].tasks[0];
    assert.strictEqual(task.info, 'done, a1, 2024-01-04, 3d');
  });
});

//#endregion
//#region layout -----------------------------------------------------

describe('gantt layout is deterministic geometry', () => {
  const scene = layoutGantt(parseMermaid(PLAN).ast);

  it('should be the scene layoutDiagram hands a host', () => {
    // gantt used to return null here — it had no geometry to expose
    const doc = parseMermaid(PLAN);
    assert.deepStrictEqual(layoutDiagram(doc), layoutGantt(doc.ast));
    assert.strictEqual(layoutDiagram(doc).kind, 'gantt');
  });

  it('should be byte-identical across two runs of the same document', () => {
    const again = layoutGantt(parseMermaid(PLAN).ast);
    assert.deepStrictEqual(again, scene);
  });

  it('should place every bar on the shared domain scale', () => {
    const { start, end } = scene.domain;
    const plot = scene.plot;
    for (const row of scene.rows) {
      const expected = plot.x + ((row.start - start) / (end - start)) * plot.w;
      assert.ok(Math.abs(row.x - expected) < 0.02, row.id);
      assert.ok(row.x >= plot.x - 0.01 && row.x <= plot.x + plot.w + 0.01, row.id);
    }
  });

  it('should give a milestone no width and every other task some', () => {
    const milestone = scene.rows.find((r) => r.milestone);
    assert.strictEqual(milestone.w, 0);
    for (const row of scene.rows.filter((r) => !r.milestone))
      assert.ok(row.w >= 2, row.id);
  });

  it('should put a tick on a calendar boundary and label it with axisFormat', () => {
    for (const tick of scene.ticks) {
      assert.strictEqual(tick.at % DAY_MS, 0, 'the default ladder lands on midnights');
      if (tick.label !== null) assert.match(tick.label, /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.ok(scene.ticks.length >= 2);
  });

  it('should follow a declared tickInterval and weekday', () => {
    const src = PLAN.replace('excludes weekends',
      'excludes weekends\ntickInterval 1week\nweekday sunday');
    const weekly = layoutGantt(parseMermaid(src).ast);
    for (const tick of weekly.ticks) {
      const weekday = new Date(tick.at).getUTCDay();
      assert.strictEqual(weekday, 0, 'every tick is a Sunday');
    }
  });

  it('should thin tick labels out rather than overlapping them', () => {
    const src = `gantt
dateFormat YYYY-MM-DD
axisFormat %Y-%m-%d
tickInterval 1day
section S
Long : t1, 2024-01-01, 200d`;
    const dense = layoutGantt(parseMermaid(src).ast);
    assert.ok(dense.ticks.length > 150, 'every tick mark is kept');
    const labelled = dense.ticks.filter((t) => t.label !== null);
    assert.ok(labelled.length < 20, `labels thin out; ${labelled.length} survived`);
    // and the survivors are far enough apart to be legible
    for (let i = 1; i < labelled.length; i++)
      assert.ok(labelled[i].x - labelled[i - 1].x > 40);
  });

  it('should shade the excluded days inside the domain', () => {
    assert.ok(scene.bands.length >= 2, 'the plan crosses two weekends');
    for (const band of scene.bands) {
      assert.ok(band.start >= scene.domain.start && band.end <= scene.domain.end);
      assert.ok(band.w > 0);
    }
  });

  it('should anchor a dependency from a predecessor to its successor', () => {
    assert.strictEqual(scene.links.length, 3);
    for (const link of scene.links) {
      const from = scene.rows.find((r) => r.id === link.from);
      const to = scene.rows.find((r) => r.id === link.to);
      assert.ok(from.index < to.index, `${link.from} → ${link.to}`);
      assert.ok(link.points.length >= 2);
      assert.strictEqual(link.points.at(-1)[1], to.y + to.h / 2);
    }
  });

  it('should elide a name too wide for the label column', () => {
    const src = 'gantt\ndateFormat YYYY-MM-DD\nsection S\n'
      + `${'a very long task name '.repeat(6)} : t1, 2024-01-01, 1d`;
    const wide = layoutGantt(parseMermaid(src).ast);
    assert.match(wide.rows[0].name, /…$/);
    assert.ok(wide.labelWidth <= 240);
  });

  it('should lay out an empty schedule and a single milestone without collapsing', () => {
    const empty = layoutGantt(parseMermaid('gantt\ntitle Nothing').ast);
    assert.strictEqual(empty.rows.length, 0);
    assert.ok(empty.width > 0 && empty.height > 0);
    const point = layoutGantt(parseMermaid('gantt\ndateFormat YYYY-MM-DD\nsection S\n'
      + 'M : milestone, m1, 2024-01-01, 0d').ast);
    assert.ok(point.domain.end > point.domain.start, 'a point domain is padded to a day');
  });

  it('should stay linear in the number of tasks', () => {
    const build = (n) => 'gantt\ndateFormat YYYY-MM-DD\nsection S\n'
      + Array.from({ length: n }, (_, i) => `T${i} : t${i}, 2024-01-01, ${i % 9 + 1}d`).join('\n');
    const small = layoutGantt(parseMermaid(build(100)).ast);
    const large = layoutGantt(parseMermaid(build(1000)).ast);
    assert.strictEqual(small.rows.length, 100);
    assert.strictEqual(large.rows.length, 1000);
    // one row is one row: the height grows by exactly the row count,
    // and the width only by the widest name (T999 is wider than T99)
    const rowH = small.rows[1].y - small.rows[0].y;
    assert.strictEqual(large.height - small.height, 900 * rowH);
    assert.ok(large.width - small.width < 20, 'width follows the label column, not the tasks');
  });
});

//#endregion
//#region render -----------------------------------------------------

describe('gantt renders an accessible timeline', () => {
  const svg = compileMermaid(PLAN).toSvgString();

  it('should no longer take the structured-panel branch', () => {
    assert.ok(!svg.includes('mm-panel'), 'the panel is gone');
    assert.match(svg, /class="mermaid mm-svg mm-gantt"/);
  });

  it('should name itself and describe its span', () => {
    assert.match(svg, /<title>Gantt chart: Release plan<\/title>/);
    assert.match(svg, /<desc>4 tasks from 2024-01-04 to 2024-01-\d\d\.<\/desc>/);
  });

  it('should carry a status class and a data-id per task', () => {
    assert.match(svg, /class="mm-gantt-task mm-gantt-done" data-id="a1"/);
    assert.match(svg, /class="mm-gantt-task mm-gantt-active" data-id="a2"/);
    assert.match(svg, /class="mm-gantt-task mm-gantt-crit" data-id="a3"/);
    assert.match(svg, /class="mm-gantt-task mm-gantt-milestone" data-id="m1"/);
    assert.match(svg, /<polygon points="/, 'the milestone is a diamond');
  });

  it('should draw the axis, the grid, the bands and the connectors', () => {
    for (const cls of ['mm-gantt-axis', 'mm-gantt-grid', 'mm-gantt-excluded',
      'mm-gantt-link', 'mm-gantt-section', 'mm-gantt-tick'])
      assert.ok(svg.includes(cls), cls);
  });

  it('should stay standalone-valid and byte-stable', () => {
    assert.ok(svg.startsWith('<svg'));
    assert.ok(!svg.includes('mm-error'));
    assert.strictEqual(compileMermaid(PLAN).toSvgString(), svg);
  });

  it('should re-colour with the theme rather than hard-coding ink', () => {
    const dark = renderToString(renderMermaid(PLAN, { theme: 'dark' }));
    assert.ok(dark.includes('--mm-node-fill:#1f2020'));
    assert.notStrictEqual(dark, svg);
  });

  it('should render a large schedule without error', () => {
    const src = 'gantt\ndateFormat YYYY-MM-DD\nsection S\n'
      + Array.from({ length: 500 }, (_, i) => `T${i} : t${i}, 2024-01-01, ${i % 9 + 1}d`).join('\n');
    const big = compileMermaid(src).toSvgString();
    assert.ok(big.startsWith('<svg'));
    assert.ok(!big.includes('mm-error'));
  });
});

describe('gantt labels are data or locale, never invented syntax', () => {
  const names = compileDateLocale(nl).names;

  it('should render an axisFormat name token through an injected provider', () => {
    const src = 'gantt\ndateFormat YYYY-MM-DD\naxisFormat %b %Y\ntickInterval 1month\n'
      + 'section S\nT : t1, 2024-01-01, 200d';
    const svg = renderToString(renderMermaid(src, { dateNames: names }));
    assert.match(svg, /mrt|mei/, 'a Dutch month abbreviation reaches the axis');
    assert.ok(!svg.includes('mm-error'));
  });

  it('should refuse a name token when no provider was given', () => {
    assert.throws(() => parseMermaid('gantt\naxisFormat %B\nsection S\n'
      + 'T : t1, 2024-01-01, 1d'), /dateNames/);
  });

  it('should read a localized month NAME in dateFormat through the same provider', () => {
    const doc = parseMermaid('gantt\ndateFormat DD MMMM YYYY\nsection S\n'
      + 'T : t1, 06 januari 2014, 3d', { dateNames: names });
    assert.strictEqual(doc.ast.sections[0].tasks[0].start, UTC(2014, 1, 6));
  });

  it('should keep an RTL task name as text and the geometry unchanged', () => {
    const rtl = 'gantt\ndateFormat YYYY-MM-DD\nsection مرحلة\n'
      + 'تصميم : a1, 2024-01-04, 3d\nبناء : a2, after a1, 2d';
    const doc = parseMermaid(rtl);
    assert.strictEqual(doc.ast.sections[0].name, 'مرحلة');
    assert.strictEqual(doc.ast.sections[0].tasks[0].id, 'a1',
      'the identifier is ASCII data, not localized syntax');
    const svg = compileMermaid(rtl).toSvgString();
    assert.ok(svg.includes('تصميم'));
    assert.ok(!svg.includes('mm-error'));
    // the bars are laid out from the domain, so direction changes nothing
    const scene = layoutGantt(doc.ast);
    assert.ok(scene.rows[0].x < scene.rows[1].x);
  });
});

//#endregion

describe('a directive is blamed for its own token', () => {
  const diagram = (dateFormat) => `gantt
dateFormat ${dateFormat}
section S
A :a, 2026-01-05, 1d`;

  it('refuses an unreadable dateFormat token on the DIRECTIVE line, not the task', () => {
    // the whole cost of the bug: an unlisted token becomes literal text,
    // so the pattern can never match and every task in the diagram is
    // reported as having a bad date while the directive looks innocent
    for (const [pattern, token] of [['ww YYYY', 'ww'], ['w YYYY', 'w'],
      ['DDD YYYY', 'DDD'], ['Q YYYY', 'Q']]) {
      assert.throws(() => parseMermaid(diagram(pattern)), (error) => {
        assert.strictEqual(/** @type {any} */ (error).name, 'MermaidParseError');
        assert.strictEqual(/** @type {any} */ (error).line, 2, `${pattern}: the dateFormat line`);
        assert.match(/** @type {Error} */ (error).message, new RegExp(`'${token}'`));
        return true;
      });
    }
  });

  it("reads dayjs' signed year, because core spells the same field", () => {
    const one = parseMermaid(`gantt
dateFormat Y-MM-DD
section S
A :a, 2026-01-05, 1d`);
    assert.strictEqual(one.ast.sections[0].tasks[0].start, Date.UTC(2026, 0, 5));
    // and the wider spelling still wins the longest-token scan
    const four = parseMermaid(diagram('YYYY-MM-DD'));
    assert.strictEqual(four.ast.sections[0].tasks[0].start, Date.UTC(2026, 0, 5));
  });

  it('says a real d3 specifier is unsupported rather than unknown', () => {
    for (const [spec, listed] of [['%V', true], ['%u', true], ['%Q', true], ['%n', false]]) {
      const { error } = strftimeToLdml(`${spec}`);
      assert.notStrictEqual(error, null, spec);
      assert.strictEqual(/is not supported/.test(/** @type {string} */ (error)), listed,
        `${spec}: a directive d3 has is 'not supported'; one it does not have is 'not a directive'`);
    }
  });
});
