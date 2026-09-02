//@ts-check
/**
 * @file Version compatibility — the one implementation of the
 * negotiation rule (docs/CONTRACT-FORMAT.md §10.4, §13): two ends
 * speak when they declare the same `version`, or when either end's
 * `compat` list names the other's `version`. The client's `negotiate()`
 * and any server that wants to refuse an incompatible peer both call
 * this; `diffContracts` is the complementary question (WHAT changed),
 * this is the declared answer (do the authors CLAIM the ends speak).
 */

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
 * `'server-accepts'` (the server's `compat` names the client's version),
 * `'client-accepts'` (the client's `compat` names the server's version).
 * Checked in that order, so the strongest claim wins the reason.
 * @param {VersionedContract} client
 * @param {VersionedContract} server
 * @returns {'same-version' | 'server-accepts' | 'client-accepts' | null}
 */
export function compatReason(client, server) {
  const c = identity(client);
  const s = identity(server);
  if (s.version === c.version) return 'same-version';
  if (c.version !== null && s.compat.includes(c.version)) return 'server-accepts';
  if (s.version !== null && c.compat.includes(s.version)) return 'client-accepts';
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
