//@ts-check
/** Opt-in Node command execution. This is process ownership, not an OS sandbox. */
import { spawn as nativeSpawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** @typedef {{ argv0: string, args?: RegExp[] | ((args: readonly string[]) => boolean) }} AllowedProcess */
/** @typedef {{ cwd: string, allow: Record<string, AllowedProcess>, env?: { allow: string[] },
 * timeoutMs?: number, graceMs?: number, maxStdoutBytes?: number, maxStderrBytes?: number,
 * maxInputBytes?: number, maxOwners?: number, killSignal?: 'SIGTERM'|'SIGINT'|'SIGKILL', tree?: 'group'|'child',
 * spawn?: (file: string, args: string[], options: { cwd: string, env: Record<string,string>,
 * shell: false, detached: boolean, stdio: string[], windowsHide: boolean }) => any }} ProcessExecutorOptions */
/** @typedef {{ name: string, args?: string[], input?: string|Uint8Array,
 * cwd?: string, env?: Record<string,string>, signal?: AbortSignal }} ProcessRequest */

/** @typedef {{ exitCode: number|null, signal: string|null, stdout: string, stderr: string,
 * truncated: { stdout: boolean, stderr: boolean }, durationMs: number,
 * settlement: 'not-started'|'closed'|'unresolved', refused?: string, reason?: string }} ProcessOutcome */

function sink(cap) {
  const chunks = []; let bytes = 0, truncated = false;
  return {
    write(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const take = Math.min(cap - bytes, value.length);
      if (take) { chunks.push(Buffer.from(value.subarray(0, take))); bytes += take; }
      if (take < value.length) truncated = true;
    },
    truncate() { truncated = true; },
    read: () => ({ text: Buffer.concat(chunks, bytes).toString('utf8'), truncated }),
  };
}

/**
 * Named commands only, no shell, captured argv/environment, finite active owners
 * and output. POSIX group mode kills descendants remaining after parent exit;
 * Windows supports child mode only. close drains or reports unresolved ownership,
 * whose capacity stays reserved until the actual child close event arrives.
 * cwd containment is a realpath preflight, not a filesystem confinement mechanism.
 * @param {ProcessExecutorOptions} configuration
 */
export function createProcessExecutor(configuration) {
  const { timeoutMs = 30000, graceMs = 1000, maxStdoutBytes = 1048576, maxStderrBytes = 1048576,
    maxInputBytes = 1048576, maxOwners = 4, killSignal = 'SIGTERM',
    tree = process.platform === 'win32' ? 'child' : 'group', spawn = nativeSpawn } = configuration;
  if (typeof configuration.cwd !== 'string' || typeof spawn !== 'function' || !['group', 'child'].includes(tree)
    || !['SIGTERM', 'SIGINT', 'SIGKILL'].includes(killSignal)) throw new TypeError('invalid process executor configuration');
  for (const [name, value] of Object.entries({ timeoutMs, graceMs, maxStdoutBytes, maxStderrBytes, maxInputBytes, maxOwners }))
    if (!Number.isSafeInteger(value) || value < (name.endsWith('Bytes') ? 0 : 1)
      || value > (name.endsWith('Bytes') ? 67108864 : name === 'maxOwners' ? 1024 : name === 'graceMs' ? 60000 : 2147483647))
      throw new RangeError(`invalid process limit ${name}`);
  const cwd = resolve(configuration.cwd), allow = new Map();
  for (const [name, command] of Object.entries(configuration.allow ?? {})) {
    if (!command || typeof command.argv0 !== 'string' || !isAbsolute(command.argv0)
      || command.args !== undefined && typeof command.args !== 'function' && (!Array.isArray(command.args) || command.args.some(arg => !(arg instanceof RegExp))))
      throw new TypeError('allowed commands need absolute executables and complete argv validators');
    const args = Array.isArray(command.args) ? command.args.map(pattern => new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace(/[gy]/g, ''))) : command.args;
    allow.set(name, { argv0: command.argv0, args });
  }
  const names = configuration.env?.allow ?? [];
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    throw new TypeError('environment allow-list must contain variable names');
  const envNames = new Set(names), owners = new Set();
  let closed = false;

  /** @param {ProcessRequest} request @returns {Promise<ProcessOutcome>} */
  function run(request) {
    const started = performance.now();
    const refused = reason => Promise.resolve({ exitCode: null, signal: null, stdout: '', stderr: '',
      truncated: { stdout: false, stderr: false }, durationMs: performance.now() - started,
      settlement: 'not-started', refused: reason });
    if (closed) return refused('closed');
    if (tree === 'group' && process.platform === 'win32') return refused('tree-unsupported');
    if (owners.size >= maxOwners) return refused('capacity');
    const command = allow.get(request?.name);
    if (!command) return refused('unknown-command');
    let args, input, env, directory, signal;
    try {
      if (!Array.isArray(request.args ?? []) || (request.args?.length ?? 0) > 1024) return refused('argument-rejected');
      args = request.args === undefined ? [] : [...request.args];
      let argumentBytes = 0;
      if (args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
        || args.some(arg => (argumentBytes += Buffer.byteLength(arg) + 1) > maxInputBytes)) return refused('argument-rejected');
      const valid = typeof command.args === 'function' ? command.args(Object.freeze([...args])) === true
        : (command.args ?? []).length === args.length && args.every((arg, index) => {
          const match = command.args[index].exec(arg);
          return match?.index === 0 && match[0].length === arg.length;
        });
      if (!valid) return refused('argument-rejected');
      if (request.input !== undefined && typeof request.input !== 'string' && !(request.input instanceof Uint8Array)) return refused('input-rejected');
      if ((typeof request.input === 'string' ? Buffer.byteLength(request.input) : request.input?.byteLength ?? 0) > maxInputBytes) return refused('input-rejected');
      input = request.input === undefined ? Buffer.alloc(0) : Buffer.from(request.input);
      env = {};
      for (const name of envNames) if (process.env[name] !== undefined) env[name] = process.env[name];
      for (const [name, value] of Object.entries(request.env ?? {})) {
        if (!envNames.has(name) || typeof value !== 'string' || value.includes('\0')) return refused('env-rejected');
        env[name] = value;
      }
      let environmentBytes = 0;
      if (Object.entries(env).some(([name, value]) => (environmentBytes += Buffer.byteLength(name + value) + 2) > maxInputBytes)) return refused('env-rejected');
      directory = realpathSync(request.cwd === undefined ? cwd : resolve(cwd, request.cwd));
      const root = realpathSync(cwd), path = relative(root, directory);
      if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) return refused('cwd-escape');
      signal = request.signal;
      if (signal !== undefined && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) return refused('request-rejected');
      if (signal?.aborted) return refused('cancelled');
    }
    catch { return refused('request-rejected'); }
    const stdout = sink(maxStdoutBytes), stderr = sink(maxStderrBytes);
    let child, resolveResult, responded = false, reason = null, exitCode = null, exitSignal = null;
    let deadline, escalation, settlementTimer, drainTimer;
    const promise = new Promise(resolve => { resolveResult = resolve; });
    const owner = { promise, stop: reason => stop(reason) };
    owners.add(owner);
    const timers = () => { clearTimeout(deadline); clearTimeout(escalation); clearTimeout(settlementTimer); clearTimeout(drainTimer); };
    function answer(settlement) {
      if (responded) return;
      responded = true;
      if (settlement === 'unresolved') { stdout.truncate(); stderr.truncate(); }
      const out = stdout.read(), err = stderr.read();
      resolveResult({ exitCode, signal: exitSignal, stdout: out.text, stderr: err.text,
        truncated: { stdout: out.truncated, stderr: err.truncated }, durationMs: performance.now() - started,
        settlement, ...(reason === null ? {} : { reason }) });
    }
    function signalChild(signal) {
      if (!child?.pid) return;
      if (tree === 'group') {
        try { process.kill(-child.pid, signal); return; }
        catch { /* The direct child still owns its own close event. */ }
      }
      try { child.kill(signal); } catch { /* Unresolved ownership remains charged. */ }
    }
    function stop(why) {
      if (reason !== null) return;
      reason = why; signalChild(killSignal);
      escalation = setTimeout(() => signalChild('SIGKILL'), graceMs);
      settlementTimer = setTimeout(() => { answer('unresolved'); timers(); }, graceMs * 2);
    }
    const abort = () => stop('cancelled');
    function release() {
      timers(); signal?.removeEventListener('abort', abort); owners.delete(owner);
      answer('closed');
    }
    try {
      child = spawn(command.argv0, args, { cwd: directory, env, shell: false,
        detached: tree === 'group', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.on('data', chunk => { if (!responded) stdout.write(chunk); });
      child.stderr.on('data', chunk => { if (!responded) stderr.write(chunk); });
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop('input-error'); });
      child.once('error', () => {
        if (!child.pid) { reason = 'spawn-error'; release(); }
        else stop('process-error');
      });
      child.once('exit', (code, signal) => {
        exitCode = code; exitSignal = signal;
        if (tree === 'group') signalChild('SIGKILL');
        drainTimer = setTimeout(() => {
          if (!child.stdout.readableEnded) stdout.truncate();
          if (!child.stderr.readableEnded) stderr.truncate();
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          stop('drain-timeout');
        }, graceMs);
      });
      child.once('close', (code, signal) => { exitCode = code; exitSignal = signal; release(); });
      signal?.addEventListener('abort', abort, { once: true });
      deadline = setTimeout(() => stop('timeout'), timeoutMs);
      child.stdin.end(input);
      if (signal?.aborted) abort();
    }
    catch {
      if (child?.pid) stop('spawn-error');
      else { reason = 'spawn-error'; release(); }
    }
    return promise;
  }
  return { run, capabilities: Object.freeze({ processGroups: process.platform !== 'win32', resourceUsage: false }),
    stats: () => ({ active: owners.size, capacity: maxOwners, closed }),
    async close() { closed = true; const active = [...owners]; for (const owner of active) owner.stop('closed'); return Promise.all(active.map(owner => owner.promise)); } };
}
