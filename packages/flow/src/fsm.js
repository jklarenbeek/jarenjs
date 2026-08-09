//@ts-check
/**
 * @file The jaren-fsm engine: compile a finite-state-machine document
 * (docs/FLOW-FORMAT.md §2) into a PURE step function. Everything is
 * decided once at compile time — guards and effect `with` members
 * become compiled query closures — and the running machine holds no
 * mutable state at all: `step(state, event, opts)` maps its arguments
 * to a transition result, and `createFsmSession` is the thin mutable
 * convenience over it.
 *
 * The engine never executes an effect. A fired transition RETURNS
 * resolved effect descriptors as data (exit → transition → entry); how
 * they run — as @jarenjs/app effects, or in any host loop — is the
 * caller's registry, the same boundary discipline the rest of the
 * suite keeps.
 */

import { isJsonObject } from '@jarenjs/core/object';
import { compileJsonQuery } from '@jarenjs/json/query';
import { asError, FlowCompileError, FlowRuntimeError } from './errors.js';

/**
 * A compiled effect: the registered handler name, the compiled `with`
 * query (or null) and the descriptor's docPath for runtime records.
 * @typedef {{ run: string, with: any, docPath: string }} CompiledEffect
 */

/**
 * Compile one effects list (`entry`, `exit` or a transition's
 * `effects`). Absent means none; anything else must be an array of
 * `{ run, with? }` descriptors.
 * @param {any} list
 * @param {string} docPath - JSON Pointer of the list member.
 * @returns {CompiledEffect[]}
 */
function compileEffectList(list, docPath) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    throw new FlowCompileError('JF0008',
      'an effects list must be an array of { run, with? } descriptors', docPath);
  }
  return list.map((effect, i) => {
    const path = `${docPath}/${i}`;
    if (!isJsonObject(effect) || typeof effect.run !== 'string' || effect.run === '') {
      throw new FlowCompileError('JF0008',
        'an effect descriptor must be an object with a non-empty string "run"', path);
    }
    let withQuery = null;
    if (effect.with !== undefined) {
      try {
        withQuery = compileJsonQuery(effect.with);
      }
      catch (err) {
        const cause = asError(err);
        throw new FlowCompileError('JF0009',
          `effect '${effect.run}' has a "with" that failed to compile: ${cause.message}`,
          `${path}/with`, cause);
      }
    }
    return { run: effect.run, with: withQuery, docPath: path };
  });
}

/**
 * Resolve one compiled effect against the evaluation scope. An empty
 * query result omits the `with` member; a throwing `with` fails closed —
 * the effect is omitted and the failure recorded (JF2004).
 * @param {CompiledEffect} effect
 * @param {any} scope
 * @param {any[]} out - resolved descriptors, appended to
 * @param {any[]} errors - step-result error records, appended to
 */
function resolveEffect(effect, scope, out, errors) {
  if (effect.with === null) {
    out.push({ run: effect.run });
    return;
  }
  let value;
  try {
    value = effect.with(scope);
  }
  catch (err) {
    errors.push({
      code: 'JF2004',
      docPath: `${effect.docPath}/with`,
      message: `effect '${effect.run}' was omitted: its "with" threw while evaluating: ${asError(err).message}`,
    });
    return;
  }
  out.push(value === undefined ? { run: effect.run } : { run: effect.run, with: value });
}

/**
 * The result of one pure step.
 * @typedef {Object} FsmStepResult
 * @property {boolean} changed - A transition fired. A self-transition
 *   reports true with an unchanged `state`; inspect `state` to tell the
 *   two apart.
 * @property {string} state - The resulting state id.
 * @property {any[]} effects - Resolved `{ run, with? }` descriptors in
 *   firing order: exit → transition → entry (exit/entry only when the
 *   state actually changed).
 * @property {boolean} final - Whether the resulting state is final.
 * @property {{ code: string, docPath: string, message: string }[]} errors -
 *   Fail-closed evaluation records (JF2003/JF2004); empty on a clean step.
 */

/**
 * A compiled jaren-fsm machine.
 * @typedef {Object} CompiledFsm
 * @property {string|null} initial - The document's initial state id.
 * @property {readonly string[]} states - Declared state ids, document order.
 * @property {(state: string) => readonly string[]} events - The unique
 *   named events leaving a state (wildcards excluded), document order.
 * @property {(state: string) => boolean} final - Whether a state is final.
 * @property {(state: string, event: string, opts?: { payload?: any, context?: any }) => FsmStepResult} step -
 *   The pure step function.
 */

