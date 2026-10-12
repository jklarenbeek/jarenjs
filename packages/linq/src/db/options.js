//@ts-check
/**
 * @file The closed option bag of the client's constructors that take one
 * (`createDbReceipts`, `createDbRunStore`, `createDbEffectStore`,
 * `createDbIngestionStore`, `createDbRangeProvider` and
 * `createLexicalRangeProvider`): a member outside the set they read is
 * refused by name, because a misspelt bound or collection would otherwise
 * be replaced by its default in silence.
 */

import { isPlainOptions, refuseUnknownMembers } from '@jarenjs/core/object';

/**
 * `undefined` is no options; anything but a plain object, or a member
 * outside `known`, is a `TypeError` naming the nearest member.
 * @param {unknown} options
 * @param {readonly string[]} known - the members the constructor reads
 * @param {string} what - the constructor, for the message
 */
export function closedOptions(options, known, what) {
  if (options === undefined) return;
  if (!isPlainOptions(options)) throw new TypeError(`${what} takes a plain options object`);
  refuseUnknownMembers(options, known, (key, hint) => new TypeError(`${what} does not take '${key}'${hint}`));
}
