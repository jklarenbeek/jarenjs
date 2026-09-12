//@ts-check
import { isJsonValue } from '@jarenjs/core/object';

/** @typedef {{key:string, revision:string|number}} DragSource */
/** @typedef {{container:string, key:string, column:string}} DragTarget */
/** @typedef {{source:DragSource, target:DragTarget, mode:'move'|'copy'}} DragIntent */
/** @typedef {{phase:'idle'|'armed'|'dragging'|'validating'|'committing'|'settled'|'cancelled'|'disposed',
 * source:DragSource|null, target:DragTarget|null, mode:'move'|'copy', input:'pointer'|'touch'|'keyboard'|null,
 * point:{x:number,y:number}|null, reason:string|null, generation:number, pending:boolean}} DragState */
/** @typedef {{resolveSource:(key:string)=>DragSource|null|undefined,
 * validTarget:(target:DragTarget)=>boolean,
 * validate?:(intent:DragIntent, context:{signal:AbortSignal})=>boolean|Promise<boolean>,
 * commit:(intent:DragIntent, context:{signal:AbortSignal})=>unknown|Promise<unknown>,
 * onChange?:(state:DragState)=>void, activationDistance?:number}} DragOptions */

/** Stable intent and one pending authority call; this engine never moves source data.
 * @param {DragOptions} options */
export function createDragInteraction(options) {
  const distance = options.activationDistance ?? 6;
  if (!Number.isFinite(distance) || distance < 0) throw new RangeError('Invalid drag activation distance');
  let generation = 0, pending = false, disposed = false, abort = null;
  /** @type {Omit<DragState,'generation'|'pending'>} */
  let value = { phase: 'idle', source: null, target: null, mode: 'move', input: null, point: null, reason: null };
  let origin = null;
  /** @returns {DragState} */
  const state = () => structuredClone({ ...value, generation, pending });
  const publish = () => { options.onChange?.(state()); return state(); };
  const sameSource = () => {
    const current = value.source && options.resolveSource(value.source.key);
    return !!current && current.key === value.source.key && current.revision === value.source.revision;
  };
  const cancel = (reason = 'cancelled') => {
    if (disposed || ['idle', 'cancelled', 'settled'].includes(value.phase)) return state();
    generation++; abort?.abort();
    value = { ...value, phase: 'cancelled', target: null, reason };
    return publish();
  };
  const revalidate = () => {
    if (!['armed', 'dragging', 'validating', 'committing'].includes(value.phase)) return state();
    if (!sameSource()) return cancel('source-changed');
    if (value.target && !options.validTarget(value.target)) return cancel('target-unavailable');
    return state();
  };
  const pointOf = (point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new TypeError('Drag coordinates must be finite');
    return { x: point.x, y: point.y };
  };
  return {
    state, cancel, revalidate,
    /** @param {string} key @param {{input?:'pointer'|'touch'|'keyboard', point?:{x:number,y:number}, copy?:boolean}} [request] */
    begin(key, request = {}) {
      if (disposed || pending || ['armed', 'dragging'].includes(value.phase)) return { phase: 'refused', reason: disposed ? 'disposed' : 'busy' };
      const source = options.resolveSource(key);
      if (!source || source.key !== key || typeof key !== 'string'
        || !['string', 'number'].includes(typeof source.revision) || !isJsonValue(source.revision))
        return { phase: 'refused', reason: 'source-unavailable' };
      const input = request.input ?? 'pointer';
      if (!['pointer', 'touch', 'keyboard'].includes(input)) throw new TypeError('Unknown drag input');
      origin = pointOf(request.point ?? { x: 0, y: 0 });
      abort = new AbortController(); generation++;
      value = { phase: input === 'keyboard' ? 'dragging' : 'armed', source: { key, revision: source.revision },
        target: null, mode: request.copy ? 'copy' : 'move', input, point: origin, reason: null };
      return publish();
    },
    /** @param {{x:number,y:number}} point @param {DragTarget|null} target @param {boolean} [copy] */
    move(point, target, copy = value.mode === 'copy') {
      if (!['armed', 'dragging'].includes(revalidate().phase)) return state();
      point = pointOf(point);
      if (target && (typeof target.container !== 'string' || typeof target.key !== 'string' || typeof target.column !== 'string'))
        throw new TypeError('Drop targets require stable string identities');
      if (target && !options.validTarget(target)) return cancel('target-unavailable');
      value = { ...value, point, target: target ? { container: target.container, key: target.key, column: target.column } : null,
        mode: copy ? 'copy' : 'move', phase: value.phase === 'dragging'
          || Math.hypot(point.x - origin.x, point.y - origin.y) >= distance ? 'dragging' : 'armed' };
      return publish();
    },
    async drop() {
      if (pending) return state();
      if (revalidate().phase !== 'dragging' || !value.target) return cancel('no-target');
      const token = generation;
      const intent = /** @type {DragIntent} */ (structuredClone({ source: value.source, target: value.target, mode: value.mode }));
      pending = true; value = { ...value, phase: 'validating' };
      try {
        publish();
        const permitted = await (options.validate?.(intent, { signal: abort.signal }) ?? true);
        if (generation !== token || disposed) return state();
        if (!permitted) return cancel('permission-rejected');
        if (revalidate().phase !== 'validating') return state();
        value = { ...value, phase: 'committing' }; publish();
        const result = await options.commit(intent, { signal: abort.signal });
        if (generation !== token || disposed) return state();
        if (result === false) return cancel('command-rejected');
        value = { ...value, phase: 'settled', reason: null }; return publish();
      }
      catch (error) {
        if (generation === token && !disposed) cancel('command-rejected');
        return { ...state(), error };
      }
      finally { pending = false; if (!disposed) publish(); }
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation++; abort?.abort();
      value = { ...value, phase: 'disposed', source: null, target: null, point: null }; publish();
    },
  };
}
