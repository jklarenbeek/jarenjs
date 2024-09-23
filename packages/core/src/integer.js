//@ts-check

import {
  isIntegerType,
} from './index.js';

export const INT8_MIN = -128;
export const INT8_MAX = 127;

export function isValidInt8(value) {
  return isIntegerType(value)
    && value >= INT8_MIN
    && value <= INT8_MAX;
}

export const UINT8_MIN = 0;
export const UINT8_MAX = 255;

export function isValidUInt8(value) {
  return isIntegerType(value)
    && value >= UINT8_MIN
    && value <= UINT8_MAX;
}

export const INT16_MIN = -32768;
export const INT16_MAX = 32767;

export function isValidInt16(value) {
  return isIntegerType(value)
    && value >= INT16_MIN
    && value <= INT16_MAX;
}

export const UINT16_MIN = 0;
export const UINT16_MAX = 65535;

export function isValidUInt16(value) {
  return isIntegerType(value)
    && value >= UINT16_MIN
    && value <= UINT16_MAX;
}

export const INT32_MIN = -(2 ** 31);
export const INT32_MAX = (2 ** 31) - 1;

export function isValidInt32(value) {
  return isIntegerType(value)
    && value >= INT32_MIN
    && value <= INT32_MAX;
}

export const UINT32_MIN = 0;
export const UINT32_MAX = (2 ** 32) - 1;

export function isValidUInt32(value) {
  return isIntegerType(value)
    && value >= UINT32_MIN
    && value <= UINT32_MAX;
}

export const INT64_MIN = Number.MIN_SAFE_INTEGER;
export const INT64_MAX = Number.MAX_SAFE_INTEGER;

export function isValidInt64(value) {
  return isIntegerType(value)
    && value >= INT64_MIN
    && value <= INT64_MAX;
}

export const UINT64_MIN = 0;
export const UINT64_MAX = Number.MAX_SAFE_INTEGER;

export function isValidUInt64(value) {
  return isIntegerType(value)
    && value >= UINT64_MIN
    && value <= UINT64_MAX;
}
