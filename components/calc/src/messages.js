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
 * `ans`, `⌫`, `M+`, `MC`, `M =`; each symbol key's accessible name is
 * here, `calc/key/...`), the base names (HEX, DEC, OCT, BIN), the angle
 * units and unit symbols, the names of rate sources, the message of an
 * error a host function or the core kernels throw (the display says
 * `calc/display/no-result` instead), and the developer-facing refusals of a
 * malformed AST.
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

  // ——— the display and the keypad's accessible names ———
  'calc/display/label': 'Calculator display',
  'calc/display/incomplete': 'Incomplete expression',
  'calc/display/invalid': 'This expression cannot be read',
  'calc/display/not-real': 'No real result: the value is outside the function\'s domain',
  'calc/display/infinite': 'The result is infinite: a division by zero or a number too large',
  'calc/display/no-result': 'No result: a division by zero',
  'calc/keyboard/hint': 'Keyboard: digits and operators type, Enter is =, Backspace deletes, Esc clears.',
  'calc/key/clear': 'Clear',
  'calc/key/back': 'Backspace',
  'calc/key/open': 'Open parenthesis',
  'calc/key/close': 'Close parenthesis',
  'calc/key/divide': 'Divide',
  'calc/key/multiply': 'Multiply',
  'calc/key/minus': 'Minus',
  'calc/key/plus': 'Plus',
  'calc/key/point': 'Decimal point',
  'calc/key/percent': 'Percent',
  'calc/key/ans': 'Last answer',
  'calc/key/power': 'Power',
  'calc/key/equals': 'Equals',
  'calc/key/sin': 'Sine',
  'calc/key/cos': 'Cosine',
  'calc/key/tan': 'Tangent',
  'calc/key/asin': 'Arcsine',
  'calc/key/acos': 'Arccosine',
  'calc/key/atan': 'Arctangent',
  'calc/key/ln': 'Natural logarithm',
  'calc/key/log': 'Base-10 logarithm',
  'calc/key/sqrt': 'Square root',
  'calc/key/exp': 'e to the power of x',
  'calc/key/factorial': 'Factorial',
  'calc/key/pi': 'Pi',
  'calc/key/e': 'Euler\'s number e',
  'calc/key/not': 'Bitwise NOT',
  'calc/key/and': 'Bitwise AND',
  'calc/key/or': 'Bitwise OR',
  'calc/key/xor': 'Bitwise exclusive OR',
  'calc/key/shl': 'Shift left',
  'calc/key/shr': 'Shift right',
  'calc/key/mod': 'Remainder (modulo)',
  'calc/key/hex': 'Hexadecimal number',
  'calc/key/bin': 'Binary number',
  'calc/key/oct': 'Octal number',
  'calc/key/mem-add': 'Add the result to memory',
  'calc/key/mem-clear': 'Clear memory',

  // ——— the panels ———
  'calc/word/signed': 'signed',
  'calc/word/unsigned': 'unsigned',
  'calc/word/bits': '{bits}-bit',
  'calc/programmer/note': 'Whole-number arithmetic: each result is truncated toward zero and wrapped to the selected word size. Inside one expression ÷ keeps the exact fraction, so 7 ÷ 2 × 2 = 7.',
  'calc/plot/expr': 'Function of x to plot',
  'calc/financial/result': 'Result ({solveFor}): ',
  'calc/financial/no-solution': 'No solution for these values: check that the money you receive and the money you pay have opposite signs.',
  'calc/financial/intro': 'Time value of money: an amount today is worth more than the same amount later, because it can earn interest in between.',
  'calc/financial/how': 'Enter four of the five values, choose the fifth under {solveFor}, and its field shows the answer. A period is one payment interval: I/Y is the interest rate per period (6% a year paid monthly is 6 ÷ 12 = 0.5) and N counts the periods (30 years paid monthly is 360).',
  'calc/financial/signs': 'Signs follow the money: what you receive is positive, what you pay is negative. Borrowing {pv} (PV) at {annual}% a year over {years} years costs {payment} a month, so the answer is PMT = −{payment}.',
  'calc/financial/formula': 'How it works: the calculator finds the value that balances PV × (1 + i)^N + PMT × ((1 + i)^N − 1) ÷ i + FV = 0, where i = I/Y ÷ 100 and each payment falls at the end of its period.',
  'calc/financial/examples': 'Worked examples: click one to fill in the values',
  'calc/financial/example/mortgage': 'Mortgage payment',
  'calc/financial/example/mortgage/text': 'Borrow {pv} at {annual}% a year, repaid monthly over {years} years: the monthly payment.',
  'calc/financial/example/savings': 'Savings goal',
  'calc/financial/example/savings/text': 'Save {pmt} a month for {years} years at {annual}% a year: the amount at the end.',
  'calc/financial/example/payoff': 'Loan payoff time',
  'calc/financial/example/payoff/text': 'Owe {pv} at {annual}% a year and repay {pmt} a month: the months until it is paid off.',
  'calc/financial/example/return': 'Implied return',
  'calc/financial/example/return/text': 'Invest {pv} now and receive {fv} after {years} years: the yearly return.',
  // the financial form's field labels, descriptions and the unknown's
  // option labels, by the fields' `x-msgid` (the `@jarenjs/forms`
  // static-text convention: `<x-msgid>#label`, `#description`, `#enum/<value>`)
  'calc/financial#label': 'Time Value of Money',
  'calc/financial/nper#label': 'N — number of periods',
  'calc/financial/nper#description': 'How many periods: years × periods per year.',
  'calc/financial/rate#label': 'I/Y — interest % per period',
  'calc/financial/rate#description': 'The interest rate per period, in percent: the yearly rate ÷ periods per year.',
  'calc/financial/pv#label': 'PV — present value',
  'calc/financial/pv#description': 'The amount at the start: a loan you receive (+) or a deposit you make (−).',
  'calc/financial/pmt#label': 'PMT — payment',
  'calc/financial/pmt#description': 'The payment each period: money you pay (−) or receive (+).',
  'calc/financial/fv#label': 'FV — future value',
  'calc/financial/fv#description': 'The amount after the last period: 0 for a loan paid off, or a savings target.',
  'calc/financial/solve-for#label': 'Solve for',
  'calc/financial/solve-for#description': 'The unknown to calculate: its field shows the answer.',
  'calc/financial/solve-for#enum/pmt': 'PMT (payment)',
  'calc/financial/solve-for#enum/pv': 'PV (present value)',
  'calc/financial/solve-for#enum/fv': 'FV (future value)',
  'calc/financial/solve-for#enum/nper': 'N (number of periods)',
  'calc/financial/solve-for#enum/rate': 'I/Y (rate per period)',
  'calc/converter/dimension': 'Dimension',
  'calc/converter/value': 'Value to convert',
  'calc/converter/from': 'From unit',
  'calc/converter/to': 'To unit',
  'calc/converter/swap': 'Swap units',
  'calc/converter/refresh': 'Refresh rates',

  // ——— the converter's dimensions and the rates' state ———
  'calc/dimension/length': 'Length',
  'calc/dimension/area': 'Area',
  'calc/dimension/volume': 'Volume',
  'calc/dimension/mass': 'Mass',
  'calc/dimension/temperature': 'Temperature',
  'calc/dimension/time': 'Time',
  'calc/dimension/speed': 'Speed',
  'calc/dimension/pressure': 'Pressure',
  'calc/dimension/energy': 'Energy',
  'calc/dimension/power': 'Power',
  'calc/dimension/data': 'Data size',
  'calc/dimension/datarate': 'Data rate',
  'calc/dimension/frequency': 'Frequency',
  'calc/dimension/angle': 'Angle',
  'calc/dimension/fuel': 'Fuel economy',
  'calc/dimension/currency': 'Currency',
  'calc/rates/live': 'Live rates from {source}, updated {time}',
  'calc/rates/offline': 'Live rates unavailable: showing built-in sample rates',
  'calc/rates/offline-since': 'Live rates unavailable: showing the rates from {source} of {time}',
  'calc/rates/builtin': 'Built-in sample rates, not live',

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
