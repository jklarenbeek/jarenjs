//@ts-check
/**
 * @file Version compatibility — the one implementation of the
 * negotiation rule (docs/CONTRACT-FORMAT.md §10.4, §13): two ends
 * speak when they declare the same `version`, or when either end's
 * `compat` list accepts the other's `version` — naming it exactly, or
 * through a range (`^1`, `~1.4`, `>=1.2.0`) when that version is numeric
 * (`MAJOR[.MINOR[.PATCH]]`). The client's `negotiate()` and any server
 * that wants to refuse an incompatible peer both call this;
 * `diffContracts` is the complementary question (WHAT changed), this is
 * the declared answer (do the authors CLAIM the ends speak).
 */

/** A numeric version: `MAJOR[.MINOR[.PATCH]]`, no prerelease or build. */
const NUMERIC = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)?$/;

/** A range: `^M[.m[.p]]`, `~M.m[.p]` or `>=M[.m[.p]]`. */
const RANGE = /^(\^|~|>=)((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?)?)$/;

/**
 * The parts of a numeric version, missing ones 0, with how many were written.
 * @param {string} version
 * @returns {{ parts: [number, number, number], written: number } | null}
 */
function numeric(version) {
  const m = NUMERIC.exec(version);
  if (m === null) return null;
  const written = m[3] !== undefined ? 3 : m[2] !== undefined ? 2 : 1;
  return { parts: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], written };
}

/**
 * Whether a version is numeric (`MAJOR[.MINOR[.PATCH]]`) — what a `compat`
 * range can be written beside, and satisfied by.
 * @param {unknown} version
 * @returns {boolean}
 */
export function isNumericVersion(version) {
  return typeof version === 'string' && NUMERIC.test(version);
}

/**
 * Compare two version triples.
 * @param {readonly number[]} a
 * @param {readonly number[]} b
 */
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Whether a `compat` entry is a range (`^`, `~` or `>=` followed by a
 * numeric version) rather than an exact version string, and whether it
 * is well formed. `~` needs a minor (`~1.4`, `~1.4.2`).
 * @param {string} entry
 * @returns {'exact' | 'range' | 'malformed'}
 */
export function compatEntryKind(entry) {
  if (!/^(\^|~|>=)/.test(entry)) return 'exact';
  const m = RANGE.exec(entry);
  if (m === null) return 'malformed';
  if (m[1] === '~' && !m[2].includes('.')) return 'malformed';
  return 'range';
}

/**
 * Whether `version` satisfies the range `entry` — npm's semantics:
 * `^` allows changes that keep the left-most non-zero part (`^1.2` is
 * `>=1.2.0 <2.0.0`, `^0.3` is `>=0.3.0 <0.4.0`), `~` keeps the minor
 * (`~1.4` is `>=1.4.0 <1.5.0`), `>=` is a floor. A version that is not
 * numeric satisfies no range.
 * @param {string} entry
 * @param {string} version
 * @returns {boolean}
 */
export function satisfiesRange(entry, version) {
  if (compatEntryKind(entry) !== 'range') return false;
  const v = numeric(version);
  if (v === null) return false;
  const op = entry.startsWith('>=') ? '>=' : entry[0];
  const base = /** @type {{ parts: [number, number, number], written: number }} */ (numeric(entry.slice(op.length)));
  const [M, m, p] = base.parts;
  if (compare(v.parts, base.parts) < 0) return false;
  if (op === '>=') return true;
  /** @type {[number, number, number]} */
  let upper;
  if (op === '~') upper = [M, m + 1, 0];
  else if (M > 0) upper = [M + 1, 0, 0];
  else if (base.written >= 2 && m > 0) upper = [0, m + 1, 0];
  else if (base.written === 3) upper = [0, 0, p + 1];
  else if (base.written === 2) upper = [0, 1, 0];
  else upper = [1, 0, 0];
  return compare(v.parts, upper) < 0;
}

/**
 * Whether a `compat` list accepts a version: an exact entry naming it,
 * or a range it satisfies.
 * @param {readonly string[]} compat
 * @param {string} version
 */
function accepts(compat, version) {
  for (const entry of compat) {
    if (entry === version) return true;
    if (compatEntryKind(entry) === 'range' && satisfiesRange(entry, version)) return true;
  }
  return false;
}

/**
 * The version identity the rule reads — a compiled contract, a contract
 * document, or a well-known description all carry these two members.
 * @typedef {{ version?: string | null, compat?: readonly string[] | null }} VersionedContract
 */

/**
 * @param {VersionedContract} value
 * @returns {{ version: string | null, compat: readonly string[] }}
 */
function identity(value) {
  const version = typeof value.version === 'string' ? value.version : null;
  const compat = Array.isArray(value.compat)
    ? value.compat.filter((/** @type {unknown} */ v) => typeof v === 'string')
    : [];
  return { version, compat };
}

/**
 * Why two ends are compatible, or `null` when they are not:
 * `'same-version'` (equal `version`s — two unversioned contracts included),
 * `'server-accepts'` (the server's `compat` names or ranges over the
 * client's version), `'client-accepts'` (the client's `compat` names or
 * ranges over the server's version).
 * Checked in that order, so the strongest claim wins the reason.
 * @param {VersionedContract} client
 * @param {VersionedContract} server
 * @returns {'same-version' | 'server-accepts' | 'client-accepts' | null}
 */
export function compatReason(client, server) {
  const c = identity(client);
  const s = identity(server);
  if (s.version === c.version) return 'same-version';
  if (c.version !== null && accepts(s.compat, c.version)) return 'server-accepts';
  if (s.version !== null && accepts(c.compat, s.version)) return 'client-accepts';
  return null;
}

/**
 * Whether a client contract and a server contract declare themselves
 * compatible — the negotiation rule as a predicate. Takes compiled
 * contracts, raw documents or well-known descriptions alike (it reads
 * only `version` and `compat`).
 * @param {VersionedContract} clientContract
 * @param {VersionedContract} serverContract
 * @returns {boolean}
 * @example
 * isCompatible({ version: '5', compat: ['4'] }, { version: '4' }); // true — the client accepts 4
 */
export function isCompatible(clientContract, serverContract) {
  return compatReason(clientContract, serverContract) !== null;
}
