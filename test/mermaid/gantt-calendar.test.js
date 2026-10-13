//@ts-check
/**
 * @file The Gantt calendar directives: `excludes` lines that accumulate,
 * `includes` (the exceptions that win over `excludes`) and
 * `inclusiveEndDates`. Every expected end was read from Mermaid's own
 * gantt database, the version `fixtures/gantt-grammar.json` names.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMermaid, toMermaid } from '@jarenjs/mermaid';
import { layoutGantt } from '../../components/mermaid/src/layout/gantt.js';
import { createExcluder, DAY_MS } from '../../components/mermaid/src/gantt-calendar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAMMAR = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'gantt-grammar.json'), 'utf8'));

const UTC = (y, m, d) => Date.UTC(y, m - 1, d);
const DAY = (y, m, d) => UTC(y, m, d) / DAY_MS;

/**
 * @param {string} header - lines after `dateFormat YYYY-MM-DD`
 * @param {string} tasks - task rows
 * @returns {any}
 */
const ast = (header, tasks) => parseMermaid(
  `gantt\ndateFormat YYYY-MM-DD\n${header}\nsection S\n${tasks}`).ast;

/** Friday 2024-01-05, three days, then a one-day follower. */
const FRIDAY = 'A : a1, 2024-01-05, 3d\nB : b1, after a1, 1d';

/** @param {any} tree @returns {string[]} `id start..end` per task, as ISO days */
const spans = (tree) => tree.sections.flatMap((s) => s.tasks).map((t) =>
  `${t.id} ${new Date(t.start).toISOString().slice(0, 10)}..${new Date(t.end).toISOString().slice(0, 10)}`);

describe('excludes lines accumulate', () => {
  it('should read two lines as one list, as Mermaid does', () => {
    const tree = ast('excludes saturday\nexcludes sunday', FRIDAY);
    assert.deepStrictEqual(tree.rules.excludes, { weekends: false, weekdays: [6, 7], days: [] });
    assert.deepStrictEqual(spans(tree), ['a1 2024-01-05..2024-01-10', 'b1 2024-01-10..2024-01-11']);
  });

  it('should keep the printer a fixed point over the joined list', () => {
    const once = parseMermaid(`gantt\ndateFormat YYYY-MM-DD\nexcludes saturday\nexcludes sunday\nsection S\n${FRIDAY}`);
    assert.strictEqual(once.ast.meta.excludes, 'saturday sunday');
    // one line now, so every task sits a line higher; nothing else moves
    const printed = toMermaid(once);
    assert.strictEqual(printed.split('\n')[2], 'excludes saturday sunday');
    assert.strictEqual(toMermaid(parseMermaid(printed)), printed);
    assert.deepStrictEqual(parseMermaid(printed).ast.rules, once.ast.rules);
  });

  it('should report a bad term on the line that wrote it', () => {
    assert.throws(() => ast('excludes bank-holiday\nexcludes saturday', FRIDAY),
      (err) => err.line === 3 && /neither 'weekends'/.test(err.message));
  });
});

