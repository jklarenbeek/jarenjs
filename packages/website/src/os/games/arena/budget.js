//@ts-check
/**
 * The dynamic tool-call budget, as a pure model the Arena races.
 *
 * A language model hands its work to the OS through tool calls whose
 * arguments are JSON, and a small model loses its grip on a long
 * argument — a bracket left open, a string cut short — long before a
 * bigger model does. So the OS cuts a big argument into chunks whose
 * size is a per-model setting, the tool-call budget, in five tiers from
 * `tiny` (300 characters a call) to `unlimited` (the whole document in
 * one call). Too small a budget pays the round trip of every call; too
 * large a budget pays for the calls that fail and must be sent again.
 *
 * One call of `chars` characters comes back whole with the chance
 *
 *     P(ok | chars) = 1 / (1 + (chars / c50) ^ k)
 *
 * — even odds at `c50` characters, falling away steeply past it — and
 * costs a base latency (the round trip and the prompt) plus a time per
 * character (the decoding). A failed call is retried; a chunk that fails
 * `MAX_TRIES` times in a row makes the lane give up, as an agent would.
 * `raceToolBudgets` runs one lane per tier delivering the same document
 * and ranks them by when they finished: the race the Arena animates, and
 * the table the OS shows when it tunes a model's budget.
 *
 * Deterministic: every lane draws from the same seeded stream — common
 * random numbers, so two tiers that cut the document the same way meet
 * the same luck and finish together — and no draw is left unseeded.
 */

import { mulberry32 } from '@jarenjs/core/random';

/**
 * @typedef {'tiny' | 'small' | 'medium' | 'large' | 'unlimited'} TierId
 * @typedef {{ id: TierId, chars: number | null }} Tier - `chars: null` sends everything in one call
 * @typedef {{ id: string, label: string, c50: number, k: number, baseMs: number, charMs: number }} Profile
 * @typedef {{ at: number, ms: number, size: number, ok: boolean }} Call - one simulated call: start, duration, characters
 * @typedef {{ tier: TierId, budget: number | null, calls: Call[], delivered: number, failures: number,
 *   finished: boolean, ms: number }} Lane - `ms`: the simulated time the lane finished or gave up at
 * @typedef {{ profile: string, chars: number, seed: number, lanes: Lane[], ranking: TierId[],
 *   recommended: TierId, endMs: number }} BudgetRace
 *   - `ranking`: finishers by time, then the rest by how far they got; `endMs`: when the podium was decided
 */

/** The budget tiers, smallest first: the characters one call may carry. */
export const TIERS = /** @type {readonly Tier[]} */ (Object.freeze([
  Object.freeze({ id: 'tiny', chars: 300 }),
  Object.freeze({ id: 'small', chars: 600 }),
  Object.freeze({ id: 'medium', chars: 2400 }),
  Object.freeze({ id: 'large', chars: 12000 }),
  Object.freeze({ id: 'unlimited', chars: null }),
]));

/**
 * The model profiles. `c50` is where half the calls of that length fail;
 * the timings are about four characters a token: a mixture-of-experts
 * model with three billion active parameters decodes fast but frays
 * early, a dense 27B model holds a longer argument and decodes slowly, a
 * frontier model holds nearly anything.
 * @type {Readonly<Record<string, Readonly<Profile>>>}
 */
export const PROFILES = Object.freeze({
  'moe-3b-active': Object.freeze({ id: 'moe-3b-active', label: 'MoE 3B active', c50: 700, k: 3, baseMs: 700, charMs: 3 }),
  'dense-27b': Object.freeze({ id: 'dense-27b', label: 'Dense 27B', c50: 4000, k: 3, baseMs: 1200, charMs: 8 }),
  frontier: Object.freeze({ id: 'frontier', label: 'Frontier', c50: 40000, k: 3, baseMs: 1500, charMs: 4 }),
});

/** Tries one chunk gets before its lane gives up on the document. */
export const MAX_TRIES = 8;

/**
 * True when a value names one of the profiles.
 * @param {unknown} id @returns {id is string}
 */
export const isProfile = (id) => typeof id === 'string' && Object.hasOwn(PROFILES, id);

/**
 * A profile by id (or the profile itself).
 * @param {string | Profile} profile @returns {Profile}
 */
