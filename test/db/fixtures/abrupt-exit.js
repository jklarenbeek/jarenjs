import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';

/** Identify the exact crash boundary without running normal exit cleanup. */
export function crashAt(point) {
  writeSync(1, `crash:${point}\n`);
  process.on('exit', () => writeSync(1, 'graceful-exit\n'));
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL returned');
}

/** Windows reports a self-termination as an exit code, without a POSIX signal. */
export function assertCrash(child, point) {
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.stdout, `crash:${point}\n`, child.stderr);
  if (process.platform === 'win32' && child.signal === null) {
    assert.ok(Number.isInteger(child.status) && child.status !== 0, child.stderr);
  }
  else assert.equal(child.signal, 'SIGKILL', child.stderr);
}