/**
 * Compile a jaren-fsm document (docs/FLOW-FORMAT.md) into a pure
 * machine. Every guard and effect `with` member compiles once, here;
 * `step` only runs specialized closures.
 *
 * The document contract is a strict superset of the mermaid
 * `jaren-workflow` projection shape: `$fsm` is optional, a plain-string
 * guard is a query (a `$`-path expression — any other non-empty string
 * is a literal and therefore always true), and `guard: null` /
 * `event: null` mean no guard / any event.
 *
 * @param {any} doc - the jaren-fsm document
 * @returns {CompiledFsm}
 * @throws {FlowCompileError} when the document violates the format (JF0xxx)
 * @example
 * const fsm = compileFsm({
 *   initial: 'idle',
 *   states: ['idle', 'busy'],
 *   transitions: [{ from: 'idle', event: 'start', to: 'busy' }],
 * });
 * fsm.step('idle', 'start').state; // 'busy'
 */
export function compileFsm(doc) {
  if (!isJsonObject(doc)) {
    throw new FlowCompileError('JF0001', 'the fsm document must be an object', '');
  }
  if (doc.$fsm !== undefined && doc.$fsm !== '0.1') {
    throw new FlowCompileError('JF0001',
      `unknown fsm format version ${JSON.stringify(doc.$fsm)} (this engine speaks '0.1')`,
      '/$fsm');
  }

  // states: string shorthand or { id, entry?, exit?, final? }
  if (!Array.isArray(doc.states)) {
    throw new FlowCompileError('JF0002',
      'the "states" member must be an array of state declarations', '/states');
  }
  /** @type {Map<string, { entry: CompiledEffect[], exit: CompiledEffect[], final: boolean }>} */
  const stateMap = new Map();
  /** @type {string[]} */
  const stateOrder = [];
  for (let i = 0; i < doc.states.length; i++) {
    const entry = doc.states[i];
    const base = `/states/${i}`;
    let id;
    let meta = { entry: /** @type {CompiledEffect[]} */ ([]), exit: /** @type {CompiledEffect[]} */ ([]), final: false };
    if (typeof entry === 'string') {
      id = entry;
    }
    else if (isJsonObject(entry) && typeof entry.id === 'string') {
      id = entry.id;
      if (entry.final !== undefined && typeof entry.final !== 'boolean') {
        throw new FlowCompileError('JF0002',
          `state '${id}' has a non-boolean "final"`, `${base}/final`);
      }
      meta = {
        entry: compileEffectList(entry.entry, `${base}/entry`),
        exit: compileEffectList(entry.exit, `${base}/exit`),
        final: entry.final === true,
      };
    }
    else {
      throw new FlowCompileError('JF0002',
        `state ${i} must be a string id or an object with a string "id"`, base);
    }
    if (stateMap.has(id)) {
      throw new FlowCompileError('JF0003',
        `duplicate state id '${id}'`, base);
    }
    stateMap.set(id, meta);
    stateOrder.push(id);
  }

  // initial: null, or a declared state id
  const initial = doc.initial;
  if (initial !== null && typeof initial !== 'string') {
    throw new FlowCompileError('JF0004',
      'the "initial" member must be a state id or null', '/initial');
  }
  if (initial !== null && !stateMap.has(initial)) {
    throw new FlowCompileError('JF0004',
      `the initial state '${initial}' is not declared in "states"`, '/initial');
  }

  // transitions: document order is the selection order (§4)
  if (!Array.isArray(doc.transitions)) {
    throw new FlowCompileError('JF0005',
      'the "transitions" member must be an array of transition entries', '/transitions');
  }
  /** @type {Map<string, any[]>} */
  const byFrom = new Map();
  for (let i = 0; i < doc.transitions.length; i++) {
    const t = doc.transitions[i];
    const base = `/transitions/${i}`;
    if (!isJsonObject(t)) {
      throw new FlowCompileError('JF0005',
        `transition ${i} must be an object`, base);
    }
    if (typeof t.from !== 'string') {
      throw new FlowCompileError('JF0005',
        `transition ${i} must carry a string "from"`, `${base}/from`);
    }
    if (typeof t.to !== 'string') {
      throw new FlowCompileError('JF0005',
        `transition ${i} must carry a string "to"`, `${base}/to`);
    }
    if (t.event !== undefined && t.event !== null && typeof t.event !== 'string') {
      throw new FlowCompileError('JF0005',
        `transition ${i} has an "event" that is neither a string nor null`, `${base}/event`);
    }
    if (!stateMap.has(t.from)) {
      throw new FlowCompileError('JF0006',
        `transition ${i} leaves the undeclared state '${t.from}'`, `${base}/from`);
    }
    if (!stateMap.has(t.to)) {
      throw new FlowCompileError('JF0006',
        `transition ${i} enters the undeclared state '${t.to}'`, `${base}/to`);
    }
    let guard = null;
    if (t.guard !== undefined && t.guard !== null) {
      try {
        guard = compileJsonQuery(t.guard);
      }
      catch (err) {
        const cause = asError(err);
        throw new FlowCompileError('JF0007',
          `transition ${i} has a guard that failed to compile: ${cause.message}`,
          `${base}/guard`, cause);
      }
    }
    const compiled = {
      event: t.event === undefined || t.event === null ? null : t.event,
      to: t.to,
      guard,
      guardPath: `${base}/guard`,
      effects: compileEffectList(t.effects, `${base}/effects`),
    };
    const list = byFrom.get(t.from);
    if (list === undefined) byFrom.set(t.from, [compiled]);
    else list.push(compiled);
  }

  // per-state introspection: unique named events, document order
  /** @type {Map<string, readonly string[]>} */
  const eventsByState = new Map();
  for (const id of stateOrder) {
    const names = [];
    for (const t of byFrom.get(id) ?? []) {
      if (t.event !== null && !names.includes(t.event)) names.push(t.event);
    }
    eventsByState.set(id, Object.freeze(names));
  }

  /**
   * @param {string} state
   * @param {string} member
   */
  function assertKnown(state, member) {
    if (!stateMap.has(state)) {
      throw new FlowRuntimeError('JF2001',
        `${member} was called with the undeclared state ${JSON.stringify(state)}`);
    }
  }

  /** @type {CompiledFsm['step']} */
  function step(state, event, opts) {
    assertKnown(state, 'step');
    if (typeof event !== 'string') {
      throw new FlowRuntimeError('JF2002',
        `step was called with a non-string event (${typeof event})`);
    }
    const scope = {
      state,
      event,
      payload: opts?.payload ?? null,
      context: opts?.context ?? null,
    };
    /** @type {FsmStepResult['errors']} */
    const errors = [];
    for (const t of byFrom.get(state) ?? []) {
      if (t.event !== null && t.event !== event) continue;
      if (t.guard !== null) {
        let pass = false;
        try {
          pass = t.guard.ebv(scope);
        }
        catch (err) {
          errors.push({
            code: 'JF2003',
            docPath: t.guardPath,
            message: `the guard threw while evaluating and reads false: ${asError(err).message}`,
          });
        }
        if (!pass) continue;
      }
      const effects = [];
      const moved = state !== t.to;
      if (moved) {
        for (const e of /** @type {any} */ (stateMap.get(state)).exit) {
          resolveEffect(e, scope, effects, errors);
        }
      }
      for (const e of t.effects) resolveEffect(e, scope, effects, errors);
      if (moved) {
        for (const e of /** @type {any} */ (stateMap.get(t.to)).entry) {
          resolveEffect(e, scope, effects, errors);
        }
      }
      return {
        changed: true,
        state: t.to,
        effects,
        final: /** @type {any} */ (stateMap.get(t.to)).final,
        errors,
      };
    }
    return {
      changed: false,
      state,
      effects: [],
      final: /** @type {any} */ (stateMap.get(state)).final,
      errors,
    };
  }

  return Object.freeze({
    initial: initial ?? null,
    states: Object.freeze(stateOrder.slice()),
    /** @type {CompiledFsm['events']} */
    events(state) {
      assertKnown(state, 'events');
      return /** @type {readonly string[]} */ (eventsByState.get(state));
    },
    /** @type {CompiledFsm['final']} */
    final(state) {
      assertKnown(state, 'final');
      return /** @type {any} */ (stateMap.get(state)).final;
    },
    step,
  });
}

