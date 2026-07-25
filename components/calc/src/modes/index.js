//@ts-check
/**
 * @file Mode-kernel barrel. Each mode is a data-driven descriptor
 * (keypad/panel + function-binding env + formatter); switching mode is a
 * patch of `$.calc.mode`.
 */

export { standardMode } from './standard.js';
export { scientificMode } from './scientific.js';
export { programmerMode, wordViews, BASES, WORD_SIZES } from './programmer.js';
export { financialMode, solveTvm, buildAmortization, npvOf, irrOf } from './financial.js';
export { converterMode, convertValue, unitOptions, converterDimensions, CURRENCY } from './converter.js';

import { standardMode } from './standard.js';
import { scientificMode } from './scientific.js';
import { programmerMode } from './programmer.js';
import { financialMode } from './financial.js';
import { converterMode } from './converter.js';

/** All modes, in selector order. */
export const MODES = [standardMode, scientificMode, programmerMode, financialMode, converterMode];

/** Mode descriptor by id. @type {Record<string, any>} */
export const MODE_BY_ID = Object.fromEntries(MODES.map((m) => [m.id, m]));
