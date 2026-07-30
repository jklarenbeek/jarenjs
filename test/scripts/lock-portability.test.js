//@ts-check
/**
 * The lock portability gate, driven end-to-end against the real lock and a
 * deliberately pruned one. The doctored case is the teeth: npm 10's writer
 * silently drops other platforms' exact optional records (npm/cli#7961), and
 * a gate that cannot flag a hand-pruned lock would not flag that either.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'check-lock-portability.js');
const LOCK = join(ROOT, 'package-lock.json');

/** Run the gate on a lock file; return { status, output }. */
function runGate(lockPath) {
  const result = /** @type {{status: number|null, stdout: string, stderr: string}} */ (
    /** @type {unknown} */ (execFileSyncSafe(lockPath)));
  return result;
}

function execFileSyncSafe(lockPath) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, lockPath], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  }
  catch (error) {
    const e = /** @type {{status?: number, stdout?: string, stderr?: string}} */ (error);
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('check-lock-portability', () => {
  it('passes the repository lock', () => {
    const { status, stdout } = runGate(LOCK);
    assert.strictEqual(status, 0, stdout);
    assert.match(stdout, /Lock portability gate passed/);
  });

  it('fails a lock whose exact optional records were pruned, naming the hole', () => {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    // Prune every record of one exact optional dependency that some parent
    // declares — the exact shape npm/cli#7961 produces. Derive the victim
    // from the lock itself so this test never hard-codes a vendor.
    let victim = null;
    let parent = null;
    const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
    for (const [key, record] of Object.entries(lock.packages)) {
      for (const [name, wanted] of Object.entries(record.optionalDependencies ?? {})) {
        if (typeof wanted === 'string' && exact.test(wanted)) {
          victim = name;
          parent = key;
          break;
        }
      }
      if (victim !== null) break;
    }
    assert.ok(victim !== null && parent !== null,
      'the lock declares no exact optional dependencies at all — the gate would be vacuous');

    for (const key of Object.keys(lock.packages)) {
      if (key === `node_modules/${victim}` || key.endsWith(`/node_modules/${victim}`))
        delete lock.packages[key];
    }

    const dir = mkdtempSync(join(tmpdir(), 'jaren-lock-gate-'));
    try {
      const pruned = join(dir, 'package-lock.json');
      writeFileSync(pruned, JSON.stringify(lock));
      const { status, stderr } = runGate(pruned);
      assert.strictEqual(status, 1, 'a pruned lock must fail the gate');
      assert.ok(stderr.includes(victim),
        `the failure must name the missing package (${victim}):\n${stderr}`);
      assert.match(stderr, /npm\/cli#7961/);
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
