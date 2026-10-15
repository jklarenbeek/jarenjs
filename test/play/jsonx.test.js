//@ts-check
/**
 * @file The JSONX engine reads JSONX — JSON plus bigint, regexp, datetimes
 * and non-finite numbers — as an INPUT dialect: it answers the JSON the other
 * engines' data panes read, and names every value that JSON writes
 * differently, rather than handing a regexp on as `{}` or throwing on a bigint.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { runExample, ENGINES, EXAMPLES } from '@jarenjs/play';

/** @param {any} r @param {string} id */
const panel = (r, id) => r.panels.find((p) => p.id === id);
/** @param {string} text @param {string} [mode] */
const run = (text, mode) => /** @type {any} */ (runExample('jsonx', { text }, {}, { config: mode ? { mode } : {} }));

describe('@jarenjs/play — the JSONX engine reads JSONX as data', () => {
  it('declares one source pane, no data pane and a dialect option', () => {
    const e = ENGINES.jsonx;
    assert.ok(e, 'a jsonx descriptor is registered');
    assert.deepEqual(e.sourcePanes.map((p) => p.key), ['text']);
    assert.deepEqual(e.dataPanes, []);
    assert.deepEqual(e.optionPanes.map((p) => [p.key, p.default, p.choices.map((c) => c.value)]), [['mode', 'jsonx', ['jsonx', 'json']]]);
  });

  it('a document every value of which JSON can spell answers that JSON, with a calm note', () => {
    const r = run('{ "name": "Ada", "count": 1_000, "ratio": +0.5, "tags": ["a", "b"] }');
    assert.equal(r.ok, true, r.error?.message);
    assert.equal(panel(r, 'out').text, JSON.stringify({ name: 'Ada', count: 1000, ratio: 0.5, tags: ['a', 'b'] }, null, 2));
    assert.equal(panel(r, 'kept').tone, 'ok');
    assert.equal(panel(r, 'kept').depth, undefined);
  });

  it('names each value JSON writes differently, at its JSON Pointer', () => {
    const r = run('{ "re": /a+/g, "n": [nan, inf], "at": 2026-07-18T12:00:00Z, "day": 2026-07-18, "clock": 12:30:00, "local": 2026-07-18T12:00:00 }');
    assert.equal(r.ok, true, r.error?.message);
    assert.equal(panel(r, 'out').text, JSON.stringify({
      re: {}, n: [null, null], at: '2026-07-18T12:00:00.000Z', day: '2026-07-18', clock: '12:30:00', local: '2026-07-18T12:00:00',
    }, null, 2));
    const kept = panel(r, 'kept');
    assert.equal(kept.tone, 'warn');
    assert.deepEqual(kept.text.split('\n').slice(1), [
      '/re: a regexp — JSON writes {}',
      '/n/0: nan — JSON writes null',
      '/n/1: inf — JSON writes null',
      '/at: an instant — JSON writes the string "2026-07-18T12:00:00.000Z"',
      '/day: a local date — JSON writes the string "2026-07-18"',
      '/clock: a local time — JSON writes the string "12:30:00"',
      '/local: a local date-time — JSON writes the string "2026-07-18T12:00:00"',
    ]);
  });

  it('a bigint has no JSON spelling: no JSON panel, the note says why, and the JSONX round-trip keeps it', () => {
    const r = run('{ "big": 9007199254740993n, "small": 1 }');
    assert.equal(r.ok, true, r.error?.message);
    assert.equal(panel(r, 'out'), undefined);
    assert.deepEqual(panel(r, 'kept').text.split('\n').slice(1), ['/big: a bigint — JSON has no spelling for it, so JSON.stringify refuses the document']);
    assert.equal(panel(r, 'roundtrip').text, '{\n  "big": 9007199254740993n,\n  "small": 1\n}');
    assert.equal(panel(r, 'roundtrip').depth, 'deep');
  });

  it('a member named like a loss is no loss: only a bigint VALUE drops the JSON screen', () => {
    const r = run('{ "a bigint": /x/ }');
    assert.equal(panel(r, 'out').text, '{\n  "a bigint": {}\n}');
    assert.deepEqual(panel(r, 'kept').text.split('\n').slice(1), ['/a bigint: a regexp — JSON writes {}']);
  });

  it('escapes a member name in a pointer (RFC 6901), and drills down into the document-order events', () => {
    const r = run('{ "a/b": { "t~x": 1n } }');
    assert.deepEqual(panel(r, 'kept').text.split('\n').slice(1), ['/a~1b/t~0x: a bigint — JSON has no spelling for it, so JSON.stringify refuses the document']);
    assert.deepEqual(panel(r, 'events').rows, [
      ['open', '(root)', 'object'], ['open', '/a~1b', 'object'], ['value', '/a~1b/t~0x', '1n'], ['close', '/a~1b', ''], ['close', '(root)', ''],
    ]);
  });

  it('strict JSON mode refuses an extension at its line and column, at the source pane', () => {
    const r = run('{ "a": 1n }', 'json');
    assert.equal(r.ok, false);
    assert.equal(r.error.pane, 'text');
    assert.equal(r.error.line, 1);
    assert.equal(r.error.column, 9);
    assert.equal(run('{ "a": 1 }', 'json').ok, true);
  });

  it('the library shows both dialects', () => {
    const shown = new Set(EXAMPLES.filter((e) => e.engine === 'jsonx').map((e) => e.config?.mode));
    assert.deepEqual(ENGINES.jsonx.optionPanes[0].choices.map((c) => c.value).filter((v) => !shown.has(v)), []);
  });
});

describe('@jarenjs/play — the JOSL engine\'s event paths are JSON Pointers too', () => {
  it('escapes ~ and / in a member name, where it printed /a/b for the one key "a/b"', () => {
    const r = /** @type {any} */ (runExample('josl', { text: '"a/b" = 1\n"t~x" = { y = 2 }\n' }, {}, { config: { mode: 'josl' } }));
    assert.deepEqual(panel(r, 'events').rows.map((row) => row[1]), ['/a~1b', '/t~0x']);
  });
});
