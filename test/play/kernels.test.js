//@ts-check
/**
 * @file The kernels engine calls the `@jarenjs/core` functions the `$query`
 * operators run — geo, dates, math, text — directly over a JSON array of
 * arguments, and shows the operator document that runs the same kernel over
 * the same arguments, with that document's answer beside it and a verdict
 * on the two only where both answer.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { runExample, ENGINES, EXAMPLES } from '@jarenjs/play';

/** @param {any} r @param {string} id */
const panel = (r, id) => r.panels.find((p) => p.id === id);
/** @param {string} kernel @param {any[] | string} args */
const run = (kernel, args) => /** @type {any} */ (runExample('kernels',
  { args: typeof args === 'string' ? args : JSON.stringify(args) }, {}, { config: { kernel } }));

describe('@jarenjs/play — the kernels engine', () => {
  it('declares an arguments pane, no data pane and a kernel choice per family', () => {
    const e = ENGINES.kernels;
    assert.ok(e, 'a kernels descriptor is registered');
    assert.deepEqual(e.sourcePanes.map((p) => p.key), ['args']);
    assert.deepEqual(e.dataPanes, []);
    const [pane] = e.optionPanes;
    assert.equal(pane.key, 'kernel');
    assert.deepEqual(pane.choices.map((c) => c.value),
      ['geoDistance', 'geohashEncode', 'addDuration', 'compileDateFormat', 'roundExact', 'compileIRegexp']);
    assert.deepEqual([...new Set(pane.choices.map((c) => c.label.split(' · ')[0]))], ['geo', 'dates', 'math', 'text']);
  });

  it('answers each kernel exactly, and the $query operator that runs it answers the same', () => {
    for (const [kernel, args, answer, operator] of [
      ['geoDistance', [[4.9041, 52.3676], [2.3522, 48.8566]], 429861.983446582, '$distance'],
      ['geohashEncode', [4.9041, 52.3676, 7], 'u173zt5', '$geohash'],
      ['addDuration', ['2026-01-31T10:00:00Z', 'P1M'], '2026-02-28T10:00:00Z', '$date-add'],
      ['compileDateFormat', ["yyyy-MM-dd 'at' HH:mm", '2026-07-27T14:30:05+02:00'], '2026-07-27 at 14:30', '$date-format'],
      ['roundExact', [1.005, 2, 'half-up'], 1, '$round'],
      ['roundExact', [2.5, 0, 'half-even'], 2, '$round-half-to-even'],
      ['compileIRegexp', ['[a-z]+-[0-9]{2}', 'abc-12'], true, '$match'],
      ['compileIRegexp', ['a+', 'xaay'], false, '$match'],
    ]) {
      const r = run(/** @type {string} */ (kernel), /** @type {any[]} */ (args));
      assert.equal(r.ok, true, `${kernel}: ${r.error?.message}`);
      assert.deepEqual(JSON.parse(panel(r, 'out').text), answer, kernel);
      assert.equal(r.timing.compileMs, null);
      assert.deepEqual(Object.keys(JSON.parse(panel(r, 'query').text)), [operator], kernel);
      assert.deepEqual(panel(r, 'agree').items.map((i) => i.value), [JSON.stringify(answer), 'yes'], kernel);
    }
  });

  it('compares only arguments both doors answer, and says which door did not', () => {
    for (const [kernel, args, out, answers, same] of [
      // the kernel defaults a precision the operator reads as the empty sequence
      ['geohashEncode', [4.9041, 52.3676], '"u173zt5p3"', /^refused — JQ2001: /, 'not compared — $query refuses with JQ2001'],
      ['geohashEncode', [4.9041, 52.3676, 13], '"u173zt5p3u1vz"', /^refused — JQ2001: /, 'not compared — $query refuses with JQ2001'],
      ['roundExact', [1.005], '1', /^refused — JQ2001: /, 'not compared — $query refuses with JQ2001'],
      ['roundExact', [null, 2, 'half-up'], 'null', /^refused — JQ2001: /, 'not compared — $query refuses with JQ2001 and the kernel answers null'],
      // an invalid pattern is no regexp to the kernel and no match to $match
      ['compileIRegexp', ['(?=a)', 'a'], 'null', /^false$/, 'not compared — the kernel answers null'],
      ['geoDistance', [[0, 0]], 'null', /^\(no result\)$/, 'not compared — the kernel answers null and $query nothing'],
      ['geohashEncode', [null, 52, 5], '"u10pb"', /^\(no result\)$/, 'not compared — $query answers nothing'],
      ['roundExact', [], '(no result)', /^\(no result\)$/, 'not compared — the kernel answers nothing and $query nothing'],
      // both answer: the verdict compares them
      ['geohashEncode', [4.9041, 200, 5], '"upgrz"', /^"upgrz"$/, 'yes'],
      ['compileIRegexp', ['a', 'b'], 'false', /^false$/, 'yes'],
    ]) {
      const r = run(/** @type {string} */ (kernel), /** @type {any[]} */ (args));
      assert.equal(r.ok, true, `${kernel}: ${r.error?.message}`);
      assert.equal(panel(r, 'out').text, out, `${kernel} ${JSON.stringify(args)}`);
      const [answered, verdict] = panel(r, 'agree').items.map((i) => i.value);
      assert.match(answered, /** @type {RegExp} */ (answers), `${kernel} ${JSON.stringify(args)}`);
      assert.equal(verdict, same, `${kernel} ${JSON.stringify(args)}`);
    }
  });

  it('every library example reads the same answer through both doors', () => {
    for (const example of EXAMPLES.filter((e) => e.engine === 'kernels')) {
      const r = /** @type {any} */ (runExample('kernels', example.source, {}, { config: example.config }));
      assert.equal(r.ok, true, example.id);
      assert.equal(panel(r, 'agree').items[1].value, 'yes', example.id);
    }
  });

  it('shows the ECMAScript RegExp an I-Regexp compiles to', () => {
    assert.equal(panel(run('compileIRegexp', ['[a-z]+', 'abc']), 'regexp').text, '/^(?:[a-z]+)$/u');
  });

  it('a kernel answer null is an answer (an invalid pattern is no regexp)', () => {
    const r = run('compileIRegexp', ['(?=a)', 'a']);
    assert.equal(r.ok, true);
    assert.equal(panel(r, 'out').text, 'null');
  });

  it('a date the parse kernel refuses is located at the arguments pane, naming the kernel', () => {
    const r = run('addDuration', ['not a date', 'P1D']);
    assert.equal(r.ok, false);
    assert.equal(r.error.pane, 'args');
    assert.match(r.error.message, /parseRFC3339Parts/);
  });

  it('an I-Regexp is tested against a string, never a number coerced to one', () => {
    const r = run('compileIRegexp', ['[0-9]+', 42]);
    assert.equal(r.ok, false);
    assert.equal(r.error.pane, 'args');
  });

  it('a pattern that is not a string is no I-Regexp, as a number already answered', () => {
    for (const pattern of [null, ['a'], 42, {}]) {
      const r = run('compileIRegexp', [pattern, 'a']);
      assert.equal(r.ok, true, `${JSON.stringify(pattern)}: ${r.error?.message}`);
      assert.equal(panel(r, 'out').text, 'null');
      assert.equal(panel(r, 'regexp'), undefined);
      assert.equal(panel(r, 'agree').items[1].value, 'not compared — $query refuses with JQ2001 and the kernel answers null');
    }
  });

  it('refuses arguments that are not a JSON array at the arguments pane', () => {
    for (const args of ['{"a":1}', '{broken', '']) {
      const r = run('geoDistance', args);
      assert.equal(r.ok, false, args);
      assert.equal(r.error.pane, 'args', args);
    }
  });

  it('a kernel value it does not offer is the default kernel, never an inherited member', () => {
    for (const kernel of ['constructor', '__proto__', 'toString', 'nope']) {
      const r = run(kernel, [[0, 0], [0, 1]]);
      assert.equal(r.ok, true, `${kernel}: ${r.error?.message}`);
      assert.deepEqual(Object.keys(JSON.parse(panel(r, 'query').text)), ['$distance'], kernel);
    }
  });

  it('the library shows every kernel', () => {
    const shown = new Set(EXAMPLES.filter((e) => e.engine === 'kernels').map((e) => e.config?.kernel));
    assert.deepEqual(ENGINES.kernels.optionPanes[0].choices.map((c) => c.value).filter((v) => !shown.has(v)), []);
  });
});
