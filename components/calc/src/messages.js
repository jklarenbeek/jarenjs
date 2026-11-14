//@ts-check
/**
 * @file The calculator's English message catalog: every word of chrome
 * the calculator shows a reader (the mode tabs, the panels' labels, the
 * word-size and signedness toggles, the rates line, the financial form's
 * field labels, the error card) and the expression diagnostics its display
 * shows (a parse error, an unknown name, a wrong argument count), keyed
 * by a stable `calc/...` id in the suite's one message grammar
 * (`@jarenjs/core/message`): `{name}` substitutes a parameter, `{{` is a
 * literal brace, and a closure stands where English needs a real plural.
 * A locale pack translates these ids; {@link calcText} renders through
 * such a pack, compiled, falling back to this English per id.
 *
 * Deliberately not here: the keypad's symbols and function names (`sin`,
 * `ans`, `⌫`, `M+`, `MC`, `M =`), the base names (HEX, DEC, OCT, BIN), the
 * angle units and unit symbols, the financial form's enum values (`pmt`,
 * `pv`, …, the variables a TVM keypad names), the message of an error a
 * host function or the core kernels throw (quoted as given), and the
 * developer-facing refusals of a malformed AST.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

/** @param {number} n @returns {string} the English noun for `n` arguments */
const argumentsNoun = (n) => (n === 1 ? 'argument' : 'arguments');

/**
 * The calc English catalog: message id → template or render closure.
 * Frozen; a locale pack supplies the same ids.
 * @type {Readonly<Record<string, string | ((params: any) => string)>>}
 */
export const calcMessagesEn = /*#__PURE__*/ Object.freeze({
  // ——— the mode tabs ———
  'calc/mode/standard': 'Standard',
  'calc/mode/scientific': 'Scientific',
  'calc/mode/programmer': 'Programmer',
  'calc/mode/financial': 'Financial',
  'calc/mode/converter': 'Converter',

  // ——— the panels ———
  'calc/display/error-at': '{message} ({line}:{column})',
  'calc/word/signed': 'signed',
  'calc/word/unsigned': 'unsigned',
  'calc/word/bits': '{bits}-bit',
  'calc/financial/result': 'Result ({solveFor}): ',
  // the financial form's field labels, by the fields' `x-msgid` (the
  // `@jarenjs/forms` static-text convention: `<x-msgid>#label`)
  'calc/financial#label': 'Time Value of Money',
  'calc/financial/nper#label': 'N — number of periods',
  'calc/financial/rate#label': 'I/Y — interest % per period',
  'calc/financial/pv#label': 'PV — present value',
  'calc/financial/pmt#label': 'PMT — payment',
  'calc/financial/fv#label': 'FV — future value',
  'calc/financial/solve-for#label': 'Solve for',
  'calc/converter/dimension': 'Dimension',
  'calc/converter/rates': 'rates:',
  'calc/converter/stale': 'static fallback',

  // ——— the converter's dimensions and the rates' state ———
  'calc/dimension/length': 'length',
  'calc/dimension/area': 'area',
  'calc/dimension/volume': 'volume',
  'calc/dimension/mass': 'mass',
  'calc/dimension/temperature': 'temperature',
  'calc/dimension/time': 'time',
  'calc/dimension/speed': 'speed',
  'calc/dimension/pressure': 'pressure',
  'calc/dimension/energy': 'energy',
  'calc/dimension/power': 'power',
  'calc/dimension/data': 'data',
  'calc/dimension/datarate': 'datarate',
  'calc/dimension/frequency': 'frequency',
  'calc/dimension/angle': 'angle',
  'calc/dimension/fuel': 'fuel',
  'calc/dimension/currency': 'currency',
  'calc/rates/idle': 'idle',
  'calc/rates/fallback': 'fallback',
  'calc/rates/ok': 'ok',
  'calc/rates/error': 'error',

  // ——— the error card ———
  'calc/error/title': 'Expression error',
  'calc/error/at': '{message} (line {line}, col {column})',

  // ——— expression diagnostics ———
  'calc/parse/empty': 'empty expression',
  'calc/parse/unexpected': 'unexpected \'{token}\'',
  'calc/parse/end': 'unexpected end of input',
  'calc/parse/close': 'expected \')\'',
  'calc/parse/number': 'invalid number',
  'calc/parse/separator': 'expected \',\' or \')\'',
  'calc/compile/constant': 'unknown constant \'{name}\'',
  'calc/compile/function': 'unknown function \'{name}\'',
  'calc/compile/arity-at-least': (p) => `${p.name}() expected at least ${p.min} ${argumentsNoun(p.min)}, got ${p.count}`,
  'calc/compile/arity-exactly': (p) => `${p.name}() expected ${p.min} ${argumentsNoun(p.min)}, got ${p.count}`,
  'calc/compile/arity-either': '{name}() expected {min} or {max} arguments, got {count}',
});

/**
 * The English catalog, compiled on first use: the fallback of every id.
 * @type {Readonly<Record<string, (params: object) => string>> | undefined}
 */
let english;

/**
 * A text function over a compiled catalog: `t(id, params)` renders `id`
 * through `catalog` (the output of `compileMessageCatalog` over a locale
 * pack: a record of render functions) and falls back to the English of
 * {@link calcMessagesEn} per id — when the catalog lacks the id, or its
 * entry throws or answers something other than a string. With no catalog
 * every id renders its English.
 * @param {Readonly<Record<string, unknown>> | null} [catalog] - a compiled catalog, or none for English
 * @returns {(id: string, params?: Record<string, unknown>) => string}
 */
export function calcText(catalog) {
  return function calcMessage(id, params = {}) {
    const render = catalog != null && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
    if (typeof render === 'function') {
      try {
        const text = render(params);
        if (typeof text === 'string') return text;
      }
      catch { /* a throwing translation renders the English */ }
    }
    english ??= compileMessageCatalog(calcMessagesEn);
    return Object.hasOwn(english, id) ? english[id](params) : id;
  };
}
