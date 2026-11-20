//@ts-check
/**
 * @file A validation whose schema references nest deeper than the host's
 * call stack holds is refused with the reference depth code (`JK2001`) in
 * place of the host's own error, and leaves the process as it found it:
 * the count of open references, the dynamic scope and every other validator
 * and normalizer answer afterwards as a fresh process answers.
 *
 * A loop closed through a schema already built counts one reference per
 * turn, however many levels a turn nests, so its count gives out far past
 * the stack: two definitions referencing each other through 10 members each
 * answer to 5,109 levels where the stack holds them. Every case runs in a
 * child process with a fixed stack, and none depends on where that stack
 * gives out: under the default bound a case asserts the class and the code
 * (on a host whose frames are smaller the count refuses first, with the
 * same code), and the stack is named only where the bound is raised past
 * any depth the instance has.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childReport } from '../lib/child-report.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/reference-stack/probe.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The report of one child: the deep call's refusal, then what the process
 * answers afterwards.
 * @param {number} stack - The child's stack, in kB
 * @param {Record<string, unknown>} scenario
 */
function probe(stack, scenario) {
  const run = spawnSync(process.execPath, [`--stack-size=${stack}`, FIXTURE, JSON.stringify(scenario)],
    { encoding: 'utf8', cwd: ROOT, env: { ...process.env, FORCE_COLOR: '0' } });
  const report = childReport(run);
  assert.equal(run.status, 0, run.stderr);
  return report;
}

/** What a fresh process answers, per mode and bound: no deep call first. */
const fresh = new Map();
/** @param {string} mode @param {number} [ceiling] */
function control(mode, ceiling) {
  const key = `${mode}/${ceiling}`;
  if (!fresh.has(key)) fresh.set(key, probe(500, { mode, ...(ceiling ? { ceiling } : {}) }).after);
  return fresh.get(key);
}

const MODES = ['first', 'collect'];
const SHAPES = [
  ['two', 'two definitions referencing each other through members'],
  ['items', 'two definitions through items, deeper than one is built inside the other'],
  ['dynamic', 'a $dynamicRef loop'],
  ['recursive', 'a $recursiveRef loop'],
];

describe('a reference loop the host\'s stack gives out under', () => {
  for (const [shape, title] of SHAPES) {
    for (const mode of MODES) {
      it(`is refused JK2001, and the process answers as a fresh one afterwards: ${title} (${mode})`, () => {
        // the deep call is the first call of the process: nothing it runs was run before
        const report = probe(500, { mode, exhaust: shape });
        assert.deepEqual([report.deep[0].name, report.deep[0].code], ['SchemaRuntimeError', 'JK2001']);
        assert.deepEqual(report.after, control(mode));
        // at the bound and one level past it; collecting errors takes more
        // stack a level, so there the comparison with the fresh process
        // above is the whole claim, and the bound is pinned on a large stack below
        if (mode === 'first') assert.deepEqual(report.after.self, [true, 'SchemaRuntimeError:JK2001']);
        assert.deepEqual(report.after.dynamic, [true, false, true]);
      });
    }
  }

  for (const mode of MODES) {
    it(`is refused JK2001 on a call the host has optimized too (${mode})`, () => {
      const report = probe(500, { mode, exhaust: 'two', warm: true });
      assert.deepEqual([report.deep[0].name, report.deep[0].code], ['SchemaRuntimeError', 'JK2001']);
      assert.deepEqual(report.after, control(mode));
    });
  }
});

describe('where the bound is raised past the instance, the stack alone refuses', () => {
  const CEILING = 1e9;

  for (const mode of MODES) {
    it(`names the stack, the reference the nesting was entered at, both repairs and the host's error (${mode})`, () => {
      const report = probe(500, { mode, exhaust: 'two', ceiling: CEILING });
      const [deep] = report.deep;
      assert.deepEqual([deep.name, deep.code, deep.cause], ['SchemaRuntimeError', 'JK2001', 'the host\'s stack refusal']);
      assert.equal(deep.message, 'JK2001: validation nests schema references deeper than this host\'s call stack holds, entered at http://depth.test/two#'
        + ' (nest the instance less deeply, or give the process a larger stack)');
      assert.deepEqual(report.after, control(mode, CEILING));
    });
  }

  it('refuses a normalization alike, naming it', () => {
    const report = probe(500, { mode: 'first', exhaust: 'normalizer', ceiling: CEILING });
    const [deep] = report.deep;
    assert.deepEqual([deep.name, deep.code, deep.cause], ['SchemaRuntimeError', 'JK2001', 'the host\'s stack refusal']);
    assert.match(deep.message, /^JK2001: normalization nests schema references deeper than this host's call stack holds, entered at \S+ \(nest the instance less deeply, or give the process a larger stack\)$/);
    assert.deepEqual(report.after, control('first', CEILING));
  });

  it('leaves no anchor in the dynamic scope (the loose tree was then read by the strict one)', () => {
    // the strict tree is the first deep call: its anchor is the outermost in scope when the stack gives out
    const report = probe(500, { mode: 'first', exhaust: 'two', strictTree: 100000, ceiling: CEILING });
    assert.deepEqual([report.tree.name, report.tree.code], ['SchemaRuntimeError', 'JK2001']);
    assert.deepEqual(report.after.dynamic, [true, false, true]);
    assert.deepEqual(report.after, control('first', CEILING));
  });
});

describe('what answered before a stack gave out answers as before', () => {
  it('two definitions through 10 members each: true at 5,109 levels, refused by the count at 5,110 (first failure)', () => {
    const report = probe(4000, { mode: 'first', exhaust: 'two', depths: [5109, 5110] });
    assert.deepEqual(report.deep[0], { answered: true });
    assert.deepEqual([report.deep[1].code, report.deep[1].byStack, report.deep[1].cause], ['JK2001', false, null]);
    assert.match(report.deep[1].message, /^JK2001: validation nests more than 256 schema references at http:\/\/depth\.test\/two#\/\$defs\/a\//);
    assert.deepEqual(report.after.self, [true, 'SchemaRuntimeError:JK2001']);
  });

  it('the same collecting errors, on a call the host has optimized', () => {
    const report = probe(4000, { mode: 'collect', exhaust: 'two', warm: true, depths: [5109, 5110] });
    assert.deepEqual(report.deep[0], { answered: true });
    assert.deepEqual([report.deep[1].code, report.deep[1].byStack, report.deep[1].cause], ['JK2001', false, null]);
  });

  it('two definitions through 3 members each: true at 1,532 levels, refused by the count at 1,533 (collecting errors)', () => {
    const report = probe(4000, { mode: 'collect', exhaust: 'two3', depths: [1532, 1533] });
    assert.deepEqual(report.deep[0], { answered: true });
    assert.deepEqual([report.deep[1].code, report.deep[1].byStack, report.deep[1].cause], ['JK2001', false, null]);
    assert.deepEqual(report.after.self, [true, 'SchemaRuntimeError:JK2001']);
  });
});
