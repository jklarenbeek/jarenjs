//@ts-check
/**
 * @file `defineDag()` — one `jaren-dag` 0.1 document (FLOW-FORMAT.md
 * §6), deep-frozen, that `compileDag` takes unchanged. `input()`,
 * `constant()`, `query()`, `jslt()`, `task()` and `output()` are the
 * closed kind vocabulary §6 fixes — one pen method per kind, so a kind
 * the format does not have cannot be spelled — and `edge()` is the
 * wiring. `.checkpoint()` writes §7.6's opt-in `checkpoint: true`.
 *
 * A `query` node's document, a `task`'s props and an edge's `select`
 * are captured over the node's input scope (§6.1) at `$`; a `jslt`
 * node's stylesheet is the JSLT pen's document, or one written by hand.
 * Node ids are literal types, so an edge from a node nothing declares
 * is a compile error; at runtime it is `JL0102` naming the id, before
 * the compiler's `JF0013`.
 *
 * What the pen does NOT judge is the compiler's, and every emitted
 * document is compiled in the tests: the wiring rules (`JF0015`),
 * acyclicity (`JF0016`), the exactly-one-output rule (`JF0017`) and
 * task-registry resolution (`JF0018`).
 */

import { cloneJson, deepFreeze, setObjectMember, isJsonObject } from '@jarenjs/core/object';

import { LinqBuildError } from '../errors.js';
import { describeValue, requireJson, requireNameMap } from '../json-boundary.js';
import { queryMember } from './capture.js';

const DAG_VERSION = '0.1';

/** FLOW-FORMAT §6.1's scope, for a `JL0104` message. */
const SCOPE = "the node's input scope (FLOW-FORMAT §6.1)";

/** The node-declaration brand; the members it emits live under it. */
const NODE = Symbol.for('@jarenjs/linq/flow-node');
/** The edge brand; the members it emits live under it. */
const EDGE = Symbol.for('@jarenjs/linq/flow-edge');

/** The members `edge()` takes beside its two positional arguments. */
const EDGE_MEMBERS = Object.freeze(['port', 'select']);
/** The members `defineDag()` takes. */
const DAG_MEMBERS = Object.freeze(['nodes', 'edges']);

/**
 * A member set the pen knows, or `JL0101` naming the one it does not.
 * @param {any} spec
 * @param {readonly string[]} members
 * @param {string} what
 */
function closedTo(spec, members, what) {
  for (const key of Object.keys(spec)) {
    if (!members.includes(key)) {
      throw new LinqBuildError('JL0101',
        `${what} does not take '${key}' — it takes ${members.join(', ')}`, `/${key}`);
    }
  }
}

/**
 * One node declaration: immutable, its emitted members carried under
 * the brand so `checkpoint` can be a method here and a member there.
 * @param {any} members - the node's members, in document order
 * @returns {any}
 */
function node(members) {
  const out = {
    /**
     * Declare this node's value durable (§7.6): a checkpoint store
     * records it and a resumed run seeds it instead of re-evaluating.
     * The value must be JSON — `JF2008` at save time otherwise, never
     * a silent skip.
     */
    checkpoint() {
      if (members.kind === 'task' && members.version === undefined) {
        throw new LinqBuildError('JL0101',
          `checkpoint() on task('${members.run}') needs the handler's declared version — `
          + "write task(run, props, { version }); a recorded value is replayed only while "
          + 'the handler that produced it is the same one', '/version');
      }
      return node({ ...members, checkpoint: true });
    },
  };
  Object.defineProperty(out, NODE, { value: members, enumerable: false });
  return Object.freeze(out);
}

/**
 * The `input` node (§6): it yields the `run(input)` value — `null` when
 * the caller passes none — and accepts no inbound edge.
 * @returns {any} the node declaration
 */
export function input() { return node({ kind: 'input' }); }

/**
 * The `output` node (§6): its input-scope value IS the run's result.
 * Exactly one per document (the compiler's `JF0017`), no outbound edge.
 * @returns {any} the node declaration
 */
export function output() { return node({ kind: 'output' }); }

/**
 * A `const` node (§6): its literal value, delivered by reference.
 * @param {any} value - any JSON value
 * @returns {any} the node declaration
 * @example
 * constant({ threshold: 18 });
 */
