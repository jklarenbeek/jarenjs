//@ts-check
/**
 * @file Value marks — the two things every value-carrying mark carries.
 *
 * 1. A `<title>` child holding the mark's hover text. Native SSR-safe
 *    hover: it works in a static `toSvgString()` document with no
 *    script, no CSS and no app, which is why it is unconditional.
 * 2. Opt-in pointer **bindings** (`on`, VIEW-FORMAT §4) for a host that
 *    wants a positioned floating tooltip instead. Bindings are plain
 *    JSON built at render time, so the engine stays pure — it names an
 *    action, it never calls one — and `renderToString` drops `on`
 *    entirely, so the SSR bytes are the same either way.
 *
 * The binding's `with` payload is the mark descriptor: its `text` (the
 * same string the `<title>` carries, so a host needs nothing else to
 * draw a box) plus whatever identifies the mark for a richer host.
 */

/**
 * @typedef {object} ChartTooltipSpec
 * @property {string} action action dispatched when the pointer enters a mark
 * @property {string} [leaveAction] action dispatched when it leaves
 * @property {string} [enter] enter event name (default `'pointerenter'`)
 * @property {string} [leave] leave event name (default `'pointerleave'`)
 * @property {string[]} [event] `$event` fields to request (default
 *  `['clientX', 'clientY']` — what a floating box needs to position itself)
 */
/**
 * @typedef {object} ChartTooltip resolved spec
 * @property {string} action
 * @property {string|null} leaveAction
 * @property {string} enter @property {string} leave
 * @property {string[]} event
 */

/** The pointer coordinates a floating tooltip positions itself from. */
const POINTER_FIELDS = ['clientX', 'clientY'];

/**
 * Resolve a tooltip spec. Anything that does not name an action
 * resolves to `null` — bindings off, `<title>` hover only — so a
 * hostile or half-written spec degrades to the static rendering rather
 * than emitting a binding no action answers.
 * @param {ChartTooltipSpec|null|undefined|any} spec
 * @returns {ChartTooltip|null}
 */
export function normalizeTooltip(spec) {
  if (spec === null || typeof spec !== 'object') return null;
  if (typeof spec.action !== 'string' || spec.action === '') return null;
  const name = (v, fallback) => typeof v === 'string' && v !== '' ? v : fallback;
  return {
    action: spec.action,
    leaveAction: name(spec.leaveAction, null),
    enter: name(spec.enter, 'pointerenter'),
    leave: name(spec.leave, 'pointerleave'),
    event: Array.isArray(spec.event)
      ? spec.event.filter((f) => typeof f === 'string')
      : POINTER_FIELDS,
  };
}

/**
 * The `on` binding object for one mark, or `undefined` when tooltips
 * are off (so callers can keep passing their props object through
 * untouched — an unbound chart allocates nothing extra).
 * @param {ChartTooltip|null} tooltip
 * @param {string} text the mark's hover text
 * @param {Record<string, any>} [descriptor] extra `with` members
 * @returns {Record<string, any>|undefined}
 */
export function markBinding(tooltip, text, descriptor) {
  if (tooltip === null) return undefined;
  const on = {
    [tooltip.enter]: {
      action: tooltip.action,
      with: descriptor === undefined ? { text } : { text, ...descriptor },
      event: tooltip.event,
    },
  };
  if (tooltip.leaveAction !== null) on[tooltip.leave] = { action: tooltip.leaveAction };
  return on;
}

/**
 * Mark props with the tooltip bindings folded in — for a mark whose
 * `<title>` sits among other children (a series or candle `<g>`).
 * @param {Record<string, any>} props
 * @param {ChartTooltip|null} tooltip
 * @param {string} text
 * @param {Record<string, any>} [descriptor]
 * @returns {Record<string, any>}
 */
export function markProps(props, tooltip, text, descriptor) {
  const on = markBinding(tooltip, text, descriptor);
  return on === undefined ? props : { ...props, on };
}

/**
 * A leaf value mark: its element, its hover `<title>`, and the tooltip
 * bindings when a host asked for them.
 * @param {string} tag
 * @param {Record<string, any>} props
 * @param {ChartTooltip|null} tooltip
 * @param {string} text hover text
 * @param {Record<string, any>} [descriptor] extra `with` members
 * @returns {any} the mark vnode
 */
export function valueMark(tag, props, tooltip, text, descriptor) {
  return [tag, markProps(props, tooltip, text, descriptor), ['title', {}, text]];
}
