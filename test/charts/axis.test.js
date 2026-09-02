//@ts-check
/**
 * The localizable time axis: a chart definition carries a `dateNames`
 * record and `timeFormats` patterns, the axis compiles its labeller once
 * per build from them, a name token with no record is the same refusal
 * the Mermaid Gantt gives, and with neither member the axis labels
 * exactly as it always has.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildLineAST, buildCandlestickAST, formatTimeTick, compileTimeTickFormat,
  TIME_TICK_FORMATS, axisTicksTime, niceTimeStep,
} from '@jarenjs/charts';
import { compileDateLocale, nl, de } from '@jarenjs/locales';
import { parseMermaid } from '@jarenjs/mermaid';
import { JarenValidator } from '@jarenjs/validate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chartsRoot = path.join(__dirname, '..', '..', 'components', 'charts');

/** Ten daily samples: the axis steps by days. */
const DAILY = {
  series: [{
    name: 'a',
    points: Array.from({ length: 10 }, (_, i) => ({ x: Date.UTC(2026, 6, 20 + i), y: i })),
  }],
};

/** Six hourly candles: the axis steps by hours. */
const HOURLY = {
  candles: Array.from({ length: 6 }, (_, i) => ({
    t: Date.UTC(2026, 6, 27, 9 + i), open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i,
  })),
};

/** Twelve daily candles: the axis steps by days. */
const DAILY_CANDLES = {
  candles: Array.from({ length: 12 }, (_, i) => ({
    t: Date.UTC(2026, 6, 1 + i), open: 10, high: 12, low: 9, close: 11,
  })),
};

const NL = compileDateLocale(nl).names;
const DE = compileDateLocale(de).names;
const DAY_NAMED = 'EEEE d MMMM';
const REFUSAL = /asks for a locale name, so it needs a 'dateNames'/;
const NO_NAMES_OF_ITS_OWN = /ships no month or weekday names of its own/;

/** The tick values and step an AST's x axis was laid on. */
function tickPlan(ast) {
  const [x0, x1] = ast.domain.x;
  return { values: axisTicksTime(x0, x1, 4), step: niceTimeStep(x1 - x0, 4) };
}

/** Split an `EEEE d MMMM` label into its weekday and month words. */
function words(label) {
  const m = /^(\S+) (\d+) (\S+)$/.exec(label);
  assert.ok(m !== null, `'${label}' is not a weekday, a day and a month`);
  return { weekday: m[1], month: m[3] };
}

describe('a time axis with no dateNames labels exactly as before', function () {
  it('should keep the historical no-step label shape', function () {
    assert.equal(formatTimeTick(Date.UTC(2026, 6, 27, 14, 30, 5)), '14:30:05');
    assert.equal(formatTimeTick(Date.UTC(2026, 6, 27)), '2026-07-27');
  });

  it('should label a line axis tick for tick as formatTimeTick does', function () {
    const ast = buildLineAST(DAILY, { type: 'line', x: 'time' });
    const { values, step } = tickPlan(ast);
    assert.equal(ast.x.ticks.length, values.length);
    assert.deepEqual(ast.x.ticks.map((t) => t.label), values.map((v) => formatTimeTick(v, step)));
    assert.equal(step[0], 'day');
  });

  it('should label a candlestick axis tick for tick as formatTimeTick does', function () {
    const ast = buildCandlestickAST(HOURLY, { type: 'candlestick' });
    const { values, step } = tickPlan(ast);
    assert.equal(ast.x.ticks.length, values.length);
    assert.deepEqual(ast.x.ticks.map((t) => t.label), values.map((v) => formatTimeTick(v, step)));
    assert.equal(step[0], 'hour');
  });

  it('should expose the five numeric defaults, frozen', function () {
    assert.deepEqual({ ...TIME_TICK_FORMATS }, {
      second: 'HH:mm:ss', minute: 'HH:mm', day: 'yyyy-MM-dd', month: 'yyyy-MM', year: 'yyyy',
    });
    assert.ok(Object.isFrozen(TIME_TICK_FORMATS));
    // a record-free labeller and the module default agree everywhere
    const label = compileTimeTickFormat();
    for (const [v, step] of /** @type {[number, [string, number]|undefined][]} */ ([
      [Date.UTC(2026, 6, 27, 14, 30, 5), undefined],
      [Date.UTC(2026, 6, 27), undefined],
      [Date.UTC(2026, 6, 27, 14, 30, 5), ['second', 30]],
      [Date.UTC(2026, 6, 27, 14, 30), ['hour', 1]],
      [Date.UTC(2026, 6, 27), ['week', 1]],
      [Date.UTC(2026, 6, 1), ['month', 1]],
      [Date.UTC(2026, 0, 1), ['year', 1]],
    ])) {
      assert.equal(label(v, step), formatTimeTick(v, step));
    }
  });

  it('should keep a numeric override working with no record', function () {
    const ast = buildLineAST(DAILY, { type: 'line', x: 'time', timeFormats: { day: 'dd.MM.yyyy' } });
    for (const t of ast.x.ticks) assert.match(t.label, /^\d\d\.\d\d\.\d{4}$/);
  });
});

