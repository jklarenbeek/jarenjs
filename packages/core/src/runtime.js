//@ts-check
/**
 * @file The runtime record: the clock, secure identifiers, randomness
 * and the zone provider as one frozen record a host builds
 * once and hands to the store, the jobs engine, the migration runner and
 * the http binding. Nothing here IS a clock, a random source or a zone
 * database: the defaults are the platform's own (`Date.now`,
 * `crypto.randomUUID`, `Math.random`, and no zone provider). Named zones
 * require an injected provider. A deterministic run — a fixed clock,
 * a seeded generator, a counting identifier — is configured in one place
 * so the subsystems agree about time and identity.
 *
 * Precedence is fixed: a subsystem's own explicit option wins over the
 * record's member, which wins over the built-in default. The options are
 * published surface, and a record that silently overrode them would be a
 * breaking change dressed as an ergonomic.
 *
 * The record reaches hosts, never query compilation. A compiled query is
 * cached by document identity and saved as a rule, so the current instant
 * enters it as data — an external — and there is no `now` operator for
 * this record to feed.
 */

/**
 * The record every host-facing subsystem takes as `runtime`.
 * @typedef {Object} Runtime
 * @property {() => number} now - the clock, in epoch milliseconds
 * @property {() => string} uuid - a fresh identifier; secure by default
 * @property {() => number} random - uniform in `[0, 1)`
 * @property {import('./series/zone.js').ZoneProvider | null} zoneProvider
 *   - the tzdb a named zone is read through, or `null`: a named zone is
 *   then a refusal, never a quiet UTC
 */

/**
 * The four members a runtime record carries, so a subsystem, a test and
 * a document all spell the host facts the same way.
 */
export const RUNTIME_MEMBERS = Object.freeze(['now', 'uuid', 'random', 'zoneProvider']);

/**
 * The platform's own answers — exactly what every subsystem fell back
 * to before the record existed, member for member, so a run that never
 * builds a record behaves as it always did.
 * @type {Readonly<Runtime>}
 */
const DEFAULT_RUNTIME = Object.freeze({
  now: Date.now,
  // `randomUUID` is a method of the platform's Crypto object and refuses
  // to run unbound, so the default is a call rather than a reference
  uuid: () => globalThis.crypto.randomUUID(),
  random: Math.random,
  zoneProvider: null,
});

/** Each member of the zone seam, spelled as a call reads it. */
const ZONE_SEAM = /* @__PURE__ */ Object.freeze({
  toParts: 'toParts(epoch, zone)',
  toEpoch: 'toEpoch(parts, zone, disambiguation)',
  candidates: 'candidates(parts, zone)',
});

/**
 * The one admission of a zone provider, shared by every core layer that
 * takes one: what `provider` lacks of the members a call needs, in one
 * wording per member, or `null` when it has them all. A layer refuses
 * with its own error class (the runtime record and the series clock a
 * `TypeError`, the calendar `JY0004`, the assignment day seam `JN0015`)
 * and asks only for the members its call reads, so a provider is never
 * refused for a member the call does not use. `identity` and any member
 * beyond the three are carried, never checked here.
 * @param {unknown} provider
 * @param {readonly ('toParts' | 'toEpoch' | 'candidates')[]} members - what the call reads
 * @returns {string | null} `a zone provider with <member>(…)`, naming the first member missing
 * @example
 * zoneProviderNeed({ toParts() {} }, ['toParts', 'candidates']);
 * // 'a zone provider with candidates(parts, zone)'
 */
export function zoneProviderNeed(provider, members) {
  for (const member of members) {
    if (provider === null || typeof provider !== 'object'
      || typeof (/** @type {any} */ (provider))[member] !== 'function')
      return `a zone provider with ${ZONE_SEAM[member]}`;
  }
  return null;
}

