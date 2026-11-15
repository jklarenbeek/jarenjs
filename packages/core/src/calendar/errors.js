//@ts-check

import { CodedError } from '../errors.js';

/**
 * The codes a {@link CalendarError} carries. Each names one refusal, so
 * a caller can tell a local time that never happened from one that
 * happened twice, and both from a zone name nobody knows.
 * @type {Readonly<Record<'JY0001'|'JY0002'|'JY0003'|'JY0004'|'JY0005'|'JY0006'|'JY0007', string>>}
 */
export const CALENDAR_CODES = Object.freeze({
  JY0001: 'the zone is not a non-empty name the provider knows',
  JY0002: 'the local time falls in a gap and the policy is reject',
  JY0003: 'the local time falls in a fold and the policy is reject',
  JY0004: 'the provider lacks a member this call needs, or answered it in a shape the seam does not define',
  JY0005: 'the policy is not one of rfc5545, later or reject',
  JY0006: 'no policy was given, and resolution has no default',
  JY0007: 'the local time is not a civil date and time of day this layer reads',
});

/**
 * The refusal every `@jarenjs/core/calendar` operation throws: a
 * {@link CodedError} whose `code` is one of {@link CALENDAR_CODES} and
 * whose `docPath` names the argument at fault (`/parts`, `/zone`,
 * `/provider`, `/policy`).
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
