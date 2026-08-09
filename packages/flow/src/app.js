//@ts-check
/**
 * @file The @jarenjs/app adapter: turn a jaren-fsm document into the
 * standard app documents that host it (docs/APP-INTEGRATION.md). This
 * is a GENERATOR, not a runtime — it emits pure JSON action documents
 * the app compiles like any hand-written action, and nothing from this
 * package runs afterwards. Selection semantics are the headless
 * engine's, reproduced structurally: one conditional chain per named
 * event, transitions in document order, `$and`'s first-false stop
 * playing the role of the step function's guard gate.
 *
 * The scope mapping (APP-INTEGRATION.md §scope): a guard or `with`
 * query authored against FLOW-FORMAT §3's `{ state, event, payload,
 * context }` is rewritten to read the reserved variable `__fsm`, bound
 * once per action to `{ state: <pointer>.current, event: <literal>,
 * payload: $payload, context: $ }` — all pre-transition, exactly like
 * the headless step scope.
 */

import { isJsonObject } from '@jarenjs/core/object';
import { compileFsm } from './fsm.js';

/**
 * Bake a string as a LITERAL expression leaf: a `$`-leading name must
 * be `$$`-escaped or the query engine reads it as a path (QUERY-FORMAT
 * §3.2).
 * @param {string} s
 * @returns {string}
 */
function lit(s) {
  return s.startsWith('$') ? `$$${s.slice(1)}` : s;
}

/** Operator members whose object value binds variable names. */
const BINDING_KEYS = ['$let', '$for', '$fold', '$every', '$some'];

/**
 * Rewrite a guard / `with` query document from the FLOW-FORMAT §3
 * scope onto the action-local `__fsm` variable: every absolute path
 * (`$`, `$.…`, `$[…`, `$..…`) re-roots on `$__fsm`; variable paths,
 * `$$`-escaped literals and plain strings pass through. The walk
 * always returns fresh nodes (the emitted document never aliases the
 * machine document) and throws when the document binds the reserved
 * name itself.
 * @param {any} node
 * @returns {any}
 */
function rewriteScope(node) {
  if (typeof node === 'string') {
    if (node === '$') return '$__fsm';
    if (node.startsWith('$.') || node.startsWith('$[')) return `$__fsm${node.slice(1)}`;
    return node;
  }
  if (Array.isArray(node)) return node.map(rewriteScope);
  if (isJsonObject(node)) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const key of Object.keys(node)) {
      if (BINDING_KEYS.includes(key) && isJsonObject(node[key])
        && Object.hasOwn(node[key], '__fsm')) {
        throw new TypeError(
          'fsmToApp reserves the variable name "__fsm" inside generated actions; '
          + 'the machine document must not bind it');
      }
      out[key] = rewriteScope(node[key]);
    }
    return out;
  }
  return node;
}

/**
 * Normalize the (already compileFsm-validated) `states` member to
 * id → { entry, exit } raw descriptor lists.
 * @param {any} doc
 * @returns {Map<string, { entry: any[], exit: any[] }>}
 */
function rawStates(doc) {
  const map = new Map();
  for (const entry of doc.states) {
    if (typeof entry === 'string') map.set(entry, { entry: [], exit: [] });
    else map.set(entry.id, { entry: entry.entry ?? [], exit: entry.exit ?? [] });
  }
  return map;
}

/**
 * Bake one effect descriptor: literal `run`, scope-rewritten `with`.
 * @param {any} effect
 * @returns {any}
 */
function bakeEffect(effect) {
  const out = { run: lit(effect.run) };
  if (effect.with !== undefined) out.with = rewriteScope(effect.with);
  return out;
}