describe('the includes directive', () => {
  it('should read dates into sorted, distinct day indexes', () => {
    assert.deepStrictEqual(ast('includes 2024-01-07, 2024-01-06 2024-01-07', FRIDAY).rules.includes,
      { days: [DAY(2024, 1, 6), DAY(2024, 1, 7)] });
    assert.deepStrictEqual(ast('excludes weekends', FRIDAY).rules.includes, { days: [] });
  });

  it('should read a date in the document dateFormat', () => {
    const tree = parseMermaid('gantt\ndateFormat DD-MM-YYYY\nexcludes weekends\nincludes 06-01-2024\n'
      + 'section S\nA : a1, 05-01-2024, 3d').ast;
    assert.deepStrictEqual(tree.rules.includes, { days: [DAY(2024, 1, 6)] });
  });

  it('should let an included Saturday count as a working day', () => {
    assert.deepStrictEqual(spans(ast('excludes weekends', FRIDAY)),
      ['a1 2024-01-05..2024-01-10', 'b1 2024-01-10..2024-01-11']);
    assert.deepStrictEqual(spans(ast('excludes weekends\nincludes 2024-01-06', FRIDAY)),
      ['a1 2024-01-05..2024-01-09', 'b1 2024-01-09..2024-01-10']);
    assert.deepStrictEqual(spans(ast('excludes weekends\nincludes 2024-01-06 2024-01-07', FRIDAY)),
      ['a1 2024-01-05..2024-01-08', 'b1 2024-01-08..2024-01-09']);
  });

  it('should not care whether includes comes before or after excludes', () => {
    assert.deepStrictEqual(spans(ast('includes 2024-01-06\nexcludes weekends', FRIDAY)),
      ['a1 2024-01-05..2024-01-09', 'b1 2024-01-09..2024-01-10']);
  });

  it('should accumulate includes lines and comma lists', () => {
    const want = ['a1 2024-01-05..2024-01-08', 'b1 2024-01-08..2024-01-09'];
    assert.deepStrictEqual(spans(ast('excludes weekends\nincludes 2024-01-06\nincludes 2024-01-07', FRIDAY)), want);
    assert.deepStrictEqual(spans(ast('excludes weekends\nincludes 2024-01-06,2024-01-07', FRIDAY)), want);
  });

  it('should override an excluded date', () => {
    assert.deepStrictEqual(spans(ast('excludes 2024-01-06\nincludes 2024-01-06', FRIDAY)),
      ['a1 2024-01-05..2024-01-08', 'b1 2024-01-08..2024-01-09']);
  });

  it('should change nothing when nothing is excluded', () => {
    assert.deepStrictEqual(spans(ast('includes 2024-01-06', FRIDAY)),
      ['a1 2024-01-05..2024-01-08', 'b1 2024-01-08..2024-01-09']);
  });

  it('should ignore a term Mermaid ignores, and honour the dates beside it', () => {
    const want = ['a1 2024-01-05..2024-01-10', 'b1 2024-01-10..2024-01-11'];
    for (const term of ['saturday', 'weekends', 'bank-holiday', '2024-13-45']) {
      const tree = ast(`excludes weekends\nincludes ${term}`, FRIDAY);
      assert.deepStrictEqual(tree.rules.includes, { days: [] }, term);
      assert.deepStrictEqual(spans(tree), want, term);
    }
    const mixed = ast('excludes weekends\nincludes saturday 2024-01-06 weekends', FRIDAY);
    assert.deepStrictEqual(mixed.rules.includes, { days: [DAY(2024, 1, 6)] });
    assert.deepStrictEqual(spans(mixed), ['a1 2024-01-05..2024-01-09', 'b1 2024-01-09..2024-01-10']);
  });

  it('should honour a date that shares its line with a comment or a time', () => {
    const want = ['a1 2024-01-05..2024-01-09', 'b1 2024-01-09..2024-01-10'];
    assert.deepStrictEqual(spans(ast('excludes weekends\nincludes 2024-01-06 %% a note', FRIDAY)), want);
    const timed = parseMermaid('gantt\ndateFormat YYYY-MM-DD HH:mm\nexcludes weekends\n'
      + 'includes 2024-01-06 10:00\nsection S\nA : a1, 2024-01-05 09:00, 3d').ast;
    assert.deepStrictEqual(timed.rules.includes, { days: [DAY(2024, 1, 6)] });
    assert.strictEqual(timed.sections[0].tasks[0].end, Date.UTC(2024, 0, 9, 9));
  });

  it('should read a trailing comment on excludes too', () => {
    assert.deepStrictEqual(ast('excludes weekends %% bank holidays follow', FRIDAY).rules.excludes,
      { weekends: true, weekdays: [], days: [] });
  });

  it('should keep a task row whose name starts with the word', () => {
    const tree = ast('', 'includes the API docs : a1, 2024-01-05, 3d\n'
      + 'inclusiveEndDates handling : a2, 2024-01-05, 2024-01-06\n'
      + 'includes sprint 2: a3, 2024-01-05, 1d');
    assert.deepStrictEqual(spans(tree),
      ['a1 2024-01-05..2024-01-08', 'a2 2024-01-05..2024-01-06', 'a3 2024-01-05..2024-01-06']);
    assert.deepStrictEqual(tree.sections[0].tasks.map((t) => t.name),
      ['includes the API docs', 'inclusiveEndDates handling', 'includes sprint 2']);
    assert.strictEqual(tree.rules.inclusiveEndDates, false);
    assert.deepStrictEqual(tree.rules.includes, { days: [] });
  });

  it('should print as written and survive parse, print, parse', () => {
    const once = parseMermaid('gantt\ndateFormat YYYY-MM-DD\nexcludes weekends\nincludes 2024-01-06\n'
      + `section S\n${FRIDAY}`);
    assert.strictEqual(once.ast.meta.includes, '2024-01-06');
    assert.match(toMermaid(once), /\nincludes 2024-01-06\n/);
    assert.deepStrictEqual(parseMermaid(toMermaid(once)).ast, once.ast);
  });

  it('should not shade an included day', () => {
    const shaded = (header) => layoutGantt(ast(header, 'A : a1, 2024-01-05, 3d')).bands
      .map((b) => [b.start, b.end]);
    assert.deepStrictEqual(shaded('excludes weekends'), [[UTC(2024, 1, 6), UTC(2024, 1, 8)]]);
    assert.deepStrictEqual(shaded('excludes weekends\nincludes 2024-01-06'),
      [[UTC(2024, 1, 7), UTC(2024, 1, 8)]]);
    assert.deepStrictEqual(shaded('excludes weekends\nincludes 2024-01-06 2024-01-07'), []);
  });

  it('should lay out a tree written before includes existed', () => {
    const tree = ast('excludes weekends', 'A : a1, 2024-01-05, 3d');
    delete tree.rules.includes;
    delete tree.rules.inclusiveEndDates;
    assert.deepStrictEqual(layoutGantt(tree).bands.map((b) => [b.start, b.end]),
      [[UTC(2024, 1, 6), UTC(2024, 1, 8)]]);
  });

  it('should let an included day beat the weekend in the working calendar', () => {
    const excluder = createExcluder({ weekends: true, weekdays: [], days: [] }, 6, [DAY(2024, 1, 6)]);
    assert.strictEqual(excluder.isExcludedDay(DAY(2024, 1, 6)), false);
    assert.strictEqual(excluder.isExcludedDay(DAY(2024, 1, 7)), true);
  });
});

