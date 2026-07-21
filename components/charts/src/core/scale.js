//@ts-check
/**
 * @file Scales: pure `domain -> (value) => [0,1]` closures. All pixel
 * mapping happens in the render pass; the AST and these scales stay in
 * abstract unit space (the geometry-free contract). Construction may
 * allocate (lookup maps); the returned functions never do.
 *
 * Out-of-domain inputs map outside [0,1] (linear/log/time) or to `NaN`
 * (unknown ordinal/band categories); `polylinePath` and `num` in
 * `@jarenjs/view/helpers` are the render-side guards that keep a NaN
 * from ever reaching an emitted string.
 */

/**
 * @typedef {(value: number) => number} UnitScale
 */

/**
 * Linear scale. A zero-span domain maps every value to 0.5.
 * @param {number} min - Domain minimum
 * @param {number} max - Domain maximum
 * @returns {UnitScale}
 */
export function scaleLinear(min, max) {
  const span = max - min;
  if (span === 0)
    return () => 0.5;
  return (v) => (v - min) / span;
}

/**
 * Logarithmic scale (base 10). The domain must be strictly positive —
 * that is checked once here, not per call; a non-positive *value* maps
 * to NaN (log of a non-positive number), which the render guards drop.
 * @param {number} min - Domain minimum (> 0)
 * @param {number} max - Domain maximum (> 0)
 * @returns {UnitScale}
 */
export function scaleLog(min, max) {
  if (!(min > 0) || !(max > 0))
    throw new RangeError(`scaleLog domain must be positive, got [${min}, ${max}]`);
  const logMin = Math.log10(min);
  const span = Math.log10(max) - logMin;
  if (span === 0)
    return () => 0.5;
  return (v) => (Math.log10(v) - logMin) / span;
}

/**
 * Ordinal scale: each category maps to the center of its equal slot,
 * `(i + 0.5) / n`. Unknown categories map to NaN.
 * @param {readonly string[]} categories - Domain, in display order
 * @returns {(category: string) => number}
 */
export function scaleOrdinal(categories) {
  const n = categories.length;
  const index = new Map();
  for (let i = 0; i < n; ++i)
    index.set(categories[i], i);
  return (category) => {
    const i = index.get(category);
    return i === undefined ? NaN : (i + 0.5) / n;
  };
}

/**
 * Band scale: each category owns an equal band with inner padding. The
 * returned function gives the band's start; `bandwidth` and `step` are
 * exposed as properties. Unknown categories map to NaN.
 * @param {readonly string[]} categories - Domain, in display order
 * @param {number} [padding] - Fraction of each step left empty (0..1)
 * @returns {((category: string) => number) & {bandwidth: number, step: number}}
 */
export function scaleBand(categories, padding = 0.2) {
  const n = categories.length;
  const step = n === 0 ? 1 : 1 / n;
  const bandwidth = step * (1 - padding);
  const inset = (step - bandwidth) / 2;
  const index = new Map();
  for (let i = 0; i < n; ++i)
    index.set(categories[i], i);
  const scale = (category) => {
    const i = index.get(category);
    return i === undefined ? NaN : i * step + inset;
  };
  scale.bandwidth = bandwidth;
  scale.step = step;
  return scale;
}

/**
 * Time scale: a linear scale over epoch milliseconds that also accepts
 * `Date` instances (converted once per call via `getTime`, no
 * allocation).
 * @param {number|Date} min - Domain minimum
 * @param {number|Date} max - Domain maximum
 * @returns {(value: number|Date) => number}
 */
export function scaleTime(min, max) {
  const t0 = typeof min === 'number' ? min : min.getTime();
  const t1 = typeof max === 'number' ? max : max.getTime();
  const span = t1 - t0;
  if (span === 0)
    return () => 0.5;
  return (v) => ((typeof v === 'number' ? v : v.getTime()) - t0) / span;
}
