//@ts-check
/**
 * @file The jaren-dag engine: compile an acyclic dataflow document
 * (docs/FLOW-FORMAT.md §6) once — every embedded query, stylesheet,
 * `with` and `select` becomes a closure, the task registry is resolved,
 * the wiring rules are proven — and run it many times. A run resolves
 * nodes as their inputs arrive (independent branches concurrently),
 * delivers values by reference, and fails closed: the first failing
 * node aborts the shared signal and rejects the whole run (§7.3) — no
 * retries, no partial results.
 *
 * Determinism is same input → same output VALUES, never same timing:
 * results are keyed per node and port objects assemble in edge
 * document order, so completion order cannot change a value (§7.2).
 */

import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { isJsonObject, setObjectMember } from '@jarenjs/core/object';
import { asError, FlowCompileError, FlowRuntimeError } from './errors.js';

const KINDS = ['input', 'output', 'const', 'query', 'jslt', 'task'];

/** Kinds that must not receive an inbound edge / must have one. */
const NO_INBOUND = new Set(['input', 'const']);
const NEEDS_INBOUND = new Set(['query', 'jslt', 'task', 'output']);

/**
 * Compile one embedded document, wrapping the engine error as JF0014.
 * @param {(d: any) => any} compile
 * @param {any} embedded
 * @param {string} docPath
 */
function compileEmbedded(compile, embedded, docPath) {
  try {
    return compile(embedded);
  }
  catch (err) {
    const cause = asError(err);
    throw new FlowCompileError('JF0014',
      `the embedded document failed to compile: ${cause.message}`, docPath, cause);
  }
}

/**
 * A settlement record handed to `onNode` (§7.4). `restored` fires at
 * the start of a RESUMED run for every node whose checkpointed value
 * was seeded instead of evaluated (§7.6).
 * @typedef {{ id: string, status: 'ok'|'error'|'aborted'|'restored', ms: number }} DagNodeRecord
 */

/**
 * The opt-in checkpoint store (§7.6): `load` answers a prior run's
 * recorded values (or null), `save` records one declared node's
 * value, `complete` records the run's result. Any member may return a
 * promise; a throwing store fails the run (JF2009), never silently.
 * @typedef {Object} DagCheckpointStore
 * @property {(runId: string, identity?: any) => any} load
 * @property {(runId: string, nodeId: string, value: any, identity?: any) => any} save
 * @property {(runId: string, result: any, identity?: any) => any} complete
 */

/**
 * A compiled jaren-dag graph.
 * @typedef {Object} CompiledDag
 * @property {readonly string[]} nodes - Declared node ids, document order.
 * @property {string} output - The output node's id.
 * @property {Readonly<Record<string, string>>} taskVersions - Every
 *   declared task identity this workflow depends on, keyed by node id and
 *   SORTED (§7.8); a nested workflow's map composes under its node's
 *   path. Empty when no node declares a version.
 * @property {(input?: any, opts?: { signal?: AbortSignal, onNode?: (record: DagNodeRecord) => void, runId?: string, drainOnAbort?: boolean }) => Promise<any>} run -
 *   Execute the graph for one input (`undefined` reads as `null`).
 */

/**
 * One registry entry, in either accepted spelling.
 *
 * `{ run, version }` is the full one. A bare function is the shorthand,
 * and it carries no version — which is why a checkpointed node, whose
 * declared version has nothing to be compared against, cannot use it.
 * An entry may also expose a `taskVersions` map of its own: a handler
 * that is itself a compiled workflow contributes its versions under this
 * node's path, so a composed run has one identity, not two.
 * @param {any} entry
 * @param {string} name
 * @returns {{ run: Function, version: string | null, taskVersions: Record<string, string> | null }}
 */