export function constant(value) {
  if (value === undefined) {
    throw new LinqBuildError('JL0101',
      'constant() takes the value the node yields — every JSON value, null included; '
      + 'undefined is not one', '/value');
  }
  return node({ kind: 'const', value: cloneJson(requireJson(value, 'constant()')) });
}

/**
 * A `query` node (§6): a Jaren JSON Query over the node's input scope.
 * @param {any} document - `(v) => …` captured over `$`, or a query document
 * @returns {any} the node declaration
 * @example
 * query((rows) => rows.all().age);      // captured
 * query('$.summary');                   // a path document, verbatim
 */
export function query(document) {
  if (document === undefined) {
    throw new LinqBuildError('JL0101',
      'query() takes a callback (v) => … captured over the node input, or a query document',
      '/query');
  }
  return node({ kind: 'query', query: queryMember('query()', SCOPE, document) });
}

/**
 * A `jslt` node (§6): a stylesheet transforming the node's input scope.
 * @param {any} document - the JSLT pen's stylesheet (or rule array), or one by hand
 * @returns {any} the node declaration
 * @example
 * jslt(stylesheet([rule('$', (v) => ({ names: [apply(v.all())] }))]));
 */
export function jslt(document) {
  if (document === undefined) {
    throw new LinqBuildError('JL0101',
      'jslt() takes a stylesheet document — the JSLT pen\'s stylesheet(…) or rule array, '
      + 'or one written by hand', '/stylesheet');
  }
  return node({ kind: 'jslt', stylesheet: cloneJson(requireJson(document, 'jslt()')) });
}

/**
 * A `task` node (§7.2): a registered async handler, called as
 * `handler({ with, input }, signal)`. The pen writes the NAME; the
 * registry a host hands `compileDag` resolves it (`JF0018` when it
 * cannot).
 * @param {string} run - the registry handler name
 * @param {any} [props] - `(v) => ({ … })` over the input scope, or a query document
 * @param {{ version?: string }} [options] - the declared identity of the
 *   handler implementation (§7.8), which the registry must supply too.
 *   REQUIRED on a `.checkpoint()` node: a recorded value is replayed only
 *   while the handler that produced it is the same one.
 * @returns {any} the node declaration
 * @example
 * task('llm', (v) => ({ prompt: v.instruction }), { version: '2026-09-05' });
 */
export function task(run, props = undefined, options = undefined) {
  if (typeof run !== 'string' || run === '') {
    throw new LinqBuildError('JL0101',
      `task() takes the handler name as a non-empty string, got ${describeValue(run)}`, '/run');
  }
  const version = options?.version;
  if (version !== undefined && (typeof version !== 'string' || version === '')) {
    throw new LinqBuildError('JL0101',
      `task() takes the handler version as a non-empty string, got ${describeValue(version)}`,
      '/version');
  }
  const members = { kind: 'task', run };
  if (version !== undefined) members.version = version;
  if (props !== undefined) members.with = queryMember('task() with', SCOPE, props);
  return node(members);
}

/**
 * One edge (§6): data flows from a node's result to a consumer's input
 * scope. `port` names the delivery in a ported fan-in (§6.1); `select`
 * is applied to the source value before delivery.
 * @param {string} from - the producing node id
 * @param {string} to - the consuming node id
 * @param {{ port?: string, select?: any }} [options]
 * @returns {any} the edge declaration
 * @example
 * edge('rows', 'adults');
 * edge('adults', 'report', { port: 'rows', select: (v) => v.all().name });
 */
export function edge(from, to, options = undefined) {
  if (typeof from !== 'string' || from === '') {
    throw new LinqBuildError('JL0101',
      `edge() takes the producing node id as a non-empty string, got ${describeValue(from)}`,
      '/from');
  }
  if (typeof to !== 'string' || to === '') {
    throw new LinqBuildError('JL0101',
      `edge() takes the consuming node id as a non-empty string, got ${describeValue(to)}`,
      '/to');
  }
  const members = { from, to };
  if (options !== undefined) {
    if (!isJsonObject(options)) {
      throw new LinqBuildError('JL0101',
        `edge() options are { port?, select? }, got ${describeValue(options)}`);
    }
    closedTo(options, EDGE_MEMBERS, 'edge()');
    if (options.port !== undefined) {
      if (typeof options.port !== 'string' || options.port === '') {
        throw new LinqBuildError('JL0101',
          `edge() port is a non-empty string, got ${describeValue(options.port)}`, '/port');
      }
      members.port = options.port;
    }
    if (options.select !== undefined) {
      members.select = queryMember('edge() select', 'the source value (FLOW-FORMAT §6)',
        options.select);
    }
  }
  const out = {};
  Object.defineProperty(out, EDGE, { value: members, enumerable: false });
  return Object.freeze(out);
}

