//@ts-check
/**
 * Grading: the skill ladder every part of the OS reports into. It is the
 * ladder *Monkey Grove* teaches arithmetic with, applied to everything
 * else a person learns here — running the machine, governing the council,
 * contracts, documents, data, apps, working with a language model, and
 * the Turing puzzles: a one-sided Elo rating per skill (items have fixed
 * difficulties and are never re-rated), new skills move fast and settle
 * after twenty attempts, a hinted success counts for less, and the next
 * challenge is aimed where the expected success is about two in three —
 * hard enough to be worth it, easy enough to keep going.
 *
 * Experience points sit on top: every finished step of anything earns
 * some, and ranks named after the life of a street mural mark the way.
 */

/** The ladder's constants. */
export const LADDER = Object.freeze({ start: 600, mastery: 850, masteryAccuracy: 0.8, masteryAttempts: 10, newK: 32, settledK: 16, settledAfter: 20, hinted: 0.7, offset: 108, history: 10 });

/** Developer skills: what the coach's quests teach. */
export const SKILLS = Object.freeze([
  { id: 'machine', name: 'Turing machine' },
  { id: 'council', name: 'Governance' },
  { id: 'contracts', name: 'Contracts' },
  { id: 'documents', name: 'Documents' },
  { id: 'data', name: 'Data' },
  { id: 'apps', name: 'Apps' },
  { id: 'ai', name: 'Working with models' },
  { id: 'turing', name: 'Turing puzzles' },
  { id: 'math', name: 'Arithmetic' },
]);

/** Ranks by experience, in the life of a mural. */
export const RANKS = Object.freeze([
  { xp: 0, title: 'Chalk' },
  { xp: 60, title: 'Sketch' },
  { xp: 180, title: 'Tag' },
  { xp: 400, title: 'Spray' },
  { xp: 800, title: 'Mural' },
  { xp: 1500, title: 'Subway legend' },
  { xp: 3000, title: 'Radiant' },
]);

/**
 * @typedef {{ r: number, n: number, hist: number[] }} SkillRating
 * @typedef {{ xp: number, skills: Record<string, SkillRating>, badges: string[] }} Profile
 */

/** A newcomer. @returns {Profile} */
export function emptyProfile() {
  return { xp: 0, skills: {}, badges: [] };
}

/**
 * The chance a player rated `r` meets an item of difficulty `d`.
 * @param {number} r @param {number} d
 */
export function expected(r, d) {
  return 1 / (1 + 10 ** ((d - r) / 400));
}

/** @param {Profile} profile @param {string} skill @returns {SkillRating} */
export function ratingOf(profile, skill) {
  return profile.skills[skill] ?? { r: LADDER.start, n: 0, hist: [] };
}

/**
 * Score one attempt.
 * @param {Profile} profile
 * @param {{ skill: string, correct: boolean, difficulty: number, hinted?: boolean }} attempt
 * @returns {{ profile: Profile, delta: number, mastered: boolean }}
 */
export function rate(profile, attempt) {
  const s = ratingOf(profile, attempt.skill);
  const k = s.n < LADDER.settledAfter ? LADDER.newK : LADDER.settledK;
  const score = attempt.correct ? (attempt.hinted ? LADDER.hinted : 1) : 0;
  const delta = k * (score - expected(s.r, attempt.difficulty));
  const next = { r: s.r + delta, n: s.n + 1, hist: [...s.hist, attempt.correct ? 1 : 0].slice(-LADDER.history) };
  const updated = { ...profile, skills: { ...profile.skills, [attempt.skill]: next } };
  return { profile: updated, delta, mastered: isMastered(next) };
}

/** @param {SkillRating} s */
export function isMastered(s) {
  return s.r >= LADDER.mastery && s.n >= LADDER.masteryAttempts && s.hist.length >= LADDER.history
    && s.hist.reduce((a, b) => a + b, 0) / s.hist.length >= LADDER.masteryAccuracy;
}

/**
 * The difficulty to aim the next challenge of a skill at: about 65 %
 * expected success.
 * @param {Profile} profile @param {string} skill
 */
export function targetDifficulty(profile, skill) {
  return ratingOf(profile, skill).r - LADDER.offset;
}

/**
 * Of a set of challenges, the one closest to the target difficulty.
 * @template {{ skill: string, difficulty: number }} T
 * @param {Profile} profile @param {readonly T[]} items @returns {T | null}
 */
export function pickChallenge(profile, items) {
  let best = null;
  let gap = Infinity;
  for (const item of items) {
    const g = Math.abs(item.difficulty - targetDifficulty(profile, item.skill));
    if (g < gap) { gap = g; best = item; }
  }
  return best;
}

/**
 * The rank of an experience total, and how far into the next.
 * @param {number} xp
 * @returns {{ title: string, level: number, next: string | null, progress: number }}
 */
export function rankOf(xp) {
  let level = 0;
  while (level + 1 < RANKS.length && xp >= RANKS[level + 1].xp) level++;
  const here = RANKS[level];
  const there = RANKS[level + 1];
  return {
    title: here.title,
    level,
    next: there?.title ?? null,
    progress: there ? Math.max(0, Math.min(1, (xp - here.xp) / (there.xp - here.xp))) : 1,
  };
}

/**
 * Earn experience (and a badge, once).
 * @param {Profile} profile @param {number} amount @param {string} [badge]
 * @returns {{ profile: Profile, rankUp: boolean }}
 */
export function award(profile, amount, badge) {
  const xp = profile.xp + Math.max(0, Math.round(amount));
  const badges = badge && !profile.badges.includes(badge) ? [...profile.badges, badge] : profile.badges;
  return { profile: { ...profile, xp, badges }, rankUp: rankOf(xp).level > rankOf(profile.xp).level };
}

/**
 * Whether a value is a profile this OS can restore.
 * @param {any} value @returns {value is Profile}
 */
export function isProfile(value) {
  return Boolean(value) && Number.isInteger(value.xp) && value.xp >= 0 && Array.isArray(value.badges)
    && value.badges.every((/** @type {unknown} */ b) => typeof b === 'string')
    && value.skills && typeof value.skills === 'object'
    && Object.values(value.skills).every((/** @type {any} */ s) => s && Number.isFinite(s.r) && Number.isInteger(s.n) && Array.isArray(s.hist));
}
