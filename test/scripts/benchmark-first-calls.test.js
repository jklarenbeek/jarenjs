//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { firstCallsCell, timeFirstCalls } from '../../benchmark/lib/first-calls.js';

const MODULE = new URL('../../benchmark/lib/first-calls.js', import.meta.url).href;

describe('first calls', () => {
  it('time an operation\'s first calls cumulatively, with nothing called before them', async () => {
    const seen = [];
    const out = await timeFirstCalls((i) => { seen.push(i); }, [3, 10]);
    assert.deepStrictEqual(seen, Array.from({ length: 10 }, (_, i) => i));
    assert.deepStrictEqual(Object.keys(out), ['3', '10']);
    assert.ok(out[3] > 0 && out[10] > 0);
    let awaited = 0;
    await timeFirstCalls(async () => { awaited++; }, [5], { awaited: true });
    assert.strictEqual(awaited, 5);
  });

  it('refuse a sync operation that returns a promise', async () => {
    await assert.rejects(timeFirstCalls(async () => 1, [10]), /returned a promise/);
  });

  it('read a child\'s cell from its arguments, and refuse half of one', () => {
    assert.strictEqual(firstCallsCell(['node', 'suite.js', '--profile']), null);
    assert.deepStrictEqual(firstCallsCell(['node', 'suite.js', '--first-calls', 'small/jaren', '--first-calls-out', '/tmp/x.json']),
      { caseKey: 'small', engineKey: 'jaren', out: '/tmp/x.json' });
    assert.throws(() => firstCallsCell(['node', 'suite.js', '--first-calls', 'small']), /<case>\/<engine>/);
    assert.throws(() => firstCallsCell(['node', 'suite.js', '--first-calls', 'small/jaren']), /--first-calls-out/);
  });

  it('measure every cell in fresh children of the suite, a skipped cell left null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-first-calls-test-'));
    try {
      const script = join(dir, 'suite.mjs');
      writeFileSync(script, `
        import { writeFileSync } from 'node:fs';
        import { firstCallsCell, measureFirstCalls, runFirstCallsCell } from ${JSON.stringify(MODULE)};
        const cell = firstCallsCell();
        if (cell !== null) {
          // a fresh process: nothing ran before this cell's first call
          await runFirstCallsCell(cell, (c, e) => ({ op: () => c + e }), [2, 4]);
          process.exit(0);
        }
        const result = measureFirstCalls(import.meta.url, {
          operation: 'a concatenation', counts: [2, 4],
          cases: [{ key: 'a', name: 'case a' }, { key: 'b', name: 'case b' }],
          engines: [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }],
          skip: (c, e) => c === 'b' && e === 'y',
        });
        writeFileSync(${JSON.stringify(join(dir, 'out.json'))}, JSON.stringify(result));
      `);
      execFileSync(process.execPath, [script], { env: { ...process.env, BENCH_FIRST_PROCESSES: '2' }, stdio: 'ignore', timeout: 30_000 });
      const result = JSON.parse(execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(dir, 'out.json'))}, 'utf8'))`], { encoding: 'utf8' }));
      assert.deepStrictEqual([result.operation, result.counts, result.processes], ['a concatenation', [2, 4], 2]);
      assert.deepStrictEqual(result.tables.map((t) => t.title), [
        'First 2 calls in a fresh process — a concatenation',
        'First 4 calls in a fresh process — a concatenation',
      ]);
      for (const t of result.tables) {
        assert.deepStrictEqual(t.columns, ['X', 'Y']);
        assert.deepStrictEqual(t.rows.map((r) => r.name), ['case a', 'case b']);
        assert.ok(t.rows[0].results.every((ns) => ns > 0) && t.rows[1].results[0] > 0);
        assert.strictEqual(t.rows[1].results[1], null);
      }
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
