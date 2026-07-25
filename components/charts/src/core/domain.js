//@ts-check
/**
 * @file Domain-stability policies for the streaming chart types. A
 * unit-space AST stores every position as a fraction of its domain, so
 * a tick that moves the domain legitimately changes every mark — a
 * wholesale re-render is then correct. These policies exist so that
 * most streaming ticks do NOT move the domain, which is what makes
 * incremental re-render (the chart session) possible:
 *
 * - `x: { window, slide? }` — sliding x window of fixed span `window`,
 *   whose END is quantized to multiples of `slide` (default a quarter
 *   window). The domain therefore moves once per `slide` of x
 *   progress, not once per sample; samples older than the window are
 *   dropped from the plot.
 * - `y: { min?, max? }` — pinned value bounds; samples beyond them
 *   clamp to the plot edge (the render's clamp01 already does this).
 * - `y: 'step'` — hysteresis by quantization: the value domain snaps
 *   outward to nice-number multiples (decades under a log axis), so it
 *   changes only when a sample crosses a step boundary.
 *
 * All resolution is pure — policies are declared in the config and
 * resolved from the data extremes on every build; stability comes from
 * quantization, not hidden state.
 */

import { niceStep } from './axis.js';

/**
 * @typedef {object} DomainPolicy
 * @property {number|null} window sliding x span (null = none)
 * @property {number|null} slide window end quantum (null = window/4)
 * @property {{min: number|null, max: number|null}|null} pin pinned y bounds
 * @property {boolean} step quantized y domain
 */

/**
 * Normalize a config `domain` member into a policy object; hostile or
 * absent input yields the all-null policy (today's behavior).
 * @param {any} domain the config `domain` member
 * @returns {DomainPolicy}
 */
export function normalizeDomainPolicy(domain) {
  const none = { window: null, slide: null, pin: null, step: false };
  if (domain === null || typeof domain !== 'object') return none;
  const policy = { ...none };
  const x = domain.x;
  if (x !== null && typeof x === 'object'
    && typeof x.window === 'number' && Number.isFinite(x.window) && x.window > 0) {
    policy.window = x.window;
    if (typeof x.slide === 'number' && Number.isFinite(x.slide) && x.slide > 0)
      policy.slide = x.slide;
  }
  const y = domain.y;
  if (y === 'step') {
    policy.step = true;
  }
  else if (y !== null && typeof y === 'object') {
    const min = typeof y.min === 'number' && Number.isFinite(y.min) ? y.min : null;
    const max = typeof y.max === 'number' && Number.isFinite(y.max) ? y.max : null;
    if (min !== null || max !== null) policy.pin = { min, max };
  }
  return policy;
}

/**
 * Resolve the windowed x domain `[end - window, end]`: the end is the
 * smallest multiple of the slide quantum at or above the newest sample,
 * so it moves once per quantum, not once per sample.
 * @param {number} xMax newest x in the data (non-finite = empty data)
 * @param {number} window the window span (> 0)
 * @param {number|null} slide the end quantum (null = window / 4)
 * @returns {[number, number]}
 */
export function resolveWindowX(xMax, window, slide) {
  const quantum = slide ?? window / 4;
  const end = Number.isFinite(xMax) ? quantum * Math.ceil(xMax / quantum) : window;
  return [end - window, end];
}

/**
 * Resolve the quantized (`'step'`) y domain: extremes snapped outward
 * to multiples of a nice step of the span, so small new extremes
 * usually land inside the current domain.
 * @param {number} yMin @param {number} yMax data extremes (finite)
 * @returns {[number, number]}
 */
export function resolveStepY(yMin, yMax) {
  const span = yMax - yMin;
  const step = niceStep(span > 0 ? span : Math.abs(yMax) || 1, 4);
  let lo = step * Math.floor(yMin / step);
  let hi = step * Math.ceil(yMax / step);
  if (hi === lo) hi = lo + step;
  return [lo, hi];
}

/**
 * Resolve the quantized y domain under a log axis: decade bounds
 * (`10^floor` / `10^ceil`), the log counterpart of {@link resolveStepY}.
 * @param {number} yMin @param {number} yMax data extremes (> 0)
 * @returns {[number, number]}
 */
export function resolveStepYLog(yMin, yMax) {
  const lo = Math.pow(10, Math.floor(Math.log10(yMin)));
  let hi = Math.pow(10, Math.ceil(Math.log10(yMax)));
  if (hi === lo) hi = lo * 10;
  return [lo, hi];
}

/**
 * Resolve pinned y bounds over the data extremes. Under a log axis a
 * non-positive pin is ignored (a hostile pin never breaks the scale);
 * a pin pair that closes the domain falls back to the data extremes.
 * @param {number} yMin @param {number} yMax data extremes
 * @param {{min: number|null, max: number|null}} pin
 * @param {boolean} log
 * @returns {[number, number]}
 */
export function resolvePinnedY(yMin, yMax, pin, log) {
  let lo = pin.min !== null && (!log || pin.min > 0) ? pin.min : yMin;
  let hi = pin.max !== null && (!log || pin.max > 0) ? pin.max : yMax;
  if (hi <= lo) { lo = yMin; hi = yMax; }
  return [lo, hi];
}
