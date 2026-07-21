//@ts-check
/**
 * @file Tick generators. Linear ticks snap to a nice-number step
 * (1/2/5 × 10^k) so an axis never shows values like `12.75`; log ticks
 * are decade powers (the shape benchmark-ratio charts need, where one
 * axis spans two orders of magnitude); ordinal ticks center on their
 * band. Tick *positions* are the caller's job via the matching scale —
 * these functions return domain values only.
 */

/**
 * The nice step (1, 2 or 5 times a power of ten) closest to covering
 * `span` in about `count` steps.
 * @param {number} span - Domain span (> 0)
 * @param {number} count - Desired tick count
 * @returns {number}
 */
export function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const power = Math.floor(Math.log10(raw));
  const base = Math.pow(10, power);
  const unit = raw / base;
  const factor = unit < 1.5 ? 1 : unit < 3 ? 2 : unit < 7 ? 5 : 10;
  return factor * base;
}

/**
 * Linear ticks: multiples of a nice step inside `[min, max]`.
 * Degenerate domains yield a single tick.
 * @param {number} min - Domain minimum
 * @param {number} max - Domain maximum
 * @param {number} [count] - Desired tick count (approximate)
 * @returns {number[]}
 */
export function axisTicksLinear(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max))
    return [];
  if (min === max)
    return [min];
  if (min > max)
    return axisTicksLinear(max, min, count);
  const step = niceStep(max - min, count);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const ticks = [];
  const first = Math.ceil(min / step);
  const last = Math.floor(max / step);
  for (let i = first; i <= last; ++i)
    ticks.push(Number((i * step).toFixed(decimals)));
  return ticks;
}

/**
 * Log ticks: the decade powers (… 0.1, 1, 10, 100 …) inside
 * `[min, max]`. When the domain sits within a single decade the
 * endpoints are returned so the axis is never empty.
 * @param {number} min - Domain minimum (> 0)
 * @param {number} max - Domain maximum (> 0)
 * @returns {number[]}
 */
export function axisTicksLog(min, max) {
  if (!(min > 0) || !(max > 0))
    throw new RangeError(`axisTicksLog domain must be positive, got [${min}, ${max}]`);
  if (min > max)
    return axisTicksLog(max, min);
  const ticks = [];
  const first = Math.ceil(Math.log10(min) - 1e-12);
  const last = Math.floor(Math.log10(max) + 1e-12);
  for (let k = first; k <= last; ++k)
    ticks.push(Math.pow(10, k));
  return ticks.length !== 0 ? ticks : [min, max];
}

/**
 * Ordinal ticks: every category, centered on its band.
 * @param {readonly string[]} categories - Domain, in display order
 * @returns {{label: string, pos: number}[]} positions in [0,1]
 */
export function axisTicksOrdinal(categories) {
  const n = categories.length;
  return categories.map((label, i) => ({ label, pos: (i + 0.5) / n }));
}

/**
 * A compact tick label: `1.5k`, `2M`, `1G` for large magnitudes,
 * 3-significant-digit decimals otherwise.
 * @param {number} v - Tick value
 * @returns {string}
 */
export function formatTickValue(v) {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e9) return trim(v / 1e9) + 'G';
  if (abs >= 1e6) return trim(v / 1e6) + 'M';
  if (abs >= 1e3) return trim(v / 1e3) + 'k';
  return trim(v);
}

/**
 * A time-axis tick label: UTC `HH:MM:SS` (deterministic across
 * machines; a day boundary shows the date instead).
 * @param {number|Date} v - Epoch milliseconds or a Date
 * @returns {string}
 */
export function formatTimeTick(v) {
  const d = typeof v === 'number' ? new Date(v) : v;
  const iso = d.toISOString();
  return iso.slice(11, 19) === '00:00:00' ? iso.slice(0, 10) : iso.slice(11, 19);
}

function trim(x) {
  return String(Number(x.toPrecision(3)));
}