export function profileOf(profile) {
  if (typeof profile !== 'string') return profile;
  if (!isProfile(profile)) throw new RangeError(`unknown model profile ${profile}`);
  return PROFILES[profile];
}

/**
 * A tier by id.
 * @param {string} id @returns {Tier | undefined}
 */
export const tierOf = (id) => TIERS.find((t) => t.id === id);

/**
 * The chance one call of `chars` characters comes back whole.
 * @param {string | Profile} profile @param {number} chars @returns {number}
 */
export function successChance(profile, chars) {
  const p = profileOf(profile);
  if (chars <= 0) return 1;
  return 1 / (1 + Math.pow(chars / p.c50, p.k));
}

/**
 * Whether one call succeeds, for a uniform draw `u` in [0, 1): the
 * reliability curve cut at the draw.
 * @param {string | Profile} profile @param {number} chars @param {number} u
 * @returns {boolean}
 */
export function callSucceeds(profile, chars, u) {
  return u < successChance(profile, chars);
}

/**
 * The chunk a tier cuts a document of `chars` characters into.
 * @param {Tier} tier @param {number} chars
 */
export const chunkOf = (tier, chars) => (tier.chars === null ? chars : Math.min(tier.chars, chars));

/**
 * One lane: send the document chunk by chunk, retrying failures, until
 * it is delivered or one chunk has failed `MAX_TRIES` times.
 * @param {Profile} profile @param {Tier} tier @param {number} chars @param {number} seed
 * @returns {Lane}
 */
function runLane(profile, tier, chars, seed) {
  const random = mulberry32(seed);
  const chunk = chunkOf(tier, chars);
  /** @type {Call[]} */
  const calls = [];
  let at = 0;
  let delivered = 0;
  let failures = 0;
  let tries = 0;
  while (delivered < chars && tries < MAX_TRIES) {
    const size = Math.min(chunk, chars - delivered);
    const ms = profile.baseMs + size * profile.charMs;
    const ok = callSucceeds(profile, size, random());
    calls.push({ at, ms, size, ok });
    at += ms;
    if (ok) {
      delivered += size;
      tries = 0;
    }
    else {
      failures += 1;
      tries += 1;
    }
  }
  return { tier: tier.id, budget: tier.chars, calls, delivered, failures, finished: delivered >= chars, ms: at };
}

/**
 * Finishers first, by time; then the lanes that gave up, by how far they
 * got. Ties keep tier order, so of two budgets that did the same the
 * smaller one ranks first — it also cuts the next, bigger document.
 * @param {Lane} a @param {Lane} b
 */
function byFinish(a, b) {
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  return a.finished ? a.ms - b.ms : b.delivered - a.delivered;
}

/**
 * The whole race at once: every tier delivers the same document for the
 * same model, and the best budget is the one that finished first.
 * @param {string | Profile} profile @param {number} chars @param {number} seed
 * @returns {BudgetRace}
 */
export function raceToolBudgets(profile, chars, seed) {
  const p = profileOf(profile);
  const total = Math.max(1, Math.round(chars));
  const lanes = TIERS.map((tier) => runLane(p, tier, total, seed >>> 0));
  const ranked = lanes.slice().sort(byFinish);
  const finishers = ranked.filter((l) => l.finished);
  // the race is decided once the podium is: the third finisher, or the
  // last one when fewer finish; with no finisher, when the last gives up
  const endMs = finishers.length > 0
    ? finishers[Math.min(2, finishers.length - 1)].ms
    : Math.max(...lanes.map((l) => l.ms));
  return { profile: p.id, chars: total, seed: seed >>> 0, lanes, ranking: ranked.map((l) => l.tier), recommended: ranked[0].tier, endMs };
}

/**
 * How far a lane has carried the document at simulated time `t`, in
 * [0, 1]: the chunks delivered, plus most of the one in flight — a
 * failing call carries its runner forward and then drops it back.
 * @param {Lane} lane @param {number} chars @param {number} t
 */
export function laneProgress(lane, chars, t) {
  let done = 0;
  for (const call of lane.calls) {
    if (call.at >= t) break;
    if (call.at + call.ms > t) return Math.min(1, (done + call.size * 0.92 * ((t - call.at) / call.ms)) / chars);
    if (call.ok) done += call.size;
  }
  return Math.min(1, done / chars);
}