describe('a time axis can be asked for a language', function () {
  it('should render Dutch weekday and month names on a daily line axis', function () {
    const ast = buildLineAST(DAILY, {
      type: 'line', x: 'time', dateNames: NL, timeFormats: { day: DAY_NAMED },
    });
    assert.equal(tickPlan(ast).step[0], 'day');
    assert.ok(ast.x.ticks.length >= 2);
    for (const t of ast.x.ticks) {
      const { weekday, month } = words(t.label);
      assert.ok(NL.weekdays.includes(weekday), `'${weekday}' is not a Dutch weekday`);
      assert.ok(NL.months.includes(month), `'${month}' is not a Dutch month`);
    }
  });

  it('should render Dutch names on a daily candlestick axis', function () {
    const ast = buildCandlestickAST(DAILY_CANDLES, {
      type: 'candlestick', dateNames: NL, timeFormats: { day: DAY_NAMED },
    });
    assert.equal(tickPlan(ast).step[0], 'day');
    for (const t of ast.x.ticks) {
      const { weekday, month } = words(t.label);
      assert.ok(NL.weekdays.includes(weekday));
      assert.ok(NL.months.includes(month));
    }
  });

  it('should keep the other granularities numeric unless overridden', function () {
    const label = compileTimeTickFormat({ dateNames: NL, timeFormats: { day: DAY_NAMED } });
    assert.equal(label(Date.UTC(2026, 6, 27, 14, 30), ['hour', 1]), '14:30');
    assert.equal(label(Date.UTC(2026, 6, 1), ['month', 1]), '2026-07');
    assert.equal(label(Date.UTC(2026, 6, 27), ['day', 1]), `${NL.weekdays[1]} 27 ${NL.months[6]}`);
  });

  it('should not let two charts on one page share a record', function () {
    const config = (names) => ({ type: 'line', x: 'time', dateNames: names, timeFormats: { day: DAY_NAMED } });
    const dutch = buildLineAST(DAILY, config(NL));
    const german = buildLineAST(DAILY, config(DE));
    assert.equal(dutch.x.ticks.length, german.x.ticks.length);
    for (let i = 0; i < dutch.x.ticks.length; i++) {
      const a = words(dutch.x.ticks[i].label);
      const b = words(german.x.ticks[i].label);
      assert.ok(NL.weekdays.includes(a.weekday) && !DE.weekdays.includes(a.weekday));
      assert.ok(DE.weekdays.includes(b.weekday) && !NL.weekdays.includes(b.weekday));
      assert.notEqual(dutch.x.ticks[i].label, german.x.ticks[i].label);
    }
  });
});

