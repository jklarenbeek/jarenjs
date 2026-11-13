//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MEASURE = new URL('../../benchmark/lib/measure.js', import.meta.url).href;

/**
 * Run `body` as a module in a child whose environment sets the round
 * count (it is read once, when the helpers load); return its stdout
 * parsed as JSON and the rounds log it wrote.
 * @param {string | undefined} rounds
 * @param {string} body
 */
function run(rounds, body, method = undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-rounds-'));
  const log = join(dir, 'rounds.jsonl');
  try {
    const env = { ...process.env, BENCH_ROUNDS_LOG: log };
    if (rounds === undefined) delete env.BENCH_ROUNDS;
    else env.BENCH_ROUNDS = rounds;
    if (method === undefined) delete env.BENCH_METHOD;
    else env.BENCH_METHOD = method;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import * as m from ${JSON.stringify(MEASURE)};\n${body}`],
    { cwd: ROOT, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    let lines = [];
    try { lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch { /* no row was timed */ }
    return { out: JSON.parse(stdout), log: lines };
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {number[]} xs */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

describe('benchmark rows are timed in rounds', () => {
  it('makes the same calls whatever the round count, the index running on across rounds', () => {
    const body = `
      const seen = [];
      const measure = m.makeMeasure(3, 20);
      measure('row', (i) => { seen.push(i); });
      let plain = 0;
      m.measureNsPerOp(() => { plain++; }, 11, 4);
      let corpus = 0;
      m.timeIt(() => { corpus++; }, 5);
      let awaited = 0;
      await m.measureNsPerOpAsync(async () => { awaited++; }, 9, 2);
      console.log(JSON.stringify({ seen, plain, corpus, awaited }));`;
    const expected = {
      seen: [0, 1, 2, ...Array.from({ length: 20 }, (_, i) => i)],
      plain: 15, corpus: 7, awaited: 11,
    };
    for (const rounds of ['1', '7', '30'])
      assert.deepStrictEqual(run(rounds, body).out, expected, `BENCH_ROUNDS=${rounds}`);
  });

  it('reports the median round and logs every round, never more rounds than calls', () => {
    const { out, log } = run('7', `
      const row = m.makeMeasure(0, 70)('row', () => {});
      const few = m.measureNsPerOp(() => {}, 3, 0);
      const even = m.measureNsPerOp(() => {}, 4, 0);
      console.log(JSON.stringify({ row: row.ns, few, even }));`);
    assert.strictEqual(log.length, 3);
    assert.deepStrictEqual(log.map((l) => [l.seq, l.label, l.rounds.length]), [[0, 'row', 7], [1, null, 3], [2, null, 4]]);
    assert.strictEqual(out.row, median(log[0].rounds));
    assert.strictEqual(out.few, median(log[1].rounds));
    assert.strictEqual(out.even, median(log[2].rounds));
  });

  it('refuses a round count that is not a positive integer', () => {
    for (const rounds of ['0', '-2', '1.5', 'many'])
      assert.throws(() => run(rounds, 'console.log("{}")'), /BENCH_ROUNDS must be a positive integer/);
  });
});

describe('the settled method', () => {
  it('warms a row by the clock, sizes its rounds by the clock and reports its median round', () => {
    const { out, log } = run(undefined, `
      let calls = 0;
      const ns = m.measureNsPerOp(() => { calls++; }, 10, 0);
      console.log(JSON.stringify({ ns, calls }));`, 'settled');
    assert.strictEqual(log.length, 1);
    const [row] = log;
    assert.strictEqual(row.method, 'settled');
    assert.strictEqual(row.rounds.length, 7);
    assert.strictEqual(out.ns, median(row.rounds));
    assert.ok(row.warmMs >= 50, `warmed ${row.warmMs} ms`);
    assert.ok(row.roundCalls * 7 === row.calls && row.calls > 70, 'rounds are sized by the clock, past the iteration floor');
    assert.ok(out.calls > row.calls, 'the warm-up calls come on top of the timed ones');
    assert.strictEqual(typeof row.settled, 'boolean');
  });

  it('makes exactly the caller\'s calls for a row marked fixedCalls', () => {
    const { out, log } = run(undefined, `
      let calls = 0;
      const measure = m.makeMeasure(3, 20);
      measure('fixed', () => { calls++; }, { fixedCalls: true });
      console.log(JSON.stringify({ calls }));`, 'settled');
    assert.strictEqual(out.calls, 23);
    assert.deepStrictEqual([log[0].label, log[0].fixedCalls, log[0].rounds.length, log[0].calls], ['fixed', true, 7, 20]);
  });

  it('replays a row on fresh state once per round for a row given fresh', () => {
    const { out, log } = run(undefined, `
      let state = 0;
      let builds = 0;
      const seen = [];
      const measure = m.makeMeasure(3, 20);
      measure('session', (i) => { seen.push([state, i]); }, { fresh: () => { builds++; state++; } });
      console.log(JSON.stringify({ builds, calls: seen.length, first: seen.slice(0, 4), last: seen.at(-1) }));`, 'settled');
    // two untimed passes warm the code, then 21 timed ones
    assert.deepStrictEqual(out, { builds: 22, calls: 23 * 23, first: [[0, 0], [0, 1], [0, 2], [0, 0]], last: [22, 19] });
    assert.deepStrictEqual([log[0].fixedCalls, log[0].sessions, log[0].warmSessions, log[0].rounds.length, log[0].calls], [true, 23, 2, 21, 420]);
    const block = run(undefined, `
      let builds = 0;
      let calls = 0;
      m.makeMeasure(3, 20)('session', () => { calls++; }, { fresh: () => { builds++; } });
      console.log(JSON.stringify({ builds, calls }));`);
    assert.deepStrictEqual(block.out, { builds: 0, calls: 23 }, 'the one-block method runs the one session the caller built');
  });

  it('refuses a sync row that returns a promise', () => {
    // timed unawaited, a row's pending calls pile up until the loop yields:
    // a parser whose parse() was async filled a two-gigabyte heap this way
    const { out, log } = run(undefined, `
      let message = null;
      try { m.makeMeasure(1, 10)('async parse', async () => 1); }
      catch (e) { message = e.message; }
      console.log(JSON.stringify({ message, ns: m.measureNsPerOp(() => 1, 10, 1) > 0 }));`, 'settled');
    assert.deepStrictEqual(out, { message: "row 'async parse' returned a promise: time it with the awaited helpers", ns: true });
    assert.strictEqual(log.length, 1, 'only the sync row was timed');
  });

  it('stops counting collections when a row throws while it warms', () => {
    // a profiler left running records every later collection: a suite that
    // catches an engine's refusal and moves on grew by gigabytes
    const { out } = run(undefined, `
      const v8 = await import('node:v8');
      let running = 0;
      const { start, stop } = v8.GCProfiler.prototype;
      v8.GCProfiler.prototype.start = function () { running++; return start.call(this); };
      v8.GCProfiler.prototype.stop = function () { running--; return stop.call(this); };
      let thrown = 0;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        try { m.measureNsPerOp(() => { if (performance.now() - t0 > 40) throw new Error('refused'); }, 10, 0); }
        catch { thrown++; }
      }
      console.log(JSON.stringify({ running, thrown }));`, 'settled');
    assert.deepStrictEqual(out, { running: 0, thrown: 3 });
  });

  it('refuses a method it does not know', () => {
    assert.throws(() => run(undefined, 'console.log("{}")', 'fastest'), /BENCH_METHOD must be 'block' or 'settled'/);
  });
});
