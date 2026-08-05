//@ts-check
/**
 * @file The built-in operator packs, plain data wrapping `@jarenjs/core`.
 * A caller composes them into a registry: `createJsltRegistry().use(
 * mathPack).use(financePack)`. `allPacks` is the convenience array for
 * "register everything".
 */

export { mathPack } from './math.js';
export { financePack } from './finance.js';
export { statsPack } from './stats.js';

import { mathPack } from './math.js';
import { financePack } from './finance.js';
import { statsPack } from './stats.js';

/** Every built-in pack, in a stable order. */
export const allPacks = Object.freeze([mathPack, financePack, statsPack]);
