//@ts-check
/** Deterministic lowering and a persistence bridge over the two flow engines.
 * The statechart selects control; compileDag owns node scheduling/concurrency.
 * See docs/WORKFLOW-FORMAT.md for the document and compare-and-swap store. */
import { deepFreeze, isJsonObject, setObjectMember } from '@jarenjs/core/object';
import { hashContent } from '@jarenjs/core/string';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { compileJsonQuery } from '@jarenjs/json/query';
import { compileDag } from './dag.js';
import { compileStatechart } from './statechart.js';
import { asError, FlowCompileError, FlowRuntimeError } from './errors.js';

const NEXT = '@workflow/next';
const DONE = '@workflow/done';
const ERROR = '@workflow/error';
const clone = (value) => JSON.parse(canonicalizeJson(value));
const fail = (reason, path) => { throw new FlowCompileError('JF0021', reason, path); };
const malformed = (reason) => { throw new FlowRuntimeError('JF2016', reason); };
const nonblank = (s) => typeof s === 'string' && s.trim() !== '';

/** @typedef {{version: string, revision: string, document: any, fsm: any,
 * dags: Record<string, any>, sources: Record<string, string>, specs: Record<string, any>}} LoweredWorkflow */
/** @typedef {{format: string, runId: string, identity: any, generation: number,
 * control: import('./statechart.js').StatechartState,
 * context: {input: any, data: any, event: null | {type: string, payload?: any}, results: Record<string, any>, visits: Record<string, number>},
 * pending: null | {state: string, visit: number, input: any, values: Record<string, any>, identity?: any, result?: any},
 * status: 'running'|'waiting'|'done'}} WorkflowSnapshot */
/** @typedef {{status: 'waiting'|'done', result: any, snapshot: WorkflowSnapshot}} WorkflowResult */
/** @typedef {{lowered: LoweredWorkflow, revisions: {control: string, dags: Record<string, string>},
 * taskVersions: Readonly<Record<string, string>>,
 * run: (input: any, opts: WorkflowRunOptions) => Promise<WorkflowResult>}} CompiledWorkflow */

/** Lower one neutral workflow to inspectable JSON, without resolving host tasks.
 * Work states carry work:{task,version,with?} or work:{dag}; choose/on/flow/final
 * are the other mutually exclusive control forms. @param {any} document
 * @returns {LoweredWorkflow} */
