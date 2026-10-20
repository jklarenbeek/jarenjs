//@ts-check
/**
 * The arcade's shelf: every game the studio hosts, by id, in the order
 * the shelf shows them. A game is a `GameModule` (`./game.js`) and
 * nothing more — the arcade, its HUD and the contract's `arcade.tool`
 * reach a game only through that shape.
 */

import { grove } from './grove/index.js';
import { dancers } from './dancers/index.js';
import { arena } from './arena/index.js';

/** @type {Readonly<Record<string, import('./game.js').GameModule>>} */
export const GAMES = Object.freeze({ grove, dancers, arena });