describe('repeated list lines parse in linear time', () => {
  /** @param {number} n @returns {string} */
  const holidays = (n) => {
    const lines = [];
    for (let i = 0; i < n; i++) {
      lines.push(`excludes ${new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10)}`);
      lines.push(`includes ${new Date(Date.UTC(2024, 0, 1 + 2 * i)).toISOString().slice(0, 10)}`);
    }
    return `gantt\ndateFormat YYYY-MM-DD\n${lines.join('\n')}\nsection S\nA : a1, 2024-01-05, 3d`;
  };
  const best = (/** @type {string} */ source) => {
    let fastest = Infinity;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      parseMermaid(source);
      fastest = Math.min(fastest, performance.now() - t0);
    }
    return fastest;
  };

  it('should grow with the line count, not with its square', () => {
    const small = best(holidays(500));
    const large = best(holidays(4000));
    // 8x the lines: linear is ~8x, quadratic ~64x
    assert.ok(large / Math.max(small, 0.05) < 24, `${small} ms -> ${large} ms`);
  });
});

describe('the inclusiveEndDates directive', () => {
  const H = 'inclusiveEndDates';

  it('should be off by default and on when named', () => {
    assert.strictEqual(ast('', 'A : a1, 2024-01-01, 1d').rules.inclusiveEndDates, false);
    const on = parseMermaid(`gantt\ndateFormat YYYY-MM-DD\n${H}\nsection S\nA : a1, 2024-01-01, 1d`);
    assert.strictEqual(on.ast.rules.inclusiveEndDates, true);
    assert.strictEqual(on.ast.meta.inclusiveEndDates, '');
    assert.match(toMermaid(on), /\ninclusiveEndDates\n/);
    assert.deepStrictEqual(parseMermaid(toMermaid(on)).ast, on.ast);
  });

  it('should make an end written as a date the last day worked', () => {
    const rows = 'A : a1, 2024-01-01, 2024-01-03';
    assert.deepStrictEqual(spans(ast('', rows)), ['a1 2024-01-01..2024-01-03']);
    assert.deepStrictEqual(spans(ast(H, rows)), ['a1 2024-01-01..2024-01-04']);
  });

  it('should leave durations and until alone', () => {
    assert.deepStrictEqual(spans(ast(H, 'A : a1, 2024-01-01, 3d\nB : b1, after a1, 2d\nC : c1, 2024-01-01, until b1')),
      ['a1 2024-01-01..2024-01-04', 'b1 2024-01-04..2024-01-06', 'c1 2024-01-01..2024-01-04']);
  });

  it('should hand the inclusive end to a task that follows', () => {
    assert.deepStrictEqual(spans(ast(H, 'A : a1, 2024-01-05, 2024-01-06\nB : 2024-01-08')),
      ['a1 2024-01-05..2024-01-07', 'task1 2024-01-07..2024-01-09']);
  });

  it('should give a milestone dated start and end one day', () => {
    assert.deepStrictEqual(spans(ast(H, 'A : milestone, a1, 2024-01-03, 2024-01-03')),
      ['a1 2024-01-03..2024-01-04']);
  });

  it('should not push a date end past exclusions, but push what follows', () => {
    assert.deepStrictEqual(spans(ast(`${H}\nexcludes weekends`, 'A : a1, 2024-01-05, 2024-01-07\nB : b1, after a1, 2d')),
      ['a1 2024-01-05..2024-01-08', 'b1 2024-01-08..2024-01-10']);
  });

  it('should add a whole day to an end that carries a time', () => {
    const tree = parseMermaid('gantt\ndateFormat YYYY-MM-DD HH:mm\ninclusiveEndDates\nsection S\n'
      + 'A : a1, 2024-01-05 10:00, 2024-01-06 12:00').ast;
    assert.strictEqual(tree.sections[0].tasks[0].end, Date.UTC(2024, 0, 7, 12));
  });

  it('should still refuse a span that ends before it starts', () => {
    assert.throws(() => ast(H, 'A : a1, 2024-01-05, 2024-01-03'),
      (err) => err.line === 5 && /ends before it starts/.test(err.message));
  });

  it('should accept a trailing comment, as Mermaid does', () => {
    const tree = ast('inclusiveEndDates %% last day counts', 'A : a1, 2024-01-01, 2024-01-03');
    assert.strictEqual(tree.rules.inclusiveEndDates, true);
    assert.strictEqual(tree.meta.inclusiveEndDates, '');
    assert.deepStrictEqual(spans(tree), ['a1 2024-01-01..2024-01-04']);
  });

  it('should refuse an argument, which Mermaid cannot read either', () => {
    assert.throws(() => ast('inclusiveEndDates yes', 'A : a1, 2024-01-05, 1d'),
      (err) => err.line === 3 && /takes no argument/.test(err.message));
  });
});

describe('the conformance table lists the calendar directives', () => {
  it('should name includes and inclusiveEndDates as Mermaid reads them', () => {
    assert.strictEqual(GRAMMAR.includes.keyword, 'includes');
    assert.deepStrictEqual(GRAMMAR.includes.terms, ['<a date in dateFormat>']);
    assert.strictEqual(GRAMMAR.inclusiveEndDates.keyword, 'inclusiveEndDates');
    assert.strictEqual(GRAMMAR.inclusiveEndDates.argument, false);
    assert.ok(GRAMMAR.divergences.some((d) => /includes/.test(d.what)));
  });
});