export function lowerWorkflow(document) {
  let doc;
  try { doc = clone(document); }
  catch (err) { throw new FlowCompileError('JF0021', 'workflow must be JSON', '', asError(err)); }
  if (!isJsonObject(doc) || doc.$workflow !== '0.2' || !nonblank(doc.revision))
    fail('a workflow requires "$workflow": "0.2" and a nonblank revision', '');
  for (const key of Object.keys(doc)) if (!['$workflow', 'revision', 'initial', 'states'].includes(key)) fail('unknown workflow member', `/${key}`);
  const states = [];
  const transitions = [];
  const dags = {};
  const sources = {};
  const specs = {};
  const automatic = new Map();
  const bounded = new Set();

  function lower(body, prefix, parent, continuation, depth) {
    if (depth > 64) fail('nested workflow depth exceeds 64', prefix);
    if (!isJsonObject(body) || !isJsonObject(body.states) || !Object.keys(body.states).length)
      fail('states must be a non-empty object', `${prefix}/states`);
    if (parent !== null) for (const key of Object.keys(body)) if (!['initial', 'states'].includes(key)) fail('unknown nested flow member', `${prefix}/${key}`);
    if (typeof body.initial !== 'string' || !Object.hasOwn(body.states, body.initial))
      fail('initial must name a state in this scope', `${prefix}/initial`);
    const idOf = (name) => {
      if (typeof name !== 'string' || !Object.hasOwn(body.states, name))
        fail(`undeclared state '${String(name)}' in this scope`, `${prefix}/states`);
      return `${prefix}/states/${encodeJSONPointerSegment(name)}`;
    };
    for (const [name, spec] of Object.entries(body.states)) {
      const id = idOf(name);
      if (!name || !isJsonObject(spec)) fail('a state needs a non-empty id and an object declaration', id);
      const forms = ['work', 'choose', 'on', 'flow', 'final'].filter((key) => Object.hasOwn(spec, key));
      if (forms.length !== 1 || (forms[0] === 'final' && spec.final !== true))
        fail('a state declares exactly one of work, choose, on, flow or final:true', id);
      const kind = forms[0];
      const allowed = {
        work: ['work', 'input', 'then', 'catch', 'limit'],
        choose: ['choose', 'otherwise', 'limit'],
        on: ['on', 'after', 'limit'],
        flow: ['flow', 'then', 'limit'],
        final: ['final', 'limit'],
      }[kind];
      for (const key of Object.keys(spec)) if (!allowed.includes(key)) fail(`unexpected '${key}' on ${kind} state`, `${id}/${key}`);
      if (spec.limit !== undefined && (!Number.isSafeInteger(spec.limit) || spec.limit < 1))
        fail('limit must be a positive safe integer', `${id}/limit`);
      if (spec.limit !== undefined) bounded.add(id);
      setObjectMember(specs, id, { ...spec, kind });
      setObjectMember(sources, id, id);
      const state = { id, ...(parent ? { parent } : {}) };
      const links = [];
      automatic.set(id, links);
      const edge = (to, fields, auto = true) => {
        const target = idOf(to);
        transitions.push({ from: id, to: target, ...fields });
        if (auto) links.push(target);
      };
      if (kind === 'work') {
        if (!isJsonObject(spec.work) || (Object.hasOwn(spec.work, 'task') === Object.hasOwn(spec.work, 'dag')))
          fail('work must declare either task or dag', `${id}/work`);
        let dag;
        if (Object.hasOwn(spec.work, 'task')) {
          if (!nonblank(spec.work.task) || !nonblank(spec.work.version))
            fail('a task needs a nonblank task name and version', `${id}/work`);
          for (const k of Object.keys(spec.work)) if (!['task', 'version', 'with'].includes(k)) fail('unknown task member', `${id}/work/${k}`);
          dag = { $dag: '0.1', nodes: {
            input: { kind: 'input' },
            task: { kind: 'task', run: spec.work.task, version: spec.work.version, checkpoint: true,
              ...(Object.hasOwn(spec.work, 'with') ? { with: spec.work.with } : {}) },
            output: { kind: 'output', checkpoint: true },
          }, edges: [{ from: 'input', to: 'task' }, { from: 'task', to: 'output' }] };
        }
        else {
          if (Object.keys(spec.work).length !== 1 || !isJsonObject(spec.work.dag)) fail('work.dag must be a DAG document', `${id}/work/dag`);
          dag = clone(spec.work.dag);
          // Completion is a serialization boundary even if the author elects
          // to recompute intermediate nodes. This requires all task versions.
          for (const node of Object.values(dag.nodes ?? {})) if (node?.kind === 'output') node.checkpoint = true;
        }
        setObjectMember(dags, id, dag);
        edge(spec.then, { event: DONE });
        if (spec.catch !== undefined) edge(spec.catch, { event: ERROR });
      }
      else if (kind === 'choose') {
        if (!Array.isArray(spec.choose) || !spec.choose.length) fail('choose needs at least one guarded branch', `${id}/choose`);
        for (const [i, branch] of spec.choose.entries()) {
          if (!isJsonObject(branch) || !Object.hasOwn(branch, 'guard') || Object.keys(branch).some((k) => !['guard', 'to'].includes(k)))
            fail('a choice is {guard,to}', `${id}/choose/${i}`);
          edge(branch.to, { event: NEXT, guard: branch.guard });
        }
        edge(spec.otherwise, { event: NEXT });
      }
      else if (kind === 'on') {
        if (!Array.isArray(spec.on) || (!spec.on.length && spec.after === undefined)) fail('a wait needs events or a delay', `${id}/on`);
        for (const [i, branch] of spec.on.entries()) {
          if (!isJsonObject(branch) || !nonblank(branch.event) || Object.keys(branch).some((k) => !['event', 'to', 'guard'].includes(k)))
            fail('a wait branch is {event,to,guard?}', `${id}/on/${i}`);
          edge(branch.to, { event: `event:${branch.event}`, ...(Object.hasOwn(branch, 'guard') ? { guard: branch.guard } : {}) }, false);
        }
        if (spec.after !== undefined) {
          if (!isJsonObject(spec.after) || !Number.isFinite(spec.after.ms) || spec.after.ms < 0
            || Object.keys(spec.after).some((k) => !['ms', 'to'].includes(k))) fail('after is {ms,to} with a nonnegative finite duration', `${id}/after`);
          edge(spec.after.to, { after: spec.after.ms });
        }
      }
      else if (kind === 'flow') {
        const next = idOf(spec.then);
        state.initial = lower(spec.flow, `${id}/flow`, id, next, depth + 1);
        links.push(state.initial);
        transitions.push({ from: id, to: next, done: true });
      }
      else {
        state.final = true;
        if (continuation !== null) links.push(continuation);
      }
      states.push(state);
    }
    return idOf(body.initial);
  }
  const initial = lower(doc, '', null, null, 0);
  // Every automatically traversable cycle must cross a finite visit budget.
  // External event edges do not run by themselves and need no invented limit.
  const visiting = new Set();
  const visited = new Set();
  const prove = (id) => {
    if (bounded.has(id) || visited.has(id)) return;
    if (visiting.has(id)) throw new FlowCompileError('JF0022', 'automatic cycle requires a state limit', sources[id]);
    visiting.add(id);
    for (const next of automatic.get(id) ?? []) prove(next);
    visiting.delete(id); visited.add(id);
  };
  for (const id of automatic.keys()) prove(id);
  const fsm = { $fsm: '0.2', initial, states, transitions };
  compileStatechart(fsm);
  return deepFreeze({ version: '0.1', revision: doc.revision, document: doc, fsm, dags, sources, specs });
}

