//@ts-check
/**
 * @file The calculator's number text: a result as a reader reads it on the
 * display, the tape and the converter. A safe integer (below 2^53, where
 * every whole number is exact) shows every digit it has; any other finite value shows `digits` significant
 * digits, in positional notation from 10^-6 up to 10^digits and in
 * exponent notation outside it, with no zeros padding the mantissa
 * (`9.99e+22`, never `9.990000000000e+22`) and none trailing a fraction.
 * `group` separates the thousands of the whole part with commas, as the
 * financial panel's amounts are.
 */

/**
 * Drop the zeros that pad a fraction or a mantissa: `1.2300` → `1.23`,
 * `9.9900e+22` → `9.99e+22`, `2.000` → `2`.
 * @param {string} text a positional or exponent rendering
 * @returns {string}
 */
function trimZeros(text) {
  const at = text.indexOf('e');
  const mantissa = at < 0 ? text : text.slice(0, at);
  const exponent = at < 0 ? '' : text.slice(at);
  const trimmed = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
  return trimmed + exponent;
}

/**
 * Separate the thousands of the whole part of a positional rendering.
 * @param {string} text
 * @returns {string}
 */
function groupThousands(text) {
  const sign = text.startsWith('-') ? '-' : '';
  const body = sign === '' ? text : text.slice(1);
  const dot = body.indexOf('.');
  const whole = dot < 0 ? body : body.slice(0, dot);
  const fraction = dot < 0 ? '' : body.slice(dot);
  return sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + fraction;
}

/**
 * A finite or non-finite number as the display shows it.
 * @param {number | bigint | string} value a `Number`; any other value reads
 *   as the `Number` it converts to
 * @param {{ digits?: number, group?: boolean }} [options] significant digits
 *   (default 12) and thousands separators (default none: the text is then
 *   also an expression literal the parser reads back)
 * @returns {string}
 */
export function formatSignificant(value, options = {}) {
  const digits = options.digits ?? 12;
  // a host may patch a string into the slice: it reads as the Number it spells
  if (typeof value !== 'number') value = Number(value);
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '∞';
  if (value === -Infinity) return '-∞';
  if (value === 0) return '0';
  let text;
  if (Number.isSafeInteger(value)) text = String(value);
  else {
    const rounded = Number(value.toPrecision(digits));
    const magnitude = Math.abs(rounded);
    text = magnitude >= 1e-6 && magnitude < 10 ** digits
      ? trimZeros(rounded.toFixed(Math.max(0, digits - 1 - Math.floor(Math.log10(magnitude)))))
      : trimZeros(value.toExponential(digits - 1));
  }
  return options.group === true && !text.includes('e') ? groupThousands(text) : text;
}

/**
 * A number with exactly `decimals` fraction digits and grouped thousands,
 * an amount of money in its currency's minor units (`92.59`, `13,736`).
 * @param {number} value
 * @param {number} decimals
 * @returns {string}
 */
export function formatFixed(value, decimals) {
  if (!Number.isFinite(value)) return formatSignificant(value);
  const text = value.toFixed(decimals);
  return groupThousands(/^-0(\.0*)?$/.test(text) ? text.slice(1) : text);
}

/**
 * The decimal and grouping separators of a reader's compiled catalog (the
 * `number/decimal-separator` and `number/grouping-separator` entries a
 * `@jarenjs/locales` pack carries), else the English `.` and `,`.
 * @param {Readonly<Record<string, unknown>> | null | undefined} catalog
 * @returns {{ decimal: string, group: string }}
 */
export function numberSymbols(catalog) {
  /** @param {string} id @param {string} fallback */
  const read = (id, fallback) => {
    const render = catalog != null && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
    if (typeof render !== 'function') return fallback;
    try {
      const text = render({});
      return typeof text === 'string' && text !== '' ? text : fallback;
    }
    catch { return fallback; }
  };
  return { decimal: read('number/decimal-separator', '.'), group: read('number/grouping-separator', ',') };
}

/**
 * A number this module formatted (`.` decimal, `,` grouping) in the
 * reader's separators: `-1,199.10` reads `-1.199,10` to a Dutch reader.
 * @param {string} text
 * @param {{ decimal: string, group: string }} symbols
 * @returns {string}
 */
export function localizeNumber(text, symbols) {
  if (symbols.decimal === '.' && symbols.group === ',') return text;
  return text.replace(/[.,]/g, (c) => (c === '.' ? symbols.decimal : symbols.group));
}
