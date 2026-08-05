//@ts-check
/**
 * @file The math pack — scalar `$`-operators the core query vocabulary
 * lacks, wrapping the pure f64 functions of `@jarenjs/core/math`. Every
 * entry is `kind: 'op'` (scalar operands, scalar result). `pushable:
 * 'scalar'` marks the ones Ring 3 MAY register as a SQLite UDF; it is
 * ignored in Rings 1–2.
 */

import {
  mathf64_sqrt, mathf64_cbrt, mathf64_pow, mathf64_hypot, mathf64_sign,
  mathf64_abs, mathf64_sin, mathf64_cos, mathf64_tan,
  mathf64_asin, mathf64_acos, mathf64_atan, mathf64_atan2,
  mathf64_sinh, mathf64_cosh, mathf64_tanh,
  mathf64_log, mathf64_log2, mathf64_log10, mathf64_exp, mathf64_expm1,
} from '@jarenjs/core/math';

const op1 = (fn) => ({ kind: 'op', signature: ['number'], result: 'number', fn, pushable: 'scalar' });
const op2 = (fn) => ({ kind: 'op', signature: ['number', 'number'], result: 'number', fn, pushable: 'scalar' });

export const mathPack = {
  name: 'math',
  entries: {
    $abs: op1(mathf64_abs),
    $sign: op1(mathf64_sign),
    $sqrt: op1(mathf64_sqrt),
    $cbrt: op1(mathf64_cbrt),
    $pow: op2(mathf64_pow),
    $hypot: op2(mathf64_hypot),
    $exp: op1(mathf64_exp),
    $expm1: op1(mathf64_expm1),
    $log: op1(mathf64_log),
    $log2: op1(mathf64_log2),
    $log10: op1(mathf64_log10),
    $sin: op1(mathf64_sin),
    $cos: op1(mathf64_cos),
    $tan: op1(mathf64_tan),
    $asin: op1(mathf64_asin),
    $acos: op1(mathf64_acos),
    $atan: op1(mathf64_atan),
    $atan2: op2(mathf64_atan2),
    $sinh: op1(mathf64_sinh),
    $cosh: op1(mathf64_cosh),
    $tanh: op1(mathf64_tanh),
  },
};
