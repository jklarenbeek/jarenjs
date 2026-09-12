//@ts-check
/** One worker owns one SQLite handle. Only bounded credit frames carry rows. */
import { nodeDriver } from './node.js';
import { DbRuntimeError, cloneDriverError } from '../errors.js';
import { validRequest, generationFailure, rowBytes } from './worker-protocol.js';

/** @param {any} parentPort @param {any} configuration */
export async function serveSqliteEndpoint(parentPort, configuration) {
  const { generation, path, options, limits } = configuration;
  let connection;
  let sequence = 0;
  const statements = new Map();
  const cursors = new Map();
  const frame = (kind, id, value) => ({ v: 1, generation, kind, id, ...value });
  const transaction = () => {
    try { return connection.transactionState(); }
    catch { return null; }
  };
  const bound = (reason) => new DbRuntimeError('JD2092', reason);
  const release = (id) => {
    const cursor = cursors.get(id);
    if (cursor === undefined) return;
    cursors.delete(id);
    cursor.iterator.return?.();
    if (cursor.ephemeral) statements.delete(cursor.statement);
  };
  const statementOf = (id) => {
    const statement = statements.get(id);
    if (statement === undefined) throw generationFailure(generation);
    return statement;
  };
  const dispatch = (request) => {
    switch (request.op) {
      case 'exec': return connection.exec(request.sql);
      case 'prepare': {
        if (statements.size >= limits.statements) throw bound(`worker statement capacity ${limits.statements} exceeded`);
        const id = ++sequence;
        statements.set(id, { statement: connection.prepare(request.sql), ephemeral: request.ephemeral === true });
        return id;
      }
      case 'get': {
        const row = statementOf(request.statement).statement.get(request.params);
        if (rowBytes(row) > limits.bytes) throw bound(`one worker row exceeds ${limits.bytes} bytes`);
        return row;
      }
      case 'run': return statementOf(request.statement).statement.run(request.params);
      case 'iterate': {
        if (cursors.size >= limits.cursors) throw bound(`worker cursor capacity ${limits.cursors} exceeded`);
        const record = statementOf(request.statement);
        const id = ++sequence;
        cursors.set(id, { iterator: record.statement.iterate(request.params),
          statement: request.statement, ephemeral: record.ephemeral, buffered: null });
        return id;
      }
      case 'next': {
        const cursor = cursors.get(request.cursor);
        if (cursor === undefined) throw generationFailure(generation);
        if (request.rows > limits.rows || request.bytes > limits.bytes) throw bound('worker cursor credit exceeds the negotiated window');
        const rows = [];
        let bytes = 0;
        try {
          while (rows.length < request.rows) {
            const step = cursor.buffered ?? cursor.iterator.next();
            cursor.buffered = null;
            if (step.done) { release(request.cursor); return { rows, bytes, done: true }; }
            const size = rowBytes(step.value);
            if (size > request.bytes) throw bound(`one worker row of ${size} bytes exceeds the ${request.bytes} byte window`);
            if (bytes + size > request.bytes) { cursor.buffered = step; break; }
            rows.push(step.value);
            bytes += size;
          }
          return { rows, bytes, done: false };
        }
        catch (error) { release(request.cursor); throw error; }
      }
      case 'return': release(request.cursor); return undefined;
      case 'finalize': {
        for (const [id, cursor] of cursors) if (cursor.statement === request.statement) release(id);
        statements.delete(request.statement);
        return undefined;
      }
      case 'close': {
        for (const id of cursors.keys()) release(id);
        statements.clear();
        return connection.close();
      }
    }
  };
  try {
    connection = await nodeDriver().open(path, options);
    // Functions cannot cross structured clone. Capture uses the existing
    // journal path; a live query requires a synchronous connection.
    parentPort.postMessage(frame('ready', 0, { capabilities: { ...connection.capabilities,
      sessions: false, userFunctions: false, deterministicIndexableFunctions: false,
      aggregateFunctions: false, backup: false, worker: true, pooling: false } }));
    parentPort.on('message', (request) => {
      try {
        if (!validRequest(request)) throw new DbRuntimeError('JD2093', 'invalid worker protocol request');
        if (request.generation !== generation) throw generationFailure(request.generation);
        const value = dispatch(request);
        parentPort.postMessage(frame('result', request.id, { value,
          transaction: request.op === 'close' ? null : transaction() }));
        if (request.op === 'close') parentPort.close();
      }
      catch (error) { parentPort.postMessage(frame('failure', request?.id ?? 0, {
        error: cloneDriverError(error), transaction: transaction() })); }
    });
  }
  catch (error) {
    parentPort.postMessage(frame('failure', 0, { error: cloneDriverError(error) }));
    parentPort.close();
  }
}
