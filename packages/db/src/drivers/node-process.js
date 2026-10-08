//@ts-check
/** Supervised process ownership; response cancellation never implies SQL rollback. */
import { sqliteDialect } from '../dialects/sqlite.js';
import { sqlTokens } from '../dialects/check-read.js';
import { DbCompileError, DbRuntimeError } from '../errors.js';
import { createWorkerConnection } from './worker-client.js';
import { positiveOption, queueFailure, refuseUnknownDriverOptions, rowBytes, workerSettings,
  PROCESS_DEFAULTS, PROCESS_OPTIONS } from './worker-protocol.js';

/**
 * Finite owned SQLite processes behind the ordinary Driver contract.
 * A quarantined process retains its admission credit until its exit event.
 * The options are a closed set: a member it does not read is `JD0003`.
 * @param {import('../../types/node-process.js').NodeProcessOptions} [configuration]
 * @returns {import('../../types/node-process.js').NodeProcessDriver}
 */
export function nodeProcessDriver(configuration = {}) {
  // the process host forks its own endpoint from the installed package
  if (configuration.endpoint !== undefined) {
    throw new TypeError('endpoint is an option of nodeWorkerDriver and nodeWorkerPoolDriver; the supervised '
      + 'process host forks its own endpoint beside the installed @jarenjs/db');
  }
  refuseUnknownDriverOptions(configuration, PROCESS_OPTIONS, 'nodeProcessDriver');
  const maxOwners = positiveOption('maxOwners', configuration.maxOwners, PROCESS_DEFAULTS.maxOwners);
  const timeoutMs = positiveOption('timeoutMs', configuration.timeoutMs, PROCESS_DEFAULTS.timeoutMs);
  const maxRequestBytes = positiveOption('maxRequestBytes', configuration.maxRequestBytes, PROCESS_DEFAULTS.maxRequestBytes);
  const settings = workerSettings(configuration, PROCESS_DEFAULTS);
  const { limits } = settings;
  const owners = new Set();
  const endpoint = new URL('./node-process-endpoint.js', import.meta.url);
  let generation = 0;
  const driver = {
    name: 'node-process-sqlite', dialect: sqliteDialect,
    supportsSharedReads: false,
    metrics: () => Object.freeze({ capacity: maxOwners, owners: owners.size,
      quarantined: [...owners].filter((owner) => owner.status === 'quarantined').length,
      healthy: [...owners].filter((owner) => owner.status === 'healthy').length }),
    async open(path = ':memory:', options = {}) {
      // qualified on Node only: Bun runs the worker and pool hosts instead
      const bun = globalThis.process?.versions?.bun;
      const node = globalThis.process?.release?.name === 'node' ? process.versions.node : undefined;
      if (bun !== undefined || node === undefined || Number(node.split('.')[0]) < 24) {
        const found = bun !== undefined ? `Bun ${bun}` : node !== undefined ? `Node.js ${node}` : 'a runtime that is not Node.js';
        throw new DbCompileError('JD0003', `supervised SQLite processes run on Node.js 24 or newer, and this is ${found}`
          + (bun !== undefined ? '; the worker and pool hosts (@jarenjs/db/node-worker, @jarenjs/db/node-pool) run on Bun' : ''));
      }
      const [{ fork }, { resolve }] = await Promise.all([import('node:child_process'), import('node:path')]);
      const identity = path === ':memory:' ? null : resolve(path);
      if (owners.size >= maxOwners || identity && [...owners].some((owner) => owner.path === identity))
        throw queueFailure('process owner capacity or database ownership is reserved', owners.size);
      const epoch = ++generation;
      const state = { path: identity, status: 'starting', transaction: 'none', generation: epoch, pid: null,
        safeToReplace: false, exitCode: null, exitSignal: null };
      owners.add(state);
      let child;
      try {
        child = fork(endpoint, [], {
          serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          execArgv: ['--no-warnings=ExperimentalWarning'],
        });
      }
      catch (error) { owners.delete(state); throw error; }
      state.pid = child.pid ?? null;
      let resolveExit, control, killPromise, active = false, closeAcknowledged = false;
      let transactionOpen = false, ambiguous = false;
      // what the endpoint holds, mirrored exactly: a statement leaves on
      // its `finalize`, an ephemeral one with the cursor that owned it (or
      // with a refused `iterate` no cursor owns), a cursor when it is
      // returned, exhausted or fails — so the map never fills with
      // statements the endpoint already released, and a fixed statement
      // the store keeps using is never mistaken for an unknown one
      const prepared = new Map();
      const cursors = new Map();
      /** @type {Map<number, number>} cursor id → the statement it runs */
      const cursorStatements = new Map();
      const releaseCursor = (id) => {
        cursors.delete(id);
        const owner = cursorStatements.get(id);
        cursorStatements.delete(id);
        if (owner !== undefined && prepared.get(owner)?.ephemeral === true) prepared.delete(owner);
      };
      const releaseUnowned = (statement) => {
        if (prepared.get(statement)?.ephemeral !== true) return;
        for (const owner of cursorStatements.values()) if (owner === statement) return;
        prepared.delete(statement);
      };
      const report = () => Object.freeze({ ...state });
      const exited = new Promise((resolve) => { resolveExit = resolve; });
      child.once('exit', (code, signal) => {
        state.status = 'exited'; state.safeToReplace = true;
        state.exitCode = code; state.exitSignal = signal;
        queueMicrotask(() => {
          if (ambiguous) state.transaction = 'unknown';
          else if (transactionOpen) state.transaction = 'rolled-back';
          owners.delete(state); resolveExit(report());
        });
      });
      // A failed spawn has no owner to quarantine and emits no exit event.
      child.once('error', () => {
        if (child.pid === undefined) {
          state.status = 'exited'; state.safeToReplace = true;
          owners.delete(state); resolveExit(report());
        }
      });
      const terminate = () => {
        if (!killPromise) {
          if (state.status !== 'exited' && !closeAcknowledged) { state.status = 'quarantined'; child.kill('SIGKILL'); }
          killPromise = exited;
        }
        return killPromise;
      };
      const transport = {
        on: (name, fn) => child.on(name, fn),
        postMessage: (message) => child.send(message, (error) => { if (error) control?.lose(error); }),
        terminate, unref: () => {},
      };
      const info = (sql) => {
        const tokens = sqlTokens(sql), words = tokens.filter((token) => token.kind === 'word').map((token) => token.value.toUpperCase());
        const multiple = tokens.some((token, i) => token.kind === 'symbol' && token.value === ';' && i < tokens.length - 1);
        return { multiple, end: multiple || ['COMMIT', 'END', 'RELEASE'].includes(words[0]),
          rollback: words[0] === 'ROLLBACK' && !words.includes('TO'),
          writes: multiple || !['SELECT', 'WITH'].includes(words[0]) || words.some((word) => ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(word)) };
      };
      const unknownStatement = { multiple: true, writes: true, end: true };
      const execution = (op, data) => op === 'exec' ? info(data.sql)
        : ['next', 'return'].includes(op) ? cursors.get(data.cursor) ?? unknownStatement
          : ['run', 'get', 'iterate'].includes(op) ? prepared.get(data.statement) ?? unknownStatement : null;
      const observe = (op, data, open, failed = false, statement = execution(op, data)) => {
        if (typeof open !== 'boolean') return;
        const wasOpen = transactionOpen;
        transactionOpen = open;
        if (open) { ambiguous = false; state.transaction = 'active'; }
        else if (statement?.multiple || [...cursors.values()].some((cursor) => cursor.writes)
          || op === 'return' && statement?.writes) { ambiguous = true; state.transaction = 'unknown'; }
        else if (failed && wasOpen || statement?.rollback) {
          ambiguous = false; state.transaction = 'rolled-back';
        }
        else if (!failed && statement && (wasOpen || ambiguous && statement.writes)) { ambiguous = false; state.transaction = 'committed'; }
      };
      const hooks = {
        control: (value) => { control = value; },
        lost: (error, pending) => {
          const live = pending.map(({ op, data }) => execution(op, data)).filter(Boolean);
          ambiguous = live.some((statement) => statement.end || statement.writes && !transactionOpen)
            || !transactionOpen && [...cursors.values()].some((statement) => statement.writes);
          if (ambiguous) state.transaction = 'unknown';
          if (ambiguous || transactionOpen) error.retryable = false;
          if (state.status !== 'exited') { state.status = 'quarantined'; terminate(); }
        },
        request: (op, data) => {
          if (data.params?.some((param) => param !== null && !['number', 'bigint', 'string'].includes(typeof param) && !(param instanceof Uint8Array)))
            throw new DbRuntimeError('JD2093', 'process parameters must be SQLite scalars or byte arrays');
          if (rowBytes(data) > maxRequestBytes) throw new DbRuntimeError('JD2092', 'process request exceeds its byte credit');
          const statement = execution(op, data);
          if (statement && (statement.end || statement.writes && !transactionOpen)) {
            ambiguous = true; state.transaction = 'unknown';
          }
        },
        failure: (op, data, open) => {
          const statement = execution(op, data);
          // the endpoint releases the cursor of a failed pull or return, and
          // the ephemeral preparation of a refused iterate that no cursor owns
          if (op === 'next' || op === 'return') releaseCursor(data.cursor);
          else if (op === 'iterate') releaseUnowned(data.statement);
          observe(op, data, open, true, statement);
        },
        result: (op, data, value, open) => {
          const statement = execution(op, data);
          if (op === 'close') closeAcknowledged = true;
          if (op === 'prepare') {
            if (prepared.size >= limits.statements) prepared.delete(prepared.keys().next().value);
            prepared.set(value, { ...info(data.sql), ephemeral: data.ephemeral === true });
          }
          if (op === 'iterate') { cursors.set(value, statement); cursorStatements.set(value, data.statement); }
          if (op === 'return' || op === 'next' && value.done) releaseCursor(data.cursor);
          if (op === 'finalize') {
            for (const [id, owner] of [...cursorStatements]) if (owner === data.statement) releaseCursor(id);
            prepared.delete(data.statement);
          }
          observe(op, data, open, false, statement);
        },
      };
      const opening = createWorkerConnection(transport, { ...settings, epoch, options, hooks, awaitStartupExit: false,
        endpoint: endpoint.href, reopen: () => driver.open(path, options),
        startupAdvice: 'the supervised process host forks it from the installed @jarenjs/db, so keep the package '
          + 'outside a bundle' });
      child.send({ generation: epoch, path, options: { timeout: options.timeout, readOnly: options.readOnly }, limits });
      const connection = await opening;
      state.status = 'healthy';
      const cancel = (reason = 'caller cancelled') => {
        const error = Object.assign(new DbRuntimeError('JD2097', String(reason)), {
          generation: epoch, retryable: false, class: 'cancelled',
        });
        control.lose(error); terminate(); return error;
      };
      const result = Object.freeze({ ...connection,
        get mustQueue() { return connection.mustQueue; },
        capabilities: Object.freeze({ ...connection.capabilities, worker: false, process: true,
          ownerTermination: true, cancellation: Object.freeze({ ...connection.capabilities.cancellation, midStatement: false }) }),
        settlement: report, settled: () => exited, cancel,
        metrics: () => Object.freeze({ ...connection.metrics(), owner: report(), supervised: active ? 1 : 0 }),
        async supervise(body, request = {}) {
          if (active) throw queueFailure('one supervised operation already owns this process', 1);
          const bound = positiveOption('timeoutMs', request.timeoutMs, timeoutMs);
          if (request.signal?.aborted) throw Object.assign(new DbRuntimeError('JD2097', 'cancelled before admission'), { generation: epoch, retryable: true, class: 'cancelled' });
          if (state.status !== 'healthy') throw new DbRuntimeError('JD2090', 'process owner is not healthy');
          active = true;
          let timer, abort;
          try {
            return await new Promise((resolve, reject) => {
              abort = () => { const error = cancel('supervised operation was cancelled'); reject(error); };
              request.signal?.addEventListener('abort', abort, { once: true });
              timer = setTimeout(() => { const error = cancel('supervised operation exceeded its response deadline'); reject(error); }, bound);
              Promise.resolve().then(() => body(result)).then(resolve, reject);
            });
          }
          finally { active = false; clearTimeout(timer); request.signal?.removeEventListener('abort', abort); }
        },
      });
      return result;
    },
  };
  return Object.freeze(driver);
}