/**
 * The one rule by which every core layer reads the zone provider a
 * call's options name: `zoneProvider` (the runtime record's own member)
 * or `provider`, its older spelling, kept as an alias; when neither
 * names one, the `runtime` record's `zoneProvider`. The call's own
 * option wins over the record's member, as in every subsystem that takes
 * `runtime`. Both spellings given and different are refused, never
 * guessed between: `refuse` throws the layer's own refusal (the
 * calendar's `JY0014`, the series clock's `TypeError`) with this reason.
 * @param {any} options - a call's options; anything but an object names no provider
 * @param {(reason: string) => never} refuse
 * @returns {any} the provider, or `undefined` (or the `null` given) when none is named
 * @throws {TypeError} for a malformed `runtime`, as {@link createRuntime} does
 * @example
 * zoneProviderOf({ runtime: createRuntime({ zoneProvider }) }, fail) === zoneProvider; // true
 */
export function zoneProviderOf(options, refuse) {
  if (options === null || typeof options !== 'object')
    return undefined;
  const own = options.zoneProvider;
  const alias = options.provider;
  if (own !== undefined && alias !== undefined && own !== alias)
    refuse('zoneProvider and provider, its older spelling, name two different providers');
  const named = own !== undefined ? own : alias;
  if (named !== undefined && named !== null)
    return named;
  if (options.runtime !== undefined) {
    const held = resolveRuntime(options.runtime).zoneProvider;
    if (held !== null)
      return held;
  }
  return named;
}

/**
 * Build a runtime record: the platform defaults, with any member
 * overridden. The result is frozen, so a subsystem that was handed one
 * can hand it on without a copy.
 *
 * The record is closed: a member it does not have is a refusal naming
 * the four it does, because `clock` for `now` quietly ignored would be a
 * deterministic run that is not.
 *
 * @param {Partial<Runtime>} [overrides]
 * @returns {Readonly<Runtime>}
 * @throws {TypeError} for a member that is not a function, a
 *   `zoneProvider` that is neither `null` nor a provider, or a member
 *   the record does not have
 * @example
 * createRuntime();                                  // the platform's own
 * createRuntime({ now: () => 1_700_000_000_000 });  // a fixed clock, the rest default
 * createRuntime({ uuid: () => `id-${++n}`, random: mulberry32(1), zoneProvider });
 */
export function createRuntime(overrides = undefined) {
  if (overrides === undefined || overrides === null)
    return DEFAULT_RUNTIME;
  if (typeof overrides !== 'object')
    throw new TypeError('a runtime record is an object');
  /** @type {any} */
  const record = { ...DEFAULT_RUNTIME };
  for (const key of Object.keys(overrides)) {
    if (!RUNTIME_MEMBERS.includes(key)) {
      throw new TypeError(`a runtime record has ${
        RUNTIME_MEMBERS.map((m) => `'${m}'`).join(', ')}, not '${key}'`);
    }
    const value = /** @type {any} */ (overrides)[key];
    if (value === undefined)
      continue;
    if (key === 'zoneProvider') {
      // the record's readers (a store's query compilation, the series
      // clock) read toEpoch; a calendar call asks for candidates itself
      const need = value === null ? null : zoneProviderNeed(value, ['toParts', 'toEpoch']);
      if (need !== null)
        throw new TypeError(`runtime.zoneProvider is null or ${need}`);
    }
    else if (typeof value !== 'function') {
      throw new TypeError(`runtime.${key} is a function`);
    }
    record[key] = value;
  }
  return Object.freeze(record);
}

/**
 * The record a subsystem reads its `runtime` option through: nothing
 * given is the platform default, and anything given is validated and
 * frozen — so every member a subsystem reads is a function, and a
 * malformed record is refused where it was passed rather than where it
 * was first called.
 * @param {Partial<Runtime> | undefined | null} [candidate] - a subsystem's `options.runtime`
 * @returns {Readonly<Runtime>}
 * @throws {TypeError} as `createRuntime` does
 */
export function resolveRuntime(candidate = undefined) {
  return candidate === DEFAULT_RUNTIME ? DEFAULT_RUNTIME : createRuntime(candidate);
}