/**
 * The thin mutable convenience over a compiled machine: it holds the
 * current state and forwards to the pure `step`. Because `step` is
 * pure, `can` IS a dry run — it evaluates guards but changes nothing.
 * @param {CompiledFsm} fsm - a machine from {@link compileFsm}
 * @param {string} [startState] - defaults to the document's `initial`
 * @returns {{ readonly state: string, readonly done: boolean,
 *   send: (event: string, opts?: { payload?: any, context?: any }) => FsmStepResult,
 *   can: (event: string, opts?: { payload?: any, context?: any }) => boolean }}
 * @throws {FlowRuntimeError} JF2005 when neither a start state nor a
 *   document `initial` exists; JF2001 when the start state is undeclared.
 */
export function createFsmSession(fsm, startState) {
  let current = startState ?? fsm.initial;
  if (current === null || current === undefined) {
    throw new FlowRuntimeError('JF2005',
      'the session has no start state: the document\'s "initial" is null and none was given');
  }
  if (!fsm.states.includes(current)) {
    throw new FlowRuntimeError('JF2001',
      `the session start state ${JSON.stringify(current)} is not declared`);
  }
  return {
    get state() { return /** @type {string} */ (current); },
    get done() { return fsm.final(/** @type {string} */ (current)); },
    send(event, opts) {
      const result = fsm.step(/** @type {string} */ (current), event, opts);
      current = result.state;
      return result;
    },
    can(event, opts) {
      return fsm.step(/** @type {string} */ (current), event, opts).changed;
    },
  };
}