/**
 * Generate the standard app documents that host a jaren-fsm machine:
 * a state slice, one action document per distinct named event, and the
 * event vocabulary. The output is pure JSON with the machine's target
 * states, event names and effect origins baked as literals; guards and
 * effect props run through the app's own query engine at dispatch
 * time. See docs/APP-INTEGRATION.md for the convention this implements.
 *
 * @param {any} fsmDoc - a jaren-fsm document (FLOW-FORMAT §2)
 * @param {{ pointer?: string, namespace?: string }} [options] -
 *   `pointer` (default `/fsm`) is where the slice lives in app state,
 *   as a chain of identifier-safe segments; `namespace` (default
 *   `fsm/`) prefixes the generated action names.
 * @returns {{ slice: { current: string|null }, actions: Record<string, any>, events: string[] }}
 * @throws {import('./errors.js').FlowCompileError} on a bad machine
 *   document (the same JF0xxx codes as `compileFsm`)
 * @throws {TypeError} on malformed options or a document binding the
 *   reserved `__fsm` variable name
 */
export function fsmToApp(fsmDoc, options) {
  compileFsm(fsmDoc);

  const pointer = options?.pointer ?? '/fsm';
  const namespace = options?.namespace ?? 'fsm/';
  if (typeof namespace !== 'string') {
    throw new TypeError('fsmToApp: "namespace" must be a string');
  }
  if (typeof pointer !== 'string' || !/^(\/[A-Za-z_][A-Za-z0-9_]*)+$/.test(pointer)) {
    throw new TypeError(
      'fsmToApp: "pointer" must be a chain of identifier-safe segments, like /fsm or /ui/wizard');
  }

  const currentPath = `$${pointer.replaceAll('/', '.')}.current`;
  const patchPath = `${pointer}/current`;
  const states = rawStates(fsmDoc);

  /** @type {string[]} */
  const events = [];
  for (const t of fsmDoc.transitions) {
    if (typeof t.event === 'string' && !events.includes(t.event)) events.push(t.event);
  }

  /** @type {Record<string, any>} */
  const actions = {};
  for (const event of events) {
    const branches = fsmDoc.transitions.filter(
      (t) => t.event === event || t.event === null || t.event === undefined);
    let chain;
    for (let i = branches.length - 1; i >= 0; i--) {
      const t = branches[i];
      const eq = { $eq: [currentPath, lit(t.from)] };
      const cond = t.guard === undefined || t.guard === null
        ? eq
        : { $and: [eq, rewriteScope(t.guard)] };
      const moved = t.from !== t.to;
      const meta = /** @type {{ entry: any[], exit: any[] }} */ (states.get(t.from));
      const target = /** @type {{ entry: any[], exit: any[] }} */ (states.get(t.to));
      const effects = [
        ...(moved ? meta.exit : []),
        ...(t.effects ?? []),
        ...(moved ? target.entry : []),
      ].map(bakeEffect);
      /** @type {Record<string, any>} */
      const result = {
        patch: [{ op: 'replace', path: patchPath, value: lit(t.to) }],
      };
      if (effects.length > 0) result.effects = effects;
      chain = chain === undefined
        ? { $if: [cond, result] }
        : { $if: [cond, result, chain] };
    }
    actions[namespace + event] = {
      $let: {
        __fsm: {
          state: currentPath,
          event: lit(event),
          payload: '$payload',
          context: '$',
        },
      },
      $return: chain,
    };
  }

  return { slice: { current: fsmDoc.initial }, actions, events };
}

/**
 * The state slice's JSON Schema: `current` as an enum of the machine's
 * declared state ids — compose it into a `validateState` schema at the
 * slice pointer so no hand-written action can corrupt the control
 * state (APP-INTEGRATION.md §fail-closed).
 * @param {any} fsmDoc - a jaren-fsm document
 * @returns {{ type: 'object', required: string[], properties: { current: { description: string, enum: string[] } } }}
 * @throws {import('./errors.js').FlowCompileError} on a bad machine document
 */
export function fsmStateSchema(fsmDoc) {
  const fsm = compileFsm(fsmDoc);
  return {
    type: 'object',
    required: ['current'],
    properties: {
      current: {
        description: 'The machine\'s control state: always one of the declared state ids.',
        enum: [...fsm.states],
      },
    },
  };
}
