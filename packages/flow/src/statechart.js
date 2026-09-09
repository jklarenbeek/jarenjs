//@ts-check
/** Pure, explicit-time statecharts. See docs/STATECHART-FORMAT.md. */
import { deepFreeze, isJsonObject } from '@jarenjs/core/object';
import { compileJsonQuery } from '@jarenjs/json/query';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { compileEffectList, resolveEffect } from './fsm.js';
import { asError, FlowCompileError, FlowRuntimeError } from './errors.js';

/** @typedef {Readonly<{ active: readonly string[], history: Readonly<Record<string, readonly string[]>>,
 * timers: readonly Readonly<{ transition: number, at: number, token: number }>[], serial: number, time: number }>} StatechartState */
/** @typedef {{ now?: number, payload?: any, context?: any, one?: boolean }} StatechartOptions */
/** @typedef {{ changed: boolean, state: StatechartState, final: boolean,
 * effects: any[], errors: {code: string, docPath: string, message: string}[],
 * entered: string[], exited: string[], transitions: number[] }} StatechartResult */
/** @typedef {Object} CompiledStatechart
 * @property {readonly string[]} states
 * @property {(opts?: StatechartOptions) => StatechartResult} start
 * @property {(state: StatechartState, event: string, opts?: StatechartOptions) => StatechartResult} step
 * @property {(state: StatechartState, now: number, opts?: StatechartOptions) => StatechartResult} advance
 * @property {(state: StatechartState) => boolean} final
 * @property {(state: StatechartState) => readonly string[]} events
 * @property {(state: StatechartState) => StatechartState} restore
 */

const defect = (reason, path) => { throw new FlowCompileError('JF0020', reason, path); };
const invalid = (reason) => { throw new FlowRuntimeError('JF2010', reason); };
const finiteTime = (value) => typeof value === 'number' && Number.isFinite(value);

/** Compile jaren-fsm 0.2 without creating a clock, timer or effect handler.
 * @param {any} doc
 * @param {{ maxMicrosteps?: number }} [options]
 * @returns {CompiledStatechart}
 */