function normalizeTaskEntry(entry, name) {
  if (typeof entry === 'function') return { run: entry, version: null, taskVersions: null };
  if (!isJsonObject(entry) || typeof entry.run !== 'function') {
    throw new TypeError(
      `compileDag: the registered handler '${name}' is not a function, nor { run, version }`);
  }
  if (entry.version !== undefined
    && (typeof entry.version !== 'string' || entry.version.trim() === '')) {
    throw new TypeError(
      `compileDag: the registered handler '${name}' has a version that is not a non-empty string`);
  }
  if (entry.taskVersions !== undefined && !isJsonObject(entry.taskVersions)) {
    throw new TypeError(
      `compileDag: the registered handler '${name}' has a taskVersions that is not an object`);
  }
  if (entry.taskVersions !== undefined && Object.entries(entry.taskVersions).some(([path, version]) =>
    /~(?:[^01]|$)/.test(path) || typeof version !== 'string' || version.trim() === '')) {
    throw new TypeError(`compileDag: the registered handler '${name}' has invalid taskVersions paths or versions`);
  }
  return {
    run: entry.run,
    version: entry.version ?? null,
    taskVersions: entry.taskVersions ?? null,
  };
}

/**
 * Compile a jaren-dag document (docs/FLOW-FORMAT.md §6–§7) against a
 * task registry. Everything is decided here: structural validation,
 * the wiring rules, acyclicity, embedded-document compilation and
 * registry resolution — `run` only executes closures.
 *
 * @param {any} doc - the jaren-dag document
 * @param {{ tasks?: Record<string, ((props: { with: any, input: any }, signal: AbortSignal) => any)
 *     | { run: (props: { with: any, input: any }, signal: AbortSignal) => any, version?: string,
 *         taskVersions?: Record<string, string> }>,
 *   checkpoint?: DagCheckpointStore, revision?: string }} [options]
 * @returns {CompiledDag}
 * @throws {FlowCompileError} when the document violates the format (JF0xxx)
 * @throws {TypeError} when the options are malformed (a registry that is
 *   not an object, a registered handler that is not a function, or a
 *   checkpoint store missing one of load/save/complete)
 */