describe('a name token with no dateNames is the refusal the Gantt gives', function () {
  const chart = () => compileTimeTickFormat({ timeFormats: { day: DAY_NAMED } });
  const gantt = () => parseMermaid('gantt\naxisFormat %B\nsection S\nT : t1, 2024-01-01, 1d');

  it('should refuse at compile time, as a TypeError naming the member and the way out', function () {
    assert.throws(chart, TypeError);
    assert.throws(chart, REFUSAL);
    assert.throws(chart, NO_NAMES_OF_ITS_OWN);
    assert.throws(chart, /timeFormats\.day 'EEEE d MMMM'/);
    assert.throws(chart, /a 'dateNames' member on the chart definition/);
  });

  it('should refuse from a chart build, not only from the labeller', function () {
    assert.throws(() => buildLineAST(DAILY, { type: 'line', x: 'time', timeFormats: { month: 'MMMM yyyy' } }),
      /timeFormats\.month 'MMMM yyyy' asks for a locale name/);
    assert.throws(() => buildCandlestickAST(HOURLY, { type: 'candlestick', timeFormats: { minute: 'h:mm a' } }),
      /timeFormats\.minute 'h:mm a' asks for a locale name/);
  });

  it('should share its rule with the Mermaid Gantt, so the two cannot drift', function () {
    /** @type {string[]} */
    const messages = [];
    for (const raise of [chart, gantt]) {
      try { raise(); }
      catch (err) { messages.push(err instanceof Error ? err.message : String(err)); }
    }
    assert.equal(messages.length, 2, 'both components refuse');
    for (const message of messages) {
      assert.match(message, REFUSAL);
      assert.match(message, NO_NAMES_OF_ITS_OWN);
    }
  });

  it('should tell a broken pattern apart from a missing record', function () {
    assert.throws(() => compileTimeTickFormat({ timeFormats: { year: "'yyyy" } }),
      /timeFormats\.year '\x27yyyy' cannot be compiled: unterminated quoted literal/);
    assert.throws(() => compileTimeTickFormat({ timeFormats: { year: "'yyyy" } }),
      (err) => err instanceof TypeError && !REFUSAL.test(err.message));
  });
});

describe('the labeller is compiled once per render', function () {
  /** A names record that counts every property read. */
  function counting(names) {
    let reads = 0;
    const proxy = new Proxy(names, {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    return { proxy, reads: () => reads };
  }

  it('should read a name token once at compile time and once per label', function () {
    const { proxy, reads } = counting(NL);
    const label = compileTimeTickFormat({ dateNames: proxy, timeFormats: { day: 'EEEE d' } });
    assert.equal(reads(), 1, 'the compile step reads the weekdays array once');
    const n = 200;
    for (let i = 0; i < n; i++) label(Date.UTC(2026, 0, 1 + (i % 28)), ['day', 1]);
    assert.equal(reads(), n + 1, `${n} labels cost ${n} reads, not ${2 * n}`);
  });

  it('should compile once per line build, whatever the tick count', function () {
    const { proxy, reads } = counting(NL);
    const ast = buildLineAST(DAILY, {
      type: 'line', x: 'time', dateNames: proxy, timeFormats: { day: 'EEEE d' },
    });
    assert.ok(ast.x.ticks.length >= 2);
    assert.equal(reads(), ast.x.ticks.length + 1);
  });

  it('should not share the module default with a record-bearing labeller', function () {
    const label = compileTimeTickFormat({ dateNames: NL });
    assert.notEqual(label, formatTimeTick);
    assert.notEqual(compileTimeTickFormat({ dateNames: NL }), label);
  });
});

describe('no ambient locale reaches the axis', function () {
  it('should read neither Intl nor a locale pack in axis.js', function () {
    const source = fs.readFileSync(path.join(chartsRoot, 'src', 'core', 'axis.js'), 'utf8');
    assert.ok(!source.includes('resolvedOptions'));
    assert.ok(!source.includes('Intl.'));
    assert.ok(!source.includes('@jarenjs/locales'));
  });
});

describe('the schema admits the two members', function () {
  const schema = JSON.parse(fs.readFileSync(
    path.join(chartsRoot, 'schemas', 'chart-definition.schema.json'), 'utf8'));
  const validate = new JarenValidator().compile(schema);

  it('should accept a line and a candlestick definition carrying both', function () {
    const line = {
      type: 'line', x: 'time', dateNames: NL, timeFormats: { day: DAY_NAMED },
      series: [{ name: 'a', points: [{ x: 0, y: 1 }] }],
    };
    const candlestick = {
      type: 'candlestick', dateNames: DE, timeFormats: { day: DAY_NAMED, month: 'MMMM yyyy' },
      candles: [{ t: 0, open: 1, high: 2, low: 0, close: 1 }],
    };
    assert.equal(validate(line), true, `schema rejected ${JSON.stringify(line)}`);
    assert.equal(validate(candlestick), true, `schema rejected ${JSON.stringify(candlestick)}`);
  });

  it('should reject a malformed record or pattern set', function () {
    assert.equal(validate({ type: 'line', x: 'time', timeFormats: { day: 5 } }), false);
    assert.equal(validate({ type: 'line', x: 'time', dateNames: { months: 'juli' } }), false);
    assert.equal(validate({ type: 'candlestick', dateNames: { meridiem: ['a.m.'] } }), false);
  });
});