export function compileStatechart(doc, options = {}) {
  const maxMicrosteps = options.maxMicrosteps ?? 1000;
  if (!Number.isSafeInteger(maxMicrosteps) || maxMicrosteps < 1)
    throw new TypeError('maxMicrosteps must be a positive safe integer');
  if (!isJsonObject(doc) || doc.$fsm !== '0.2')
    defect('a statechart requires "$fsm": "0.2"', '/$fsm');
  for (const key of Object.keys(doc)) if (!['$fsm', 'initial', 'states', 'transitions'].includes(key))
    defect('unknown statechart member', `/${key}`);
  if (!Array.isArray(doc.states) || doc.states.length === 0)
    defect('states must be a non-empty array', '/states');
  const nodes = new Map();
  const roots = [];
  for (const [index, decl] of doc.states.entries()) {
    const s = typeof decl === 'string' ? { id: decl } : decl;
    const path = `/states/${index}`;
    if (!isJsonObject(s) || typeof s.id !== 'string' || !s.id)
      defect('a state needs a non-empty string id', path);
    for (const key of Object.keys(s)) if (!['id', 'parent', 'initial', 'type', 'history', 'final', 'entry', 'exit'].includes(key))
      defect('unknown state member', `${path}/${key}`);
    if (nodes.has(s.id)) defect(`duplicate state '${s.id}'`, path);
    if (s.parent !== undefined && (typeof s.parent !== 'string' || !s.parent))
      defect('parent must be a state id', `${path}/parent`);
    if (s.initial !== undefined && typeof s.initial !== 'string')
      defect('initial must be a state id', `${path}/initial`);
    if (s.type !== undefined && !['atomic', 'compound', 'parallel', 'final', 'history'].includes(s.type))
      defect('unknown state type', `${path}/type`);
    if (s.history !== undefined && !['shallow', 'deep'].includes(s.history))
      defect('history must be shallow or deep', `${path}/history`);
    if (s.final !== undefined && typeof s.final !== 'boolean')
      defect('final must be boolean', `${path}/final`);
    const type = s.type ?? (s.history ? 'history' : s.final ? 'final' : null);
    if ((s.final === true && type !== 'final') || (s.history && type !== 'history'))
      defect('conflicting state types', path);
    nodes.set(s.id, { ...s, type, parent: s.parent ?? null, path, index, children: [],
      entry: compileEffectList(s.entry, `${path}/entry`),
      exit: compileEffectList(s.exit, `${path}/exit`) });
  }
  for (const s of nodes.values()) {
    if (s.parent === null) roots.push(s.id);
    else {
      if (!nodes.has(s.parent)) defect('parent is undeclared', `${s.path}/parent`);
      nodes.get(s.parent).children.push(s.id);
    }
    const seen = new Set([s.id]);
    let parent = s.parent;
    while (parent !== null && nodes.has(parent)) {
      if (seen.has(parent)) defect('state hierarchy has a cycle', `${s.path}/parent`);
      seen.add(parent); parent = nodes.get(parent).parent;
    }
  }
  const children = (id) => nodes.get(id).children.filter((child) => nodes.get(child).type !== 'history');
  for (const s of nodes.values()) {
    const ordinary = children(s.id);
    s.type ??= ordinary.length ? 'compound' : 'atomic';
    if (['atomic', 'final', 'history'].includes(s.type) && s.children.length)
      defect(`${s.type} states cannot have children`, s.path);
    if (s.type === 'compound' && (!ordinary.length || !ordinary.includes(s.initial)))
      defect('a compound state needs an initial naming an immediate ordinary child', `${s.path}/initial`);
    if (s.type === 'parallel' && !ordinary.length) defect('a parallel state needs regions', s.path);
    if (s.type !== 'compound' && s.initial !== undefined)
      defect('only compound states have initial', `${s.path}/initial`);
    if (s.type === 'history') {
      if (s.parent === null || !s.history || s.entry.length || s.exit.length)
        defect('history needs a parent and a mode, and cannot carry effects', s.path);
    }
  }
  if (typeof doc.initial !== 'string' || !roots.includes(doc.initial)
    || nodes.get(doc.initial).type === 'history')
    defect('initial must name an ordinary root state', '/initial');
  const initial = doc.initial;
  // Tree order is independent of where a flattened child was declared.
  const order = [];
  const visit = (id) => { order.push(id); for (const c of nodes.get(id).children) visit(c); };
  roots.forEach(visit);
  const rank = new Map(order.map((id, i) => [id, i]));
  const ordered = (ids) => [...ids].sort((a, b) => rank.get(a) - rank.get(b));
  const ancestors = (id) => {
    const out = [];
    for (let p = nodes.get(id).parent; p !== null; p = nodes.get(p).parent) out.push(p);
    return out;
  };
  const below = (id, parent) => parent === null || ancestors(id).includes(parent);
  const within = (id, parent) => id === parent || below(id, parent);
  const closure = (leaves) => new Set(leaves.flatMap((id) => [id, ...ancestors(id)]));

  if (!Array.isArray(doc.transitions)) defect('transitions must be an array', '/transitions');
  const byFrom = new Map(order.map((id) => [id, []]));
  const transitions = doc.transitions.map((t, index) => {
    const path = `/transitions/${index}`;
    if (!isJsonObject(t) || !nodes.has(t.from) || !nodes.has(t.to))
      defect('transition from/to must name declared states', path);
    for (const key of Object.keys(t)) if (!['from', 'to', 'event', 'after', 'done', 'always', 'type', 'guard', 'effects'].includes(key))
      defect('unknown transition member', `${path}/${key}`);
    if (['history', 'final'].includes(nodes.get(t.from).type))
      defect('history and final states cannot have outgoing transitions', `${path}/from`);
    if (t.event !== undefined && t.event !== null && typeof t.event !== 'string')
      defect('event must be a string or null', `${path}/event`);
    if (t.after !== undefined && (!finiteTime(t.after) || t.after < 0))
      defect('after must be a finite nonnegative millisecond duration', `${path}/after`);
    if (t.done !== undefined && t.done !== true) defect('done must be true when present', `${path}/done`);
    if (t.always !== undefined && t.always !== true) defect('always must be true when present', `${path}/always`);
    const triggers = ['event', 'after', 'done', 'always'].filter((key) => t[key] !== undefined);
    if (triggers.length > 1) defect('a transition has exactly one trigger', path);
    if (t.done && !['compound', 'parallel'].includes(nodes.get(t.from).type))
      defect('done requires a compound or parallel source', `${path}/done`);
    const type = t.type ?? 'external';
    if (!['internal', 'external'].includes(type)
      || (type === 'internal' && !within(t.to, t.from)))
      defect('internal transitions must target their source or a descendant', `${path}/type`);
    let guard = null;
    if (t.guard !== undefined && t.guard !== null) {
      try { guard = compileJsonQuery(t.guard); }
      catch (err) { throw new FlowCompileError('JF0007', 'statechart guard failed to compile', `${path}/guard`, asError(err)); }
    }
    // A history pseudo-state is a child of its owner. Using the owner as
    // the target here would wrongly exit it on a sibling-to-history jump,
    // overwriting the remembered configuration before it could be restored.
    const target = t.to;
    const domain = type === 'internal' ? t.from
      : ancestors(t.from).find((id) => nodes.get(id).type !== 'parallel' && below(target, id)) ?? null;
    const compiled = { ...t, type, domain, index, path, guard,
      effects: compileEffectList(t.effects, `${path}/effects`) };
    byFrom.get(t.from).push(compiled);
    return compiled;
  });

  // Add an explicit target, then fill missing initial children/regions. A
  // history target expands to ordinary targets before completing the tree.
  function targetInto(id, active, history) {
    const s = nodes.get(id);
    if (s.type === 'history') {
      const remembered = Object.hasOwn(history, id) ? history[id] : null;
      if (remembered) for (const r of remembered) targetInto(r, active, history);
      else targetInto(s.parent, active, history);
      return;
    }
    active.add(id);
    ancestors(id).forEach((p) => active.add(p));
  }
  function fill(active) {
    for (const id of order) {
      if (!active.has(id)) continue;
      const s = nodes.get(id);
      if (s.type === 'parallel') children(id).forEach((c) => active.add(c));
      else if (s.type === 'compound' && !children(id).some((c) => active.has(c))) active.add(s.initial);
    }
    return ordered([...active].filter((id) => ['atomic', 'final'].includes(nodes.get(id).type)));
  }
  function legal(leaves, root = null) {
    if (!Array.isArray(leaves) || !leaves.length || new Set(leaves).size !== leaves.length
      || leaves.some((id) => !nodes.has(id) || !['atomic', 'final'].includes(nodes.get(id).type)
        || (root !== null && !below(id, root)))) return false;
    const active = closure(leaves);
    if (root === null && roots.filter((id) => active.has(id)).length !== 1) return false;
    for (const id of active) {
      if (root !== null && !within(id, root)) continue;
      const s = nodes.get(id);
      const count = children(id).filter((c) => active.has(c)).length;
      if ((s.type === 'compound' && count !== 1)
        || (s.type === 'parallel' && count !== children(id).length)) return false;
    }
    return true;
  }
  /** @type {CompiledStatechart['restore']} */
  function restore(state) {
    if (!isJsonObject(state) || !legal(state.active) || !isJsonObject(state.history)
      || !Array.isArray(state.timers) || !Number.isSafeInteger(state.serial) || state.serial < 0
      || !finiteTime(state.time)) invalid('invalid statechart snapshot');
    const active = closure(state.active);
    for (const [id, remembered] of Object.entries(state.history)) {
      const s = nodes.get(id);
      if (!s || s.type !== 'history' || !Array.isArray(remembered) || !remembered.length
        || new Set(remembered).size !== remembered.length) invalid('invalid history record');
      if (s.history === 'deep') {
        if (!legal(remembered, s.parent)) invalid('illegal deep history configuration');
      }
      else if (remembered.some((c) => !children(s.parent).includes(c))
        || remembered.length !== (nodes.get(s.parent).type === 'parallel' ? children(s.parent).length : 1))
        invalid('illegal shallow history configuration');
    }
    const seen = new Set();
    const tokens = new Set();
    for (const timer of state.timers) {
      const t = transitions[timer?.transition];
      if (!t || t.after === undefined || !Number.isSafeInteger(timer.transition)
        || !active.has(t.from) || !finiteTime(timer.at)
        || !Number.isSafeInteger(timer.token) || timer.token <= 0 || timer.token > state.serial
        || seen.has(timer.transition) || tokens.has(timer.token)) invalid('invalid timer record');
      seen.add(timer.transition); tokens.add(timer.token);
    }
    const normalized = JSON.parse(canonicalizeJson(state));
    normalized.active = ordered(normalized.active);
    for (const id of Object.keys(normalized.history)) normalized.history[id] = ordered(normalized.history[id]);
    normalized.timers.sort((a, b) => a.at - b.at || a.transition - b.transition);
    return deepFreeze(normalized);
  }
  function complete(id, active) {
    if (!active.has(id)) return false;
    const s = nodes.get(id);
    if (s.type === 'final') return true;
    if (s.type === 'compound') return children(id).some((c) => active.has(c) && nodes.get(c).type === 'final');
    if (s.type === 'parallel') return children(id).every((c) => complete(c, active));
    return false;
  }
  const final = (state) => roots.some((id) => complete(id, closure(state.active)));
  function timeAt(state, now) {
    const at = now ?? state?.time ?? 0;
    if (!finiteTime(at) || (state && at < state.time))
      throw new FlowRuntimeError('JF2011', 'time must be finite and cannot move backwards');
    return at;
  }
  function result(state) {
    return { changed: false, state, final: final(state), effects: [], errors: [], entered: [], exited: [], transitions: [] };
  }
  function effects(list, scope, out) {
    for (const e of list) resolveEffect(e, scope, out.effects, out.errors);
  }
  function schedule(state, entered, now) {
    for (const id of entered) for (const t of byFrom.get(id)) {
      if (t.after === undefined) continue;
      const at = now + t.after;
      if (!finiteTime(at) || !Number.isSafeInteger(state.serial + 1))
        throw new FlowRuntimeError('JF2011', 'timer deadline or token exceeds its numeric range');
      state.timers.push({ transition: t.index, at, token: ++state.serial });
    }
    state.timers.sort((a, b) => a.at - b.at || a.transition - b.transition);
  }
  function scopeFor(state, event, opts) {
    return { state: state.active, event, payload: opts?.payload ?? null, context: opts?.context ?? null };
  }
  function select(state, trigger, scope, out) {
    const active = closure(state.active);
    const evaluated = new Map();
    const enabled = new Set();
    const matches = (t) => {
      if (trigger.kind === 'timer') return t.index === trigger.index;
      if (trigger.kind === 'auto') return t.always === true || (t.done === true && complete(t.from, active));
      return t.after === undefined && !t.always && !t.done && (t.event == null || t.event === trigger.event);
    };
    for (const leaf of ordered(state.active)) {
      outer: for (const id of [leaf, ...ancestors(leaf)]) {
        for (const t of byFrom.get(id)) {
          if (!matches(t)) continue;
          if (!evaluated.has(t)) {
            let pass = true;
            try { if (t.guard !== null) pass = t.guard.ebv(scope); }
            catch (err) {
              pass = false;
              out.errors.push({ code: 'JF2003', docPath: `${t.path}/guard`, message: asError(err).message });
            }
            evaluated.set(t, pass);
          }
          if (evaluated.get(t)) { enabled.add(t); break outer; }
        }
      }
    }
    const exits = (t) => new Set([...active].filter((id) => below(id, t.domain)));
    const selected = [];
    for (const t of enabled) {
      const exit = exits(t);
      const conflicts = selected.filter((other) => [...exit].some((id) => other.exit.has(id))
        || within(t.from, other.t.from) || within(other.t.from, t.from));
      if (conflicts.some((other) => !below(t.from, other.t.from))) continue;
      for (const other of conflicts) selected.splice(selected.indexOf(other), 1);
      selected.push({ t, exit });
    }
    return selected.sort((a, b) => a.t.index - b.t.index);
  }
  function microstep(state, selected, scope, out) {
    if (!selected.length) return false;
    const active = closure(state.active);
    const exiting = new Set(selected.flatMap((s) => [...s.exit]));
    for (const id of exiting) for (const h of nodes.get(id).children) {
      const history = nodes.get(h);
      if (history.type !== 'history') continue;
      Object.defineProperty(state.history, h, { value: history.history === 'deep'
        ? state.active.filter((leaf) => below(leaf, id))
        : children(id).filter((c) => active.has(c)), enumerable: true, writable: true, configurable: true });
    }
    const exited = ordered(exiting).reverse();
    for (const id of exited) { effects(nodes.get(id).exit, scope, out); active.delete(id); }
    state.timers = state.timers.filter((timer) => !exiting.has(transitions[timer.transition].from));
    for (const { t } of selected) effects(t.effects, scope, out);
    const kept = new Set(active);
    for (const { t } of selected) targetInto(t.to, active, state.history);
    state.active = fill(active);
    const entered = ordered([...active].filter((id) => !kept.has(id)));
    for (const id of entered) effects(nodes.get(id).entry, scope, out);
    schedule(state, entered, state.time);
    out.changed = true;
    out.entered.push(...entered); out.exited.push(...exited);
    out.transitions.push(...selected.map(({ t }) => t.index));
    return true;
  }
  function settle(state, scope, out, budget) {
    while (true) {
      const selected = select(state, { kind: 'auto' }, { ...scope, state: state.active }, out);
      if (!selected.length) break;
      if (++budget.count > maxMicrosteps) throw new FlowRuntimeError('JF2012', 'statechart microstep limit exceeded');
      microstep(state, selected, { ...scope, state: state.active }, out);
    }
  }
  function finish(out) { out.final = final(out.state); deepFreeze(out.state); return out; }
  return Object.freeze({
    states: Object.freeze(order), restore,
    final(state) { return final(restore(state)); },
    events(state) {
      const active = closure(restore(state).active);
      return Object.freeze([...new Set(transitions.filter((t) => active.has(t.from) && typeof t.event === 'string').map((t) => t.event))]);
    },
    start(opts) {
      const state = { active: [], history: {}, timers: [], serial: 0, time: timeAt(null, opts?.now) };
      const active = new Set();
      targetInto(initial, active, state.history);
      state.active = fill(active);
      const out = result(state);
      out.entered = ordered(active);
      const scope = scopeFor(state, null, opts);
      for (const id of out.entered) effects(nodes.get(id).entry, scope, out);
      schedule(state, out.entered, state.time);
      settle(state, scope, out, { count: 0 });
      return finish(out);
    },
    step(snapshot, event, opts) {
      if (typeof event !== 'string') throw new FlowRuntimeError('JF2002', 'event must be a string');
      const state = JSON.parse(canonicalizeJson(restore(snapshot)));
      state.time = timeAt(snapshot, opts?.now);
      const out = result(state);
      const scope = scopeFor(state, event, opts);
      microstep(state, select(state, { kind: 'event', event }, scope, out), scope, out);
      settle(state, scope, out, { count: 1 });
      return finish(out);
    },
    advance(snapshot, now, opts) {
      const until = timeAt(snapshot, now);
      const state = JSON.parse(canonicalizeJson(restore(snapshot)));
      const out = result(state);
      const budget = { count: 0 };
      while (state.timers.length && state.timers[0].at <= until) {
        if (++budget.count > maxMicrosteps) throw new FlowRuntimeError('JF2012', 'statechart microstep limit exceeded');
        const timer = state.timers.shift();
        state.time = Math.max(state.time, timer.at);
        const scope = scopeFor(state, null, opts);
        microstep(state, select(state, { kind: 'timer', index: timer.transition }, scope, out), scope, out);
        settle(state, scope, out, budget);
        if (opts?.one) break;
      }
      if (!opts?.one || budget.count === 0) state.time = until;
      return finish(out);
    },
  });
}

