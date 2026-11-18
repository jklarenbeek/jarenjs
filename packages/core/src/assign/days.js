//@ts-check
/**
 * `@jarenjs/core/assign/days` - the civil-day half of assignment scoring:
 * the seam through which a `resource-day` rule's days are told. A day is
 * a civil day of the task's own zone, as `@jarenjs/core/calendar` splits
 * it (`splitByCivilDay`), so a day across a change of the clock is 23 or
 * 25 hours long and a skipped day has no instant. The zone database is
 * the host's provider; nothing here assumes one, and a task without a
 * zone is never given one. It is a subpath of its own so a host that
 * scores no day rule carries no calendar: pass {@link civilDays}'s answer
 * as `scoreAssignment`'s `options.days`.
 * @module
 */

import { bindFloating, splitByCivilDay } from '../calendar/bind.js';
import { dateValue } from '../calendar/model.js';
import { admitPolicy, admitProvider, identityOf, providerOf } from '../calendar/resolve.js';
import { AssignError } from './errors.js';
import { isRecord, pointer } from './model.js';
import { DAY_SEAMS } from './seam.js';

/** @typedef {'rfc5545' | 'later' | 'reject'} DayPolicy */

/**
 * A civil-day seam: what a scoring records in `provenance.days`. The
 * operations it carries are not members; only `scoreAssignment` reads them.
 * @typedef {Object} CivilDays
 * @property {DayPolicy} policy - decides only where a change carries the clock back across midnight
 * @property {{ readonly name: string, readonly revision: string }} provider - the provider's identity, or `unrecorded`
 */

const MEMBERS = /* @__PURE__ */ Object.freeze(['zoneProvider', 'runtime', 'policy']);
/** How many civil days one task may span: the calendar's own default, passed so the two cannot drift. */
const MAX_DAYS = 36600;

/**
 * Run a calendar admission, as a refusal of this call's option.
 * @template T
 * @param {() => T} admit @param {string} path
 * @returns {T}
 */
function optionOf(admit, path) {
  try {
    return admit();
  }
  catch (error) {
    throw new AssignError('JN0015', `${path.slice('/options/'.length)} is not of the form civilDays takes; the calendar's refusal is the cause`, path, error);
  }
}

/**
 * Build the civil-day seam a scoring of `resource-day` rules needs:
 * the host's zone provider (`candidates` and `toParts`, as
 * `@jarenjs/locales/intl-zones` `createIntlZoneProvider` answers, or a
 * fixed table) and the policy for a day that starts twice (`rfc5545`
 * takes the earlier start, `later` the later, `reject` refuses the
 * scoring). The provider's `identity` (`{ name, revision }`, else
 * `unrecorded`) and the policy go into every result's provenance, so a
 * result says which zone data told its days.
 * The provider is `zoneProvider`, or, when it is not given, the
 * `runtime` record's `zoneProvider`, so a runtime record a host built is
 * handed on unchanged.
 * @param {{ zoneProvider?: object, runtime?: Partial<import('../runtime.js').Runtime>, policy: DayPolicy }} options
 * @returns {Readonly<CivilDays>}
 * @throws {AssignError} JN0015 for an unknown option, a missing or malformed
 *   provider or identity, or a policy that is not one of the three (the
 *   calendar's refusal is the cause)
 * @example
 * import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
 * const days = civilDays({ zoneProvider: createIntlZoneProvider({ revision: '2026a' }), policy: 'rfc5545' });
 * scoreAssignment(problem, ruleSet, assignments, { days });
 */
export function civilDays(options) {
  if (!isRecord(options)) throw new AssignError('JN0015', 'civilDays takes { zoneProvider or runtime, policy }', '/options');
  for (const key of Object.keys(options))
    if (!MEMBERS.includes(key)) throw new AssignError('JN0015', `${key} is not a civilDays option`, `/options/${pointer(key)}`);
  const policy = /** @type {DayPolicy} */ (optionOf(() => admitPolicy(options.policy), '/options/policy'));
  // the call's own zoneProvider wins over the runtime record's, as the calendar reads them
  const fromRuntime = (options.zoneProvider === undefined || options.zoneProvider === null) && options.runtime !== undefined;
  const at = fromRuntime ? '/options/runtime' : '/options/zoneProvider';
  const provider = optionOf(() => admitProvider(admitProvider(providerOf(options), 'candidates'), 'toParts'), at);
  const own = optionOf(() => identityOf(provider), `${at}${fromRuntime ? '/zoneProvider' : ''}/identity`);
  // the identity is provenance: only its two members, in one key order, whatever the host's object holds
  const identity = Object.freeze({ name: own.name, revision: own.revision });
  const context = { zone: '', provider, policy };
  const seam = Object.freeze({ policy, provider: identity });
  DAY_SEAMS.set(seam, Object.freeze({
    split(/** @type {{ start: number, end: number }} */ interval, /** @type {string} */ zone) {
      return splitByCivilDay(interval, { ...context, zone, maxDays: MAX_DAYS });
    },
    span(/** @type {string} */ zone, /** @type {string} */ date) {
      const answer = /** @type {{ start: number, end: number }} */ (bindFloating(dateValue(date), { ...context, zone }));
      return { start: answer.start, end: answer.end };
    },
  }));
  return seam;
}
