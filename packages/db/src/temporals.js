//@ts-check
/**
 * @file `@jarenjs/db/temporals` - declared temporal members (MODEL-FORMAT
 * §2, `temporals`) and the calendar operators of the store's queries
 * (`$instant`, `$wall`, QUERY-FORMAT §8.13): a calendar value of
 * `@jarenjs/core/calendar` keyed, refused and compared alike on SQLite and
 * PostgreSQL. It is a subpath of its own so a store that declares no
 * temporal member carries no calendar: pass {@link storeTemporals}'s
 * answer as `openStore`'s `temporals` (and `prepareModel`'s, for a model
 * prepared once). Without it a model declaring a temporal member is
 * `JD0017` and a query calling `$instant` or `$wall` is `JQ0003`.
 * @module
 */
import { queryCalendar } from '@jarenjs/json/query/calendar';
import { TEMPORAL_HOOKS } from './temporal.js';
import { TEMPORAL_SEAMS } from './temporal-seam.js';

/**
 * Enable declared temporal members and the calendar operators on a store:
 * `openStore(model, { driver, temporals: storeTemporals() })`.
 * @returns {{ readonly hooks: object, readonly calendar: object }}
 */
export function storeTemporals() {
  const seam = Object.freeze({ hooks: TEMPORAL_HOOKS, calendar: queryCalendar() });
  TEMPORAL_SEAMS.add(seam);
  return seam;
}
