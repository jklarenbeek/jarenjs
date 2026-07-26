//@ts-check
/**
 * @file Number formatting and parsing. The
 * one place the suite formats a number for display: notation control
 * (auto/fixed/sci/eng), thousands grouping and radix output, plus a
 * radix-aware `parseNumber`. Radix I/O delegates to `math/word.js` so
 * base conversion is never re-implemented.
 */

import { toBase, fromBase } from './word.js';

/**
 * @typedef {object} FormatOptions
 * @property {'auto'|'fixed'|'sci'|'eng'} [notation] default 'auto'
 * @property {number} [precision] significant/decimal digits (notation-dependent)
 * @property {boolean|string} [group] thousands separator: true → ',', or a custom string
 * @property {number} [radix] 2..36; when not 10, `value` is formatted as an integer word
 * @property {string} [decimal] decimal mark, default '.'
 */

/**
 * Insert a grouping separator every three digits of an integer string
 * (sign-aware).
 * @param {string} intPart
 * @param {string} sep
 * @returns {string}
 */
function groupInteger(intPart, sep) {
  let neg = '';
  let s = intPart;
  if (s.startsWith('-')) { neg = '-'; s = s.slice(1); }
  const parts = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return neg + parts.join(sep);
}

/**
 * Engineering notation: mantissa in [1, 1000) times 10^(3k).
 * @param {number} value
 * @param {number} precision
 * @returns {string}
 */
function toEngineering(value, precision) {
  if (value === 0) return '0e+0';
  const exp = Math.floor(Math.log10(Math.abs(value)));
  const engExp = Math.floor(exp / 3) * 3;
  const mantissa = value / Math.pow(10, engExp);
  const m = precision >= 0 ? mantissa.toFixed(precision) : String(mantissa);
  return `${m}e${engExp >= 0 ? '+' : ''}${engExp}`;
}

/**
 * Format a number for display.
 *
 * `notation: 'auto'` (the default) is NOT a drop-in for a fixed-unit
 * readout: the auto branch escapes to exponential once
 * `abs(value) >= 1e21` or `abs(value) < 1e-6`, so
 * `formatNumber(v, { precision: 3 })` is not interchangeable with a
 * plain `Number(v.toPrecision(3))`. A caller that appends its own unit
 * - `"0.0509 ms"` - wants the value never to become `5.09e-5`, and must
 * either pass `notation: 'fixed'` or keep its own rounder. See
 * packages/core/docs/MATH.md.
 * @param {number} value
 * @param {FormatOptions} [opts]
 * @returns {string}
 */
export function formatNumber(value, opts = {}) {
  value = +value;
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '∞';
  if (value === -Infinity) return '-∞';

  const notation = opts.notation ?? 'auto';
  const sep = opts.group === true ? ',' : (typeof opts.group === 'string' ? opts.group : '');
  const decimal = opts.decimal ?? '.';

  // Radix output: integer word in the requested base.
  if (opts.radix !== undefined && opts.radix !== 10) {
    let str = toBase(Math.trunc(value), opts.radix, { upper: true });
    if (sep) str = groupInteger(str, sep);
    return str;
  }

  let out;
  if (notation === 'fixed') {
    out = value.toFixed(opts.precision ?? 2);
  }
  else if (notation === 'sci') {
    out = value.toExponential(opts.precision ?? undefined);
  }
  else if (notation === 'eng') {
    out = toEngineering(value, opts.precision ?? 3);
  }
  else {
    // auto: plain decimal for human-scale magnitudes, else scientific.
    const abs = Math.abs(value);
    if (value !== 0 && (abs >= 1e21 || abs < 1e-6)) {
      out = opts.precision !== undefined ? value.toExponential(opts.precision) : value.toExponential();
    }
    else if (opts.precision !== undefined) {
      out = String(Number(value.toPrecision(opts.precision)));
    }
    else {
      out = String(value);
    }
  }

  if (sep || decimal !== '.') {
    const eIdx = out.search(/[eE]/);
    const exp = eIdx >= 0 ? out.slice(eIdx) : '';
    const mant = eIdx >= 0 ? out.slice(0, eIdx) : out;
    const dot = mant.indexOf('.');
    const intPart = dot >= 0 ? mant.slice(0, dot) : mant;
    const frac = dot >= 0 ? mant.slice(dot + 1) : '';
    out = (sep ? groupInteger(intPart, sep) : intPart)
      + (frac ? decimal + frac : '')
      + exp;
  }
  return out;
}

/**
 * Parse a numeric string, radix-aware. Recognizes `0x`/`0o`/`0b`
 * prefixes, an explicit `radix` option, grouping separators (`,`/`_`/
 * space) and base-10 scientific notation. Returns `NaN` on failure
 * rather than throwing.
 *
 * @param {string} str
 * @param {{ radix?: number }} [opts]
 * @returns {number}
 */
export function parseNumber(str, opts = {}) {
  if (typeof str !== 'number') str = String(str);
  else return +str;
  let s = str.trim();
  if (s === '') return NaN;
  const lower = s.toLowerCase();
  if (lower === 'nan') return NaN;
  if (lower === '∞' || lower === 'infinity' || lower === '+infinity') return Infinity;
  if (lower === '-∞' || lower === '-infinity') return -Infinity;

  const prefixed = /^[+-]?0[xob]/i.test(s);
  if (prefixed || (opts.radix !== undefined && opts.radix !== 10)) {
    try {
      return Number(fromBase(s, opts.radix ?? 10));
    }
    catch {
      return NaN;
    }
  }
  // Base 10: strip grouping, keep the numeric grammar.
  const cleaned = s.replace(/[,_ ]/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) return NaN;
  return Number(cleaned);
}