/** A synchronous session; callers execute returned effects and supply time.
 * @param {CompiledStatechart} chart
 * @param {{ state?: StatechartState, now?: number, context?: any,
 * store?: { load: () => StatechartState | null, save: (state: StatechartState) => void } }} [options]
 */
export function createStatechartSession(chart, options = {}) {
  const store = options.store;
  if (store && (typeof store.load !== 'function' || typeof store.save !== 'function'))
    throw new TypeError('statechart store needs synchronous load and save');
  const loaded = options.state ?? store?.load();
  const initial = loaded ? null : chart.start(options);
  let state = loaded ? chart.restore(loaded) : initial.state;
  const save = (next) => {
    const saved = store?.save(next);
    if (saved && typeof saved.then === 'function') {
      Promise.resolve(saved).catch(() => {});
      throw new TypeError('statechart session stores must be synchronous');
    }
  };
  if (initial) save(state);
  /** @param {StatechartResult} r @returns {StatechartResult} */
  const commit = (r) => { save(r.state); state = r.state; return r; };
  return Object.freeze({
    get state() { return state; },
    get done() { return chart.final(state); },
    initial,
    /** @param {string} event @param {StatechartOptions} [opts] */
    send: (event, opts) => commit(chart.step(state, event, opts)),
    /** @param {number} now @param {StatechartOptions} [opts] */
    advance: (now, opts) => commit(chart.advance(state, now, opts)),
    /** @param {string} event @param {StatechartOptions} [opts] */
    can: (event, opts) => chart.step(state, event, opts).changed,
  });
}