/**
 * Write a `jaren-dag` 0.1 document (FLOW-FORMAT.md §6).
 *
 * Every id an edge names must be declared — `JL0102` naming it, before
 * the compiler's `JF0013`. Everything else about the wiring is
 * `compileDag`'s.
 *
 * @param {any} spec - `{ nodes, edges }`
 * @returns {any} the deep-frozen `$dag` 0.1 document
 * @throws {LinqBuildError} `JL0101` a value the pen cannot spell;
 *   `JL0102` an edge on an undeclared node id
 * @example
 * const graph = defineDag({
 *   nodes: { rows: input(), adults: query('$[*]'), out: output() },
 *   edges: [edge('rows', 'adults'), edge('adults', 'out')],
 * });
 * await compileDag(graph).run([{ age: 20 }]);
 */
export function defineDag(spec) {
  if (!isJsonObject(spec)) {
    throw new LinqBuildError('JL0101',
      `defineDag() takes { nodes, edges }, got ${describeValue(spec)}`);
  }
  closedTo(spec, DAG_MEMBERS, 'defineDag()');
  if (!isJsonObject(spec.nodes)) {
    throw new LinqBuildError('JL0101',
      `defineDag() nodes is a plain object of id → node declaration, got ${describeValue(spec.nodes)}`,
      '/nodes');
  }
  requireNameMap(spec.nodes, 'defineDag() nodes', '/nodes');
  const ids = Object.keys(spec.nodes);
  if (ids.length === 0) {
    throw new LinqBuildError('JL0101', 'defineDag() needs at least one node', '/nodes');
  }
  const nodes = {};
  for (const id of ids) {
    const declared = spec.nodes[id];
    const members = isJsonObject(declared) ? declared[NODE] : undefined;
    if (members === undefined) {
      throw new LinqBuildError('JL0101',
        `defineDag() node '${id}' is input(), constant(), query(), jslt(), task() or `
        + `output(), got ${describeValue(declared)}`, `/nodes/${id}`);
    }
    setObjectMember(nodes, id, { ...members });
  }

  if (!Array.isArray(spec.edges)) {
    throw new LinqBuildError('JL0101',
      `defineDag() edges is an array of edge(from, to) declarations, got ${describeValue(spec.edges)}`,
      '/edges');
  }
  const edges = spec.edges.map((declared, i) => {
    const at = `/edges/${i}`;
    const members = isJsonObject(declared) ? declared[EDGE] : undefined;
    if (members === undefined) {
      throw new LinqBuildError('JL0101',
        `defineDag() edges[${i}] is edge(from, to, options?), got ${describeValue(declared)}`, at);
    }
    for (const end of ['from', 'to']) {
      if (!Object.hasOwn(nodes, members[end])) {
        throw new LinqBuildError('JL0102',
          `edge ${i} names the node '${members[end]}', which "nodes" does not declare — the `
          + `declared nodes are ${ids.map((id) => `'${id}'`).join(', ')}`, `${at}/${end}`);
      }
    }
    return { ...members };
  });

  return deepFreeze({ $dag: DAG_VERSION, nodes, edges });
}

/**
 * Bind a task registry to the graph it serves. Identity at runtime: the
 * table is checked against the task names the document declares, so the
 * registry `compileDag` resolves and the document agree at compile
 * time; the runtime check remains `JF0018`.
 * @template D
 * @template T
 * @param {D} dag - the pen's graph; the type argument only
 * @param {T} tasks - handler name → handler
 * @returns {T}
 * @example
 * compileDag(graph, { tasks: typedTasks(graph, { llm: askModel }) });
 */
export function typedTasks(dag, tasks) {
  void dag;
  return tasks;
}