export function compileDag(doc, options) {
  const tasks = options?.tasks ?? {};
  if (!isJsonObject(tasks)) {
    throw new TypeError('compileDag: "tasks" must be an object of handler functions');
  }
  const checkpoint = options?.checkpoint;
  const revision = options?.revision;
  if (revision !== undefined && (typeof revision !== 'string' || !revision.trim() || !checkpoint))
    throw new TypeError('compileDag: revision must be nonblank and requires a checkpoint store');
  if (checkpoint !== undefined && (typeof checkpoint?.load !== 'function'
    || typeof checkpoint.save !== 'function'
    || typeof checkpoint.complete !== 'function')) {
    throw new TypeError(
      'compileDag: "checkpoint" must provide load, save and complete functions');
  }

  if (!isJsonObject(doc)) {
    throw new FlowCompileError('JF0010', 'the dag document must be an object', '');
  }
  if (doc.$dag !== '0.1') {
    throw new FlowCompileError('JF0010',
      `the "$dag" member is required and must be '0.1' (got ${JSON.stringify(doc.$dag)})`,
      '/$dag');
  }
  if (!isJsonObject(doc.nodes)) {
    throw new FlowCompileError('JF0011',
      'the "nodes" member must be an object of node declarations', '/nodes');
  }

  /** @type {Map<string, any>} */
  const nodes = new Map();
  const order = Object.keys(doc.nodes);
  const durable = order.some((id) => doc.nodes[id]?.checkpoint === true);
  for (const id of order) {
    const decl = doc.nodes[id];
    const base = `/nodes/${encodeJSONPointerSegment(id)}`;
    if (!isJsonObject(decl) || !KINDS.includes(decl.kind)) {
      throw new FlowCompileError('JF0011',
        `node '${id}' must be an object with a kind from ${KINDS.join('|')}`,
        isJsonObject(decl) ? `${base}/kind` : base);
    }
    if (decl.checkpoint !== undefined && typeof decl.checkpoint !== 'boolean') {
      throw new FlowCompileError('JF0011',
        `node '${id}' has a "checkpoint" member that is not a boolean`,
        `${base}/checkpoint`);
    }
    /** @type {any} */
    const node = {
      id, kind: decl.kind, docPath: base, inbound: [],
      checkpoint: decl.checkpoint === true,
    };
    switch (decl.kind) {
      case 'const':
        if (!Object.hasOwn(decl, 'value')) {
          throw new FlowCompileError('JF0011',
            `const node '${id}' must carry a "value" member`, base);
        }
        node.value = decl.value;
        break;
      case 'query':
        if (decl.query === undefined) {
          throw new FlowCompileError('JF0011',
            `query node '${id}' must carry a "query" member`, base);
        }
        node.query = compileEmbedded(compileJsonQuery, decl.query, `${base}/query`);
        break;
      case 'jslt':
        if (decl.stylesheet === undefined) {
          throw new FlowCompileError('JF0011',
            `jslt node '${id}' must carry a "stylesheet" member`, base);
        }
        node.transform = compileEmbedded(compileJsltStylesheet, decl.stylesheet, `${base}/stylesheet`);
        break;
      case 'task': {
        if (typeof decl.run !== 'string' || decl.run === '') {
          throw new FlowCompileError('JF0011',
            `task node '${id}' must carry a non-empty string "run"`, `${base}/run`);
        }
        if (decl.version !== undefined
          && (typeof decl.version !== 'string' || decl.version.trim() === '')) {
          throw new FlowCompileError('JF0011',
            `task node '${id}' has a "version" member that is not a non-empty string`,
            `${base}/version`);
        }
        // a checkpointed node's output is REPLAYED on a later run, which
        // is only sound while the implementation that produced it is the
        // same implementation. That identity is declared, never derived:
        // hashing a closure's source would call a reformat a new task and
        // a changed dependency the same one
        if (durable && decl.version === undefined) {
          throw new FlowCompileError('JF0011',
            `task node '${id}' belongs to a workflow with checkpoints, so it must also declare a "version" — `
            + 'a checkpointed result is replayed only while the handler that produced it is '
            + 'the same one, and that identity has to be stated', `${base}/version`);
        }
        if (!Object.hasOwn(tasks, decl.run)) {
          throw new FlowCompileError('JF0018',
            `task node '${id}' names the handler '${decl.run}', which the registry does not provide`,
            `${base}/run`);
        }
        const entry = normalizeTaskEntry(tasks[decl.run], decl.run);
        if (decl.version !== undefined) {
          if (entry.version === null) {
            throw new FlowCompileError('JF0019',
              `task node '${id}' declares version '${decl.version}', but the registry provides `
              + `'${decl.run}' as a bare handler with no version — register it as `
              + '{ run, version } so the two can be compared', `${base}/version`);
          }
          if (entry.version !== decl.version) {
            throw new FlowCompileError('JF0019',
              `task node '${id}' declares version '${decl.version}', but the registry provides `
              + `'${decl.run}' at version '${entry.version}'`, `${base}/version`);
          }
        }
        node.handler = entry.run;
        node.version = decl.version ?? null;
        node.nestedVersions = entry.taskVersions;
        node.with = decl.with === undefined
          ? null
          : compileEmbedded(compileJsonQuery, decl.with, `${base}/with`);
        break;
      }
      default:
        break;
    }
    nodes.set(id, node);
  }

  const outputs = order.filter((id) => nodes.get(id).kind === 'output');
  if (outputs.length !== 1) {
    throw new FlowCompileError('JF0017',
      `a dag declares exactly one output node (found ${outputs.length})`, '/nodes');
  }
  const outputId = outputs[0];
  // Exact canonical provenance is opt-in for legacy stores. It is compared
  // before any saved node value can enter the memo, not merely handed to a host.
  const documentIdentity = revision === undefined ? null : canonicalizeJson(doc);

  if (!Array.isArray(doc.edges)) {
    throw new FlowCompileError('JF0012',
      'the "edges" member must be an array of edge entries', '/edges');
  }
  for (let i = 0; i < doc.edges.length; i++) {
    const e = doc.edges[i];
    const base = `/edges/${i}`;
    if (!isJsonObject(e)) {
      throw new FlowCompileError('JF0012', `edge ${i} must be an object`, base);
    }
    if (typeof e.from !== 'string') {
      throw new FlowCompileError('JF0012', `edge ${i} must carry a string "from"`, `${base}/from`);
    }
    if (typeof e.to !== 'string') {
      throw new FlowCompileError('JF0012', `edge ${i} must carry a string "to"`, `${base}/to`);
    }
    if (e.port !== undefined && (typeof e.port !== 'string' || e.port === '')) {
      throw new FlowCompileError('JF0012',
        `edge ${i} has a "port" that is not a non-empty string`, `${base}/port`);
    }
    if (!nodes.has(e.from)) {
      throw new FlowCompileError('JF0013',
        `edge ${i} leaves the undeclared node '${e.from}'`, `${base}/from`);
    }
    if (!nodes.has(e.to)) {
      throw new FlowCompileError('JF0013',
        `edge ${i} enters the undeclared node '${e.to}'`, `${base}/to`);
    }
    if (NO_INBOUND.has(nodes.get(e.to).kind)) {
      throw new FlowCompileError('JF0015',
        `edge ${i} enters '${e.to}', but ${nodes.get(e.to).kind} nodes accept no inbound edge`,
        `${base}/to`);
    }
    if (nodes.get(e.from).kind === 'output') {
      throw new FlowCompileError('JF0015',
        `edge ${i} leaves the output node '${e.from}'`, `${base}/from`);
    }
    nodes.get(e.to).inbound.push({
      from: e.from,
      port: e.port ?? null,
      select: e.select === undefined
        ? null
        : compileEmbedded(compileJsonQuery, e.select, `${base}/select`),
      edgeIndex: i,
    });
  }

  // port completeness/uniqueness and inbound-required rules (§6.1)
  for (const id of order) {
    const node = nodes.get(id);
    if (NEEDS_INBOUND.has(node.kind) && node.inbound.length === 0) {
      throw new FlowCompileError('JF0015',
        `${node.kind} node '${id}' has no inbound edge`, node.docPath);
    }
    const ported = node.inbound.some((e) => e.port !== null);
    if (node.inbound.length > 1 || ported) {
      const seen = new Set();
      for (const e of node.inbound) {
        if (e.port === null) {
          throw new FlowCompileError('JF0015',
            `edge ${e.edgeIndex} into '${id}' needs a "port": ported fan-in must be all-ported`,
            `/edges/${e.edgeIndex}`);
        }
        if (seen.has(e.port)) {
          throw new FlowCompileError('JF0015',
            `edge ${e.edgeIndex} duplicates port '${e.port}' into '${id}'`,
            `/edges/${e.edgeIndex}/port`);
        }
        seen.add(e.port);
      }
      node.ports = true;
    }
    else {
      node.ports = false;
    }
  }

  // acyclicity via Kahn (insertion-order tie-break). A forward pass's
  // leftover holds cycles PLUS their downstream; a backward pass's
  // leftover holds cycles PLUS their upstream — the intersection names
  // exactly the cyclic core, so the message never accuses an innocent
  // downstream node.
  {
    /** @param {(id: string) => string[]} depsOf */
    const kahnLeftover = (depsOf) => {
      const degree = new Map(order.map((id) => [id, depsOf(id).length]));
      const consumers = new Map(order.map((id) => [id, /** @type {string[]} */ ([])]));
      for (const id of order) {
        for (const dep of depsOf(id)) /** @type {string[]} */ (consumers.get(dep)).push(id);
      }
      const ready = order.filter((id) => degree.get(id) === 0);
      while (ready.length > 0) {
        const id = /** @type {string} */ (ready.shift());
        degree.set(id, -1);
        for (const next of /** @type {string[]} */ (consumers.get(id))) {
          const left = /** @type {number} */ (degree.get(next)) - 1;
          degree.set(next, left);
          if (left === 0) ready.push(next);
        }
      }
      return new Set(order.filter((id) => /** @type {number} */ (degree.get(id)) > 0));
    };
    const forward = kahnLeftover((id) => nodes.get(id).inbound.map((e) => e.from));
    if (forward.size > 0) {
      const backward = kahnLeftover((id) => {
        const out = [];
        for (const other of order) {
          for (const e of nodes.get(other).inbound) {
            if (e.from === id) out.push(other);
          }
        }
        return out;
      });
      const cyclic = new Set([...forward].filter((id) => backward.has(id)));
      const offender = doc.edges.findIndex(
        (e) => cyclic.has(e.from) && cyclic.has(e.to));
      throw new FlowCompileError('JF0016',
        `the graph has a cycle among: ${[...cyclic].join(', ')}`, `/edges/${offender}`);
    }
  }

  /** @type {CompiledDag['run']} */
  function run(input, opts) {
    // option misuse throws synchronously, like every compile surface;
    // only document-level outcomes travel through the promise
    const signal = opts?.signal;
    if (signal !== undefined && typeof signal?.addEventListener !== 'function') {
      throw new TypeError('run: "signal" must be an AbortSignal');
    }
    const onNode = opts?.onNode;
    if (opts?.drainOnAbort !== undefined && typeof opts.drainOnAbort !== 'boolean')
      throw new TypeError('run: drainOnAbort must be boolean');
    if (onNode !== undefined && typeof onNode !== 'function') {
      throw new TypeError('run: "onNode" must be a function');
    }
    const runId = opts?.runId;
    if (runId !== undefined && checkpoint === undefined) {
      throw new TypeError('run: "runId" needs a checkpoint store on compileDag');
    }
    if (checkpoint !== undefined
      && (typeof runId !== 'string' || runId === '')) {
      throw new TypeError(
        'run: a checkpointed dag needs a non-empty string "runId" to persist under');
    }
    return execute(input === undefined ? null : input, signal, onNode, runId, opts?.drainOnAbort === true);
  }

  /**
   * @param {any} runInput
   * @param {AbortSignal|undefined} signal
   * @param {((record: DagNodeRecord) => void)|undefined} onNode
   * @param {string|undefined} runId
   * @param {boolean} drainOnAbort
   */
  async function execute(runInput, signal, onNode, runId, drainOnAbort) {
    const controller = new AbortController();
    /** @type {FlowRuntimeError|null} */
    let failure = null;
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = reject; });
    aborted.catch(() => {});
    const identity = revision === undefined ? undefined
      : Object.freeze({ revision, document: documentIdentity, input: canonicalizeJson(runInput), taskVersions });

    /** @param {DagNodeRecord} rec */
    const record = (rec) => {
      if (onNode === undefined) return;
      try {
        onNode(rec);
      }
      catch { /* observation must not change a run (§7.4) */ }
    };

    /**
     * Register the canonical run failure exactly once and abort the
     * shared signal (§7.3).
     * @param {FlowRuntimeError} err
     */
    const fail = (err) => {
      if (failure === null) {
        failure = err;
        controller.abort();
        rejectAborted(err);
      }
    };

    /** @type {(() => void) | null} */
    let onAbort = null;
    if (signal !== undefined) {
      if (signal.aborted) {
        throw new FlowRuntimeError('JF2007', 'the run was aborted before it started', '',
          signal.reason instanceof Error ? signal.reason : undefined);
      }
      onAbort = () => {
        fail(new FlowRuntimeError('JF2007', 'the run was aborted', '',
          signal.reason instanceof Error ? signal.reason : undefined));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    /** @type {Map<string, Promise<any>>} */
    const promises = new Map();

    // a resumed run SEEDS the memo from the store (§7.6): recorded
    // values for declared-checkpoint nodes skip evaluation entirely —
    // the execution model is untouched, only where the memo comes from
    if (checkpoint !== undefined && runId !== undefined) {
      let loaded;
      try {
        loaded = await Promise.race([checkpoint.load(runId, identity), aborted]);
        if (identity !== undefined && loaded != null
          && canonicalizeJson(loaded.identity ?? null) !== canonicalizeJson(identity)) {
          throw new FlowRuntimeError('JF2013', `checkpoint '${runId}' has different or missing provenance`);
        }
      }
      catch (err) {
        if (signal !== undefined && onAbort !== null)
          signal.removeEventListener('abort', onAbort);
        if (failure !== null) throw failure;
        if (err instanceof FlowRuntimeError && err.code === 'JF2013') throw err;
        const cause = asError(err);
        throw new FlowRuntimeError('JF2009',
          `the checkpoint store failed to load run '${runId}': ${cause.message}`,
          '', cause);
      }
      if (loaded !== null && loaded !== undefined && isJsonObject(loaded.values)) {
        for (const id of Object.keys(loaded.values)) {
          const node = nodes.get(id);
          if (node === undefined || node.checkpoint !== true) continue;
          promises.set(id, Promise.resolve(loaded.values[id]));
          record({ id, status: 'restored', ms: 0 });
        }
      }
    }

    /** @param {string} id @returns {Promise<any>} */
    const valueOf = (id) => {
      let p = promises.get(id);
      if (p === undefined) {
        p = evaluate(/** @type {any} */ (nodes.get(id)));
        promises.set(id, p);
      }
      return p;
    };

    /** @param {any} node @returns {Promise<any>} */
    async function evaluate(node) {
      // upstream failures propagate without a record: this node never
      // started (§7.4)
      const raw = await Promise.all(node.inbound.map((e) => valueOf(e.from)));
      // a failed run launches no new work — inputs may have arrived,
      // but the canonical failure propagates instead (§7.3)
      if (failure !== null) throw failure;

      const started = globalThis.performance.now();
      /** @param {'ok'|'error'|'aborted'} status */
      const settle = (status) =>
        record({ id: node.id, status, ms: globalThis.performance.now() - started });

      try {
        // deliveries: per-edge select, empty → null (§6.1)
        const delivered = node.inbound.map((e, i) => {
          if (e.select === null) return raw[i];
          try {
            const v = e.select(raw[i]);
            return v === undefined ? null : v;
          }
          catch (err) {
            const cause = asError(err);
            throw new FlowRuntimeError('JF2006',
              `the select on edge ${e.edgeIndex} into '${node.id}' failed: ${cause.message}`,
              `/edges/${e.edgeIndex}/select`, cause);
          }
        });
        let scope = null;
        if (node.ports) {
          scope = {};
          for (let i = 0; i < node.inbound.length; i++) {
            setObjectMember(scope, node.inbound[i].port, delivered[i]);
          }
        }
        else if (node.inbound.length === 1) {
          scope = delivered[0];
        }

        let value;
        switch (node.kind) {
          case 'input': value = runInput; break;
          case 'const': value = node.value; break;
          case 'output': value = scope; break;
          case 'query': value = node.query(scope) ?? null; break;
          case 'jslt': value = node.transform(scope) ?? null; break;
          case 'task': {
            const props = {
              with: node.with === null ? null : node.with(scope) ?? null,
              input: scope,
            };
            value = (await node.handler(props, controller.signal)) ?? null;
            break;
          }
          default: value = null; break;
        }
        if (failure !== null) throw failure;
        if (node.checkpoint && checkpoint !== undefined && runId !== undefined) {
          // the explicit serialization contract (§7.6): the node
          // DECLARED its output JSON; a value that is not fails the
          // run at save time, never a silent skip
          try {
            canonicalizeJson(value);
          }
          catch (err) {
            const cause = asError(err);
            throw new FlowRuntimeError('JF2008',
              `node '${node.id}' declared checkpoint but produced a value that is `
              + `not JSON-serializable: ${cause.message}`, node.docPath, cause);
          }
          try {
            await Promise.race([checkpoint.save(runId, node.id, value, identity), aborted]);
          }
          catch (err) {
            const cause = asError(err);
            throw new FlowRuntimeError('JF2009',
              `the checkpoint store failed to save node '${node.id}': ${cause.message}`,
              node.docPath, cause);
          }
        }
        if (failure !== null) throw failure;
        settle('ok');
        return value;
      }
      catch (err) {
        const mapped = err instanceof FlowRuntimeError && /** @type {any} */ (err).nodeId !== undefined
          ? /** @type {FlowRuntimeError} */ (err)
          : (() => {
            const cause = err instanceof FlowRuntimeError ? err.cause : asError(err);
            const wrapped = err instanceof FlowRuntimeError
              ? err
              : new FlowRuntimeError('JF2006',
                `node '${node.id}' failed: ${asError(err).message}`,
                node.docPath, /** @type {Error|undefined} */ (cause instanceof Error ? cause : undefined));
            return wrapped;
          })();
        /** @type {any} */ (mapped).nodeId ??= node.id;
        const status = failure !== null || controller.signal.aborted ? 'aborted' : 'error';
        if (status === 'error') fail(mapped);
        settle(status);
        throw mapped;
      }
    }

    const all = order.map((id) => {
      const p = valueOf(id);
      p.catch(() => { /* guarded: the run rethrows the canonical failure */ });
      return p;
    });

    try {
      await Promise.race([Promise.all(all), aborted]);
      if (failure !== null) throw failure;
      const result = await promises.get(outputId);
      if (checkpoint !== undefined && runId !== undefined) {
        try {
          await Promise.race([checkpoint.complete(runId, result, identity), aborted]);
        }
        catch (err) {
          if (failure !== null) throw failure;
          const cause = asError(err);
          throw new FlowRuntimeError('JF2009',
            `the checkpoint store failed to complete run '${runId}': ${cause.message}`,
            '', cause);
        }
      }
      return result;
    }
    catch (err) {
      // A worker's shutdown report accounts for actual task lifetimes. It
      // owns a separate grace deadline, so it may ask us to retain the run
      // until ignoring handlers settle instead of reporting early drainage.
      if (drainOnAbort && failure?.code === 'JF2007') await Promise.allSettled(all);
      throw failure ?? err;
    }
    finally {
      if (signal !== undefined && onAbort !== null) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  // The canonical version map: every declared task identity this
  // workflow depends on, keyed by node path and SORTED, so two compiles
  // of the same document answer the same map whatever order the
  // declarations were written in. A handler that is itself a workflow
  // contributes its own map under this node's path.
  /** @type {Record<string, string>} */
  const versions = {};
  for (const node of nodes.values()) {
    if (node.kind !== 'task' || node.version === null) continue;
    const pathPrefix = encodeJSONPointerSegment(node.id);
    setObjectMember(versions, pathPrefix, node.version);
    if (node.nestedVersions === null) continue;
    for (const [path, version] of Object.entries(node.nestedVersions)) {
      setObjectMember(versions, `${pathPrefix}/${path}`, version);
    }
  }
  const taskVersions = Object.freeze(Object.fromEntries(
    Object.keys(versions).sort().map((key) => [key, versions[key]])));

  return Object.freeze({
    nodes: Object.freeze(order.slice()),
    output: outputId,
    taskVersions,
    run,
  });
}
