//@ts-check

import { CodedError } from '../errors.js';

/**
 * The codes a {@link CalendarError} carries. Each names one refusal, so
 * a caller can tell a local time that never happened from one that
 * happened twice, and both from a zone name nobody knows.
 * @type {Readonly<Record<'JY0001'|'JY0002'|'JY0003'|'JY0004'|'JY0005'|'JY0006'|'JY0007'
 *   |'JY0008'|'JY0009'|'JY0010'|'JY0011'|'JY0012'|'JY0013'|'JY0014'
 *   |'JY0015'|'JY0016'|'JY0017'|'JY0018'|'JY0019'|'JY0020'|'JY0021'|'JY0022'|'JY0023'|'JY0024'
 *   |'JY0025', string>>}
 */
export const CALENDAR_CODES = /* @__PURE__ */ Object.freeze({
  JY0001: 'the zone is not a non-empty name the provider knows',
  JY0002: 'the local time falls in a gap and the policy is reject',
  JY0003: 'the local time falls in a fold and the policy is reject',
  JY0004: 'the provider lacks a member this call needs, or answered it in a shape the seam does not define',
  JY0005: 'the policy is not one of rfc5545, later or reject',
  JY0006: 'no policy was given, and resolution has no default',
  JY0007: 'the local time is not a civil date and time of day this layer reads',
  JY0008: 'a time of 24:00 names the end of a day and is admitted only on an end bound',
  JY0009: 'a seconds value of 60 (a leap second) is not admitted',
  JY0010: 'a fraction past the millisecond is refused, never truncated',
  JY0011: 'a wall-clock time carries no offset or Z; a floating time has none and a zoned time takes its zone\'s',
  JY0012: 'the date is not a civil date from 0000-01-01 to 9999-12-31',
  JY0013: 'the value is not a temporal value of a form and kind this call takes',
  JY0014: 'an option is not of the form this call takes',
  JY0015: 'the recurrence rule is not RRULE text or its JSON form: an unknown or empty part, no FREQ, or a value spelled wrong',
  JY0016: 'a recurrence rule part holds a value outside its range or with a sign it does not take',
  JY0017: 'a recurrence rule part is given twice',
  JY0018: 'a recurrence rule part does not go with the frequency, the start or another part',
  JY0019: 'the recurrence end (UNTIL) is not of the kind the start requires',
  JY0020: 'the frequency is valid RRULE but is not enumerated in this release; only DAILY, WEEKLY, MONTHLY and YEARLY are',
  JY0021: 'an override that ranges over this and future occurrences is kept as data but refused for expansion',
  JY0022: 'a zone definition (VTIMEZONE) is not of the form this layer compiles: no TZID or observance, or a member spelled wrong',
  JY0023: 'a zone definition contradicts itself: two onsets at one instant with different offsets, or changes whose wall-clock spans overlap',
  JY0024: 'the instant or wall clock lies outside the horizon a compiled zone definition covers; it is never guessed',
  JY0025: 'a zone definition crosses a limit (observances, or provider calls while writing one)',
});

/**
 * The refusal every `@jarenjs/core/calendar` operation throws: a
 * {@link CodedError} whose `code` is one of {@link CALENDAR_CODES} and
 * whose `docPath` names the argument at fault (`/parts`, `/zone`,
 * `/provider`, `/policy`, `/value/time`, `/options/days`); a fault inside
 * a recurrence rule names the rule part and the list index
 * (`rrule.BYMONTHDAY[2]`).
 */
export class CalendarError extends CodedError {
  /**
   * @param {string} code - one of {@link CALENDAR_CODES}
   * @param {string} reason - the bare reason; `message` is composed per
   *   the coded contract
   * @param {string} [docPath] - the argument at fault
   * @param {unknown} [cause] - what the provider threw, when it threw
   */
  constructor(code, reason, docPath = undefined, cause = undefined) {
    super('CalendarError', code, reason, docPath,
      cause !== undefined ? { cause } : undefined);
  }
}
