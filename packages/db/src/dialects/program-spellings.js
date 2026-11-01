//@ts-check
/** The text of a database rule's installed programs, as each release planned
 * it. A store holds no mark of the release that installed its programs, so an
 * installed program is recognized only as the exact text one of these
 * spellings plans for the model: the latest, which this release plans and
 * creates, or an earlier one, which a store a previous release created holds
 * until a reviewed link replaces it (`planProgramUpgrade`). A text no spelling
 * plans is drift. Each entry names the features that tell its text from the
 * one before; only these combinations were ever installed, so no other is
 * recognized, and a spelling stays until a major release retires it. */

/**
 * @typedef {object} ProgramSpelling
 * @property {boolean} lockedProbe - on PostgreSQL an `$exists-row` probe that
 *   no odd number of `$not`s encloses locks the row it finds, `FOR KEY SHARE`
 *   or `FOR SHARE` as the store's probe does (MODEL-FORMAT §13.2); SQLite
 *   spells no lock, so its text is the same
 */

/** @type {readonly Readonly<ProgramSpelling>[]} */
export const PROGRAM_SPELLINGS = Object.freeze([
  // every release before the probe's lock
  Object.freeze({ lockedProbe: false }),
  // this release
  Object.freeze({ lockedProbe: true }),
]);

/** The spelling this release plans: the last. */
export const CURRENT_SPELLING = PROGRAM_SPELLINGS.length - 1;