/** @typedef {{ load: (runId: string) => WorkflowSnapshot | null | Promise<WorkflowSnapshot | null>,
 * save: (runId: string, snapshot: WorkflowSnapshot, expectedGeneration: number) => boolean | Promise<boolean> }} WorkflowStore */
/** @typedef {{ runId: string, snapshot?: any, expectedGeneration?: number,
 * signal?: AbortSignal, resources?: unknown, now?: number, event?: {type: string, payload?: any},
 * onTrace?: (record: any) => void }} WorkflowRunOptions */
/** Compile once; each run owns its control and checkpoint records.
 * Store save MUST atomically compare expectedGeneration (0 means absent).
 * @param {any} document
 * @param {{tasks?: NonNullable<Parameters<typeof compileDag>[1]>['tasks'], store?: WorkflowStore}} [options]
 * @returns {CompiledWorkflow}
 */
export function compileWorkflow(document, options = {}) {
  const lowered = lowerWorkflow(document);
  const chart = compileStatechart(lowered.fsm);
  const store = options.store;
  if (store && (typeof store.load !== 'function' || typeof store.save !== 'function'))
    throw new TypeError('workflow store requires load and compare-and-swap save');
  const routes = new Map();
  const running = new Set();
  const dags = new Map();
  const inputs = new Map();
  const taskVersions = {};
  const revisions = { control: hashContent(canonicalizeJson(lowered.fsm)), dags: {} };
  const route = (key) => {
    const r = routes.get(key);
    if (!r) throw new FlowRuntimeError('JF2014', 'DAG activation no longer belongs to a live workflow run');
    return r;
  };
  for (const [id, doc] of Object.entries(lowered.dags)) {
    const revision = hashContent(canonicalizeJson(doc));
    setObjectMember(revisions.dags, id, revision);
    const dag = compileDag(doc, { tasks: options.tasks, revision, checkpoint: {
      load: (key, identity) => route(key).load(identity),
      save: (key, node, value) => route(key).save(node, value),
      complete: (key, result) => route(key).complete(result),
    } });
    dags.set(id, dag);
    for (const [node, version] of Object.entries(dag.taskVersions))
      setObjectMember(taskVersions, `${id}/${node}`, version);
    try { inputs.set(id, compileJsonQuery(lowered.specs[id].input ?? '$.context.data')); }
    catch (err) { throw new FlowCompileError('JF0014', 'workflow input query failed to compile', `${id}/input`, asError(err)); }
  }
  const versions = deepFreeze(Object.fromEntries(Object.entries(taskVersions).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  const identity = deepFreeze({ document: canonicalizeJson(lowered.document), lowering: lowered.version,
    control: canonicalizeJson(lowered.fsm), dags: canonicalizeJson(lowered.dags), taskVersions: versions });
  deepFreeze(revisions);

  /** @param {any} input @param {WorkflowRunOptions} opts @returns {Promise<WorkflowResult>} */
  async function run(input, opts) {
    if (!nonblank(opts?.runId)) throw new TypeError('workflow run requires a nonblank runId');
    if (opts.snapshot !== undefined && store) throw new TypeError('use either snapshot or a store, not both');
    if (opts.event !== undefined && (!isJsonObject(opts.event) || !nonblank(opts.event.type)))
      throw new TypeError('event requires a nonblank type');
    if (opts.onTrace !== undefined && typeof opts.onTrace !== 'function') throw new TypeError('onTrace must be a function');
    if (opts.signal !== undefined && typeof opts.signal?.addEventListener !== 'function') throw new TypeError('signal must be an AbortSignal');
    if (opts.expectedGeneration !== undefined && (!Number.isSafeInteger(opts.expectedGeneration) || opts.expectedGeneration < 0))
      throw new TypeError('expectedGeneration must be a nonnegative safe integer');
    const runId = opts.runId;
    if (running.has(runId)) throw new FlowRuntimeError('JF2014', `workflow '${runId}' is already running`);
    running.add(runId);
    const controller = new AbortController();
    let live = true;
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = reject; });
    aborted.catch(() => {});
    const abort = () => {
      controller.abort(opts.signal?.reason);
      rejectAborted(new FlowRuntimeError('JF2007', 'workflow run aborted'));
    };
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener('abort', abort, { once: true });
    const ensureLive = () => {
      if (!live || controller.signal.aborted) throw new FlowRuntimeError('JF2007', 'workflow activation is no longer live');
    };
    const wait = (value) => Promise.race([value, aborted]);
    const observe = (record) => {
      try { opts.onTrace?.(deepFreeze({ runId, revision: lowered.revision, revisions, ...record })); }
      catch { /* Observers cannot alter a run. */ }
    };
    let snapshot;
    let writes = Promise.resolve();
    // Node settlements use one serial CAS stream, so concurrent fan-in cannot
    // overwrite a sibling's checkpoint. Failed writes poison this activation.
    const persist = (mutate = undefined) => {
      writes = writes.then(async () => {
        ensureLive();
        const next = clone(snapshot);
        mutate?.(next);
        if (!Number.isSafeInteger(next.generation + 1)) malformed('snapshot generation exhausted');
        next.generation++;
        deepFreeze(next);
        if (store) {
          let saved;
          try { saved = await wait(store.save(runId, next, snapshot.generation)); }
          catch (err) {
            if (controller.signal.aborted) throw err;
            throw new FlowRuntimeError('JF2009', 'workflow store save failed', '', asError(err));
          }
          if (saved !== true) throw new FlowRuntimeError('JF2014', 'workflow snapshot generation is stale');
        }
        ensureLive();
        snapshot = next;
      });
      writes.catch(() => {});
      return writes;
    };
    const admit = (next, entered) => {
      for (const id of entered) {
        const visits = (next.context.visits[id] ?? 0) + 1;
        if (!Number.isSafeInteger(visits) || visits > (lowered.specs[id].limit ?? Infinity))
          throw new FlowRuntimeError('JF2015', `state '${id}' exceeded its visit limit`, lowered.sources[id]);
        setObjectMember(next.context.visits, id, visits);
      }
    };
    const apply = async (r, mutate = undefined) => {
      if (r.errors.length) throw new FlowRuntimeError('JF2016', r.errors[0].message, r.errors[0].docPath);
      await persist((next) => {
        mutate?.(next);
        next.control = r.state;
        next.status = r.final ? 'done' : 'running';
        admit(next, r.entered);
      });
      observe({ type: 'transition', transitions: r.transitions, entered: r.entered, exited: r.exited,
        active: r.state.active, generation: snapshot.generation });
    };
    const scope = () => scopeForSaved(snapshot);
    const step = (event, payload = null, context = snapshot.context) => chart.step(snapshot.control, event,
      { context, payload });
    function validate(saved, originalInput) {
      if (!isJsonObject(saved) || saved.format !== 'jaren-workflow-run/0.1' || saved.runId !== runId
        || !Number.isSafeInteger(saved.generation) || saved.generation < 1
        || !['running', 'waiting', 'done'].includes(saved.status) || !isJsonObject(saved.context)
        || !isJsonObject(saved.context.results) || !isJsonObject(saved.context.visits)
        || !Object.hasOwn(saved.context, 'data') || !Object.hasOwn(saved.context, 'input')
        || (saved.context.event !== null && (!isJsonObject(saved.context.event) || !nonblank(saved.context.event.type)))) malformed('invalid workflow snapshot');
      if (canonicalizeJson(saved.identity ?? null) !== canonicalizeJson(identity)
        || canonicalizeJson(saved.context.input) !== canonicalizeJson(originalInput))
        throw new FlowRuntimeError('JF2013', 'workflow, lowering, input or task identity changed');
      chart.restore(saved.control);
      for (const [id, count] of Object.entries(saved.context.visits)) {
        if (!Object.hasOwn(lowered.specs, id) || !Number.isSafeInteger(count) || count < 1
          || count > (lowered.specs[id].limit ?? Infinity)) malformed('invalid visit record');
      }
      for (const id of Object.keys(saved.context.results)) if (!dags.has(id)) malformed('unknown work result');
      if (saved.control.active.length !== 1 || !saved.context.visits[saved.control.active[0]]) malformed('workflow needs one admitted active leaf');
      const active = saved.control.active[0];
      if ((saved.status === 'done') !== chart.final(saved.control)
        || (saved.status === 'waiting' && lowered.specs[active].kind !== 'on')) malformed('snapshot status disagrees with control');
      if (saved.pending !== null) {
        const p = saved.pending;
        if (!isJsonObject(p) || p.state !== active || !dags.has(active)
          || p.visit !== saved.context.visits[active] || !isJsonObject(p.values)) malformed('invalid pending activation');
        for (const id of Object.keys(p.values)) if (lowered.dags[active].nodes[id]?.checkpoint !== true) malformed('undeclared checkpoint node');
        if (canonicalizeJson(p.input) !== canonicalizeJson(inputs.get(active)(scopeForSaved(saved)) ?? null))
          malformed('pending work input disagrees with its control context');
        if (p.identity !== undefined) {
          const expected = { revision: revisions.dags[active], document: canonicalizeJson(lowered.dags[active]),
            input: canonicalizeJson(p.input), taskVersions: dags.get(active).taskVersions };
          if (canonicalizeJson(p.identity) !== canonicalizeJson(expected))
            throw new FlowRuntimeError('JF2013', 'pending DAG provenance changed');
        }
        else if (Object.keys(p.values).length || Object.hasOwn(p, 'result')) malformed('pending values require DAG provenance');
      }
    }
    function scopeForSaved(saved) {
      const state = saved.control.active[0];
      const visit = saved.context.visits[state];
      return { state: saved.control.active, event: null, payload: null,
        context: { ...saved.context, activation: { runId, state, visit,
          key: canonicalizeJson([runId, state, visit]) } } };
    }
    try {
      ensureLive();
      const originalInput = clone(input ?? null);
      let saved;
      try { saved = store ? await wait(store.load(runId)) : opts.snapshot; }
      catch (err) {
        if (controller.signal.aborted) throw err;
        throw new FlowRuntimeError('JF2009', 'workflow store load failed', '', asError(err));
      }
      if (saved != null) {
        saved = clone(saved);
        validate(saved, originalInput);
        snapshot = saved;
      }
      else {
        const context = { input: originalInput, data: originalInput, event: null, results: {}, visits: {} };
        const start = chart.start({ now: opts.now ?? 0, context });
        snapshot = { format: 'jaren-workflow-run/0.1', runId, identity, generation: 0,
          control: start.state, context, pending: null, status: start.final ? 'done' : 'running' };
        admit(snapshot, start.entered);
      }
      if (opts.expectedGeneration !== undefined && opts.expectedGeneration !== snapshot.generation)
        throw new FlowRuntimeError('JF2014', 'event or resume observed a stale generation');
      if (opts.now !== undefined) {
        if (!Number.isFinite(opts.now) || opts.now < snapshot.control.time)
          throw new FlowRuntimeError('JF2011', 'workflow time must be finite and cannot move backwards');
        // A resumed computation starts at the supplied wake-up time. Waiting
        // control instead processes its saved deadlines at their logical time.
        if (snapshot.status !== 'done' && lowered.specs[snapshot.control.active[0]].kind !== 'on')
          snapshot.control = chart.step(snapshot.control, '@workflow/clock', { now: opts.now, context: snapshot.context }).state;
      }
      // Claim this generation before launching work. A competing process or
      // a late write from a crashed activation can win only one CAS.
      await persist();
      let event = opts.event;
      while (snapshot.status !== 'done') {
        ensureLive();
        const id = snapshot.control.active[0];
        const spec = lowered.specs[id];
        if (spec.kind === 'work') {
          if (snapshot.pending === null) {
            let workInput;
            try { workInput = clone(inputs.get(id)(scope()) ?? null); }
            catch (err) { throw new FlowRuntimeError('JF2016', 'work input evaluation failed', `${id}/input`, asError(err)); }
            await persist((next) => { next.pending = { state: id, visit: next.context.visits[id], input: workInput, values: {} }; });
          }
          const pending = snapshot.pending;
          const key = canonicalizeJson([runId, id, pending.visit]);
          const bound = () => {
            ensureLive();
            if (snapshot.pending?.state !== id || snapshot.pending?.visit !== pending.visit)
              throw new FlowRuntimeError('JF2014', 'stale DAG activation');
          };
          routes.set(key, {
            async load(dagIdentity) {
              bound();
              if (snapshot.pending.identity === undefined)
                await persist((next) => { next.pending.identity = dagIdentity; });
              return { identity: snapshot.pending.identity, values: clone(snapshot.pending.values) };
            },
            save(node, value) { bound(); return persist((next) => { setObjectMember(next.pending.values, node, value); }); },
            complete(result) { bound(); return persist((next) => { next.pending.result = result; }); },
          });
          let result;
          let error = null;
          try {
            if (Object.hasOwn(pending, 'result')) result = pending.result;
            else {
              const task = dags.get(id).run(clone(pending.input), { runId: key, signal: controller.signal,
                resources: opts.resources,
                onNode: (record) => observe({ type: 'node', state: id, activation: pending.visit, ...record }) });
              // A private resource lease outlives every worker that received it.
              result = opts.resources === undefined ? await wait(task) : await task;
            }
          }
          catch (err) {
            if (spec.catch === undefined || err?.code !== 'JF2006') throw err;
            error = { code: err.code, message: err.message, nodeId: err.nodeId ?? null };
          }
          finally { routes.delete(key); }
          const data = clone(error ? { error } : result);
          const context = { ...snapshot.context, data };
          await apply(step(error ? ERROR : DONE, null, context), (next) => {
            next.context.data = data;
            setObjectMember(next.context.results, id, data);
            next.pending = null;
          });
        }
        else if (spec.kind === 'choose') {
          const r = step(NEXT);
          if (!r.changed) malformed('choice did not select a transition');
          await apply(r);
        }
        else if (spec.kind === 'on') {
          if (opts.now !== undefined) {
            const r = chart.advance(snapshot.control, opts.now, { context: snapshot.context, one: true });
            await apply(r);
            if (r.changed) continue;
          }
          if (event) {
            const incoming = event; event = undefined;
            const r = step(`event:${incoming.type}`, incoming.payload ?? null);
            await apply(r, (next) => { if (r.changed) next.context.event = clone(incoming); });
            if (r.changed) continue;
          }
          await persist((next) => { next.status = 'waiting'; });
          break;
        }
        else malformed(`unexpected active workflow state '${id}'`);
      }
      observe({ type: snapshot.status, active: snapshot.control.active, generation: snapshot.generation });
      return deepFreeze({ status: snapshot.status, result: snapshot.status === 'done' ? snapshot.context.data : null,
        snapshot: clone(snapshot) });
    }
    finally {
      live = false;
      controller.abort();
      opts.signal?.removeEventListener('abort', abort);
      running.delete(runId);
    }
  }
  return Object.freeze({ lowered, revisions, taskVersions: versions, run });
}
