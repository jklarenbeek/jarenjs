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
function run(rounds, body) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-rounds-'));
  const log = join(dir, 'rounds.jsonl');
  try {
    const env = { ...process.env, BENCH_ROUNDS_LOG: log };
    if (rounds === undefined) delete env.BENCH_ROUNDS;
    else env.BENCH_ROUNDS = rounds;
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
    const median = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    };
    assert.strictEqual(out.row, median(log[0].rounds));
    assert.strictEqual(out.few, median(log[1].rounds));
    assert.strictEqual(out.even, median(log[2].rounds));
  });

  it('refuses a round count that is not a positive integer', () => {
    for (const rounds of ['0', '-2', '1.5', 'many'])
      assert.throws(() => run(rounds, 'console.log("{}")'), /BENCH_ROUNDS must be a positive integer/);
  });
});
