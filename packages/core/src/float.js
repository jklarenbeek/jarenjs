//@ts-check

import {
  isNumberType,
} from './index.js';

export const FLOAT16_MAX = 65504.0;
export const FLOAT16_MIN = 0.00006103515625;
export const FLOAT16_EPS = 0.0009765625;
export const FLOAT16_EXBITS = 5;
export const FLOAT16_FRBITS = 10;

export function isValidFloat16(value) {
  return isNumberType(value)
    && !Number.isNaN(value)
    && value >= -FLOAT16_MAX
    && value <= FLOAT16_MAX;
}

export function getValidFloat16(value, defVal = NaN) {
  if (!isNumberType(value) /* TODO: do we need this? */
    || Number.isNaN(value)) return defVal;
  if (value < -FLOAT16_MAX) return -Infinity;
  if (value > FLOAT16_MAX) return Infinity;
  return value;
}

export function Float16_increment(value) {
  const next = value + 2 ** (Math.log2(value) - 11);
  return (next > FLOAT16_MAX)
    ? Infinity
    : next;
}

export function Float16_decrement(value) {
  const next = value - 2 ** (Math.log2(value) - 11);
  return (next < -FLOAT16_MAX)
    ? -Infinity
    : next;
}

export const FLOAT32_MAX = 3.4028234663852886e+38;
export const FLOAT32_MIN = 1.1754943508222875e-38;
export const FLOAT32_EPS = 1.1920928955078125e-7;
export const FLOAT32_EXBITS = 8;
export const FLOAT32_FRBITS = 23;

export function isValidFloat32(value) {
  return isNumberType(value)
    && !Number.isNaN(value)
    && value >= -FLOAT32_MAX
    && value <= FLOAT32_MAX;
}

export function getValidFloat32(value, defVal = NaN) {
  if (!isNumberType(value) || Number.isNaN(value)) return defVal;
  if (value < -FLOAT32_MAX) return -Infinity;
  if (value > FLOAT32_MAX) return Infinity;
  return value;
}

export function Float32_increment(value) {
  const next = value + 2 ** (Math.log2(value) - 24);
  return (next > FLOAT32_MAX)
    ? Infinity
    : next;
}

export function Float32_decrement(value) {
  const next = value - 2 ** (Math.log2(value) - 24);
  return (next < -FLOAT32_MAX)
    ? -Infinity
    : next;
}

export const FLOAT64_MAX = Number.MAX_VALUE;
export const FLOAT64_MIN = Number.MIN_VALUE;
export const FLOAT64_EPS = Number.EPSILON;
export const FLOAT64_EXBITS = 11;
export const FLOAT64_FRBITS = 52;

export function isValidFloat64(value) {
  return isNumberType(value)
    && !Number.isNaN(value)
    && value >= -FLOAT64_MAX
    && value <= FLOAT64_MAX;
}

export function getValidFloat64(value, defVal = NaN) {
  return isNumberType(value)
    ? value
    : defVal;
}

export function Float64_increment(value) {
  return value + 2 ** (Math.log2(value) - 53);
}

export function Float64_decrement(value) {
  return value - 2 ** (Math.log2(value) - 53);
}

export const FLOAT128_MAX = 0.0;
export const FLOAT128_MIN = 0.0;
export const FLOAT128_EPS = 0.0;
export const FLOAT128_EXBITS = 15;
export const FLOAT128_FRBITS = 112;
