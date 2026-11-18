//@ts-check

//#region Zone names and the civil date now
// Two small questions a caller asks before it resolves anything: is this
// a zone the provider knows, and what is the date there now. Both go to
// an injected provider and, for "now", the injected runtime clock; the
// host's own zone and the platform clock are never read directly.

import { resolveRuntime } from '../runtime.js';
import { CalendarError } from './errors.js';
import { admitProvider, admitZoneName, providerKnows, providerOf, wholeIn } from './resolve.js';

/**
 * Whether the provider knows a zone name. It asks the provider (through
 * `toParts`), so it answers what that zone data accepts: the Intl
 * provider also accepts a link name, a case variant and, on hosts whose
 * `Intl` does, a fixed offset such as `+01:00`. It does not say a name is
 * the canonical one.
 * @param {unknown} name
 * @param {import('../series/zone.js').ZoneProvider} provider
 * @returns {boolean} `false` for a non-string or empty name
 * @throws {CalendarError} `JY0004` for a provider without `toParts`
 * @example
 * isZone('Europe/Amsterdam', createIntlZoneProvider()); // true
 * isZone('Mars/Olympus', createIntlZoneProvider());     // false
 */
export function isZone(name, provider) {
  admitProvider(provider, 'toParts');
  return typeof name === 'string' && name !== '' && providerKnows(provider, name);
}

/**
 * The zone name, when the provider knows it; a refusal naming it
 * otherwise.
 * @param {unknown} name
 * @param {import('../series/zone.js').ZoneProvider} provider
 * @returns {string} the name, unchanged
 * @throws {CalendarError} `JY0001` for a name the provider does not know,
 *   `JY0004` for a provider without `toParts`
 */
export function assertZone(name, provider) {
  admitProvider(provider, 'toParts');
  const zone = admitZoneName(name);
  if (!providerKnows(provider, zone))
    throw new CalendarError('JY0001', `the provider does not know the zone '${zone}'`, '/zone');
  return zone;
}

/**
 * The civil date in a zone at the runtime clock's instant, as
 * `YYYY-MM-DD`. The instant is `runtime.now()` (a fixed clock in a test,
 * the platform's otherwise) and the provider is `zoneProvider` (or its
 * older spelling `provider`), or the runtime's `zoneProvider` when none
 * is passed; the zone is always
 * named, never the host's.
 * @param {string} zone
 * @param {import('./resolve.js').ZoneProviderOptions} [options]
 * @returns {string}
 * @throws {CalendarError} `JY0001` for a zone the provider does not know,
 *   `JY0004` for no provider, or one whose wall clock is not a date
 * @throws {TypeError} for a malformed runtime, or a clock that answers no
 *   finite instant
 * @example
 * todayIn('Pacific/Apia', { runtime: createRuntime({ now: () => Date.parse('2026-01-01T10:30:00Z') }),
 *   provider: createIntlZoneProvider() }); // '2026-01-01'
 */
export function todayIn(zone, options = undefined) {
  const runtime = resolveRuntime(options?.runtime);
  const provider = admitProvider(providerOf(options), 'toParts');
  const name = admitZoneName(zone);
  const now = runtime.now();
  if (typeof now !== 'number' || !Number.isFinite(now))
    throw new TypeError(`runtime.now() answered ${String(now)}, not a finite instant`);
  let parts;
  try {
    parts = provider.toParts(now, name);
  }
  catch (error) {
    if (error instanceof CalendarError)
      throw error;
    if (!providerKnows(provider, name))
      throw new CalendarError('JY0001', `the provider does not know the zone '${name}'`, '/zone', error);
    throw new CalendarError('JY0004', `the provider's toParts(now, '${name}') threw`, '/provider', error);
  }
  if (parts === null || typeof parts !== 'object' || !wholeIn(parts.year, 0, 9999)
    || !wholeIn(parts.month, 1, 12) || !wholeIn(parts.day, 1, 31)) {
    throw new CalendarError('JY0004', `the provider's toParts(now, '${name}') is not a date from year 0 to 9999`, '/provider');
  }
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}
//#endregion
