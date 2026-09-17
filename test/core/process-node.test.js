//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createProcessExecutor } from '@jarenjs/core/process-node';

const config = extra => ({ cwd: process.cwd(), allow: { node: { argv0: process.execPath,
  args: args => args.length === 2 && args[0] === '-e' } }, timeoutMs: 2000, graceMs: 200, ...extra });

it('runs a named native command with captured stdin, bounded streams and a restricted environment', async () => {
  const executor = createProcessExecutor(config({ env: { allow: ['JAREN_PROCESS_TEST'] }, maxStdoutBytes: 4, maxStderrBytes: 3 }));
  try {
    const result = await executor.run({ name: 'node', args: ['-e', "process.stdin.on('data',x=>{process.stdout.write(x);process.stderr.write(process.env.JAREN_PROCESS_TEST)});"],
      input: 'abcdef', env: { JAREN_PROCESS_TEST: 'xyzmore' } });
    assert.equal(result.exitCode, 0); assert.equal(result.settlement, 'closed');
    assert.equal(result.stdout, 'abcd'); assert.equal(result.stderr, 'xyz');
    assert.deepEqual(result.truncated, { stdout: true, stderr: true });
    assert.equal(executor.stats().active, 0);
  } finally { await executor.close(); }
});

it('refuses commands, full argv mismatches, environment and cwd escapes before spawning', async () => {
  let spawns = 0;
  const executor = createProcessExecutor(config({ allow: { node: { argv0: process.execPath, args: [/--version/m] } },
    spawn: () => { spawns++; throw new Error('unexpected'); } }));
  try {
    for (const [request, reason] of [[{ name: 'other' }, 'unknown-command'],
      [{ name: 'node', args: ['x--version'] }, 'argument-rejected'],
      [{ name: 'node', args: ['--version\n'] }, 'argument-rejected'],
      [{ name: 'node', args: ['junk\n--version\n'] }, 'argument-rejected'],
      [{ name: 'node', args: '--version' }, 'argument-rejected'],
      [{ name: 'node', args: ['--version', 'extra'] }, 'argument-rejected'],
      [{ name: 'node', args: ['--version'], env: { PRIVATE: 'x' } }, 'env-rejected'],
      [{ name: 'node', args: ['--version'], cwd: '..' }, 'cwd-escape'],
      [{ name: 'node', args: ['--version'], signal: AbortSignal.abort() }, 'cancelled']])
      assert.equal((await executor.run(request)).refused, reason);
    assert.equal(spawns, 0);
  } finally { await executor.close(); }
  assert.equal((await executor.run({ name: 'node' })).refused, 'closed');
});

it('times out and aborts native children, keeping finite admission until close', async () => {
  const executor = createProcessExecutor(config({ maxOwners: 1, timeoutMs: 80 }));
  try {
    const pending = executor.run({ name: 'node', args: ['-e', 'setInterval(()=>{},1000)'] });
    assert.equal((await executor.run({ name: 'node', args: ['-e', ''] })).refused, 'capacity');
    const timed = await pending;
    assert.equal(timed.reason, 'timeout'); assert.equal(timed.settlement, 'closed');
    const controller = new AbortController();
    const request = { name: 'node', args: ['-e', 'setInterval(()=>{},1000)'], signal: controller.signal };
    const aborted = executor.run(request); request.signal = AbortSignal.abort(); controller.abort();
    assert.equal((await aborted).reason, 'cancelled');
    assert.equal(executor.stats().active, 0);
  } finally { await executor.close(); }
});

it('retains unresolved injected ownership and releases it only on actual close', async () => {
  const child = new EventEmitter(); child.pid = 123;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => true;
  const executor = createProcessExecutor(config({ tree: 'child', maxOwners: 1, timeoutMs: 10, graceMs: 10, spawn: () => child }));
  const result = await executor.run({ name: 'node', args: ['-e', ''] });
  assert.equal(result.settlement, 'unresolved'); assert.equal(result.reason, 'timeout');
  assert.equal(executor.stats().active, 1);
  assert.equal((await executor.run({ name: 'node', args: ['-e', ''] })).refused, 'capacity');
  child.emit('close', null, 'SIGKILL');
  assert.equal(executor.stats().active, 0); await executor.close();
  child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
});

it('reports synchronous spawn failure and validates limits', async () => {
  const executor = createProcessExecutor(config({ spawn: () => { throw new Error('private detail'); } }));
  const result = await executor.run({ name: 'node', args: ['-e', ''] });
  assert.equal(result.reason, 'spawn-error'); assert.equal(executor.stats().active, 0);
  assert.ok(!JSON.stringify(result).includes('private detail')); await executor.close();
  assert.throws(() => createProcessExecutor(config({ timeoutMs: Infinity })));
  assert.throws(() => createProcessExecutor(config({ allow: { bad: { argv0: 'node' } } })));
});

it('signals a native POSIX child group including descendants', { skip: process.platform === 'win32' }, async () => {
  const executor = createProcessExecutor(config({ timeoutMs: 300, graceMs: 500 }));
  try {
    const code = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(child.pid)); process.on('SIGTERM',()=>child.once('close',()=>process.exit(0))); setInterval(()=>{},1000);";
    const result = await executor.run({ name: 'node', args: ['-e', code] });
    assert.equal(result.reason, 'timeout'); assert.equal(result.settlement, 'closed');
    const pid = Number(result.stdout); assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await executor.close(); }
});

it('shutdown stops admitted work and preserves its final settlement', async () => {
  const executor = createProcessExecutor(config({ timeoutMs: 5000 }));
  const running = executor.run({ name: 'node', args: ['-e', 'setInterval(()=>{},1000)'] });
  const outcomes = await executor.close();
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].reason, 'closed');
  assert.equal(outcomes[0].settlement, 'closed'); assert.deepEqual(await running, outcomes[0]);
  assert.equal(executor.stats().active, 0);
});

it('reports injected process and input errors and bounds stalled pipe drainage', async () => {
  for (const fault of ['input', 'process', 'drain', 'spawn']) {
    const child = new EventEmitter(); child.pid = fault === 'spawn' ? undefined : 123;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => true;
    const executor = createProcessExecutor(config({ tree: 'child', timeoutMs: 2000, graceMs: 10, spawn: () => child }));
    const running = executor.run({ name: 'node', args: ['-e', ''] });
    if (fault === 'input') child.stdin.emit('error', { code: 'EIO' });
    else if (fault === 'process' || fault === 'spawn') child.emit('error', new Error('failure'));
    else child.emit('exit', 0, null);
    const result = await running;
    assert.equal(result.reason, { input: 'input-error', process: 'process-error', drain: 'drain-timeout', spawn: 'spawn-error' }[fault]);
    if (fault !== 'spawn') { assert.equal(result.settlement, 'unresolved'); child.emit('close', null, 'SIGKILL'); }
    await executor.close(); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  }
});
