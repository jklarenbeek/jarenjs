//@ts-check
/**
 * @file The derivation runner: one marker namespace, one bake, several
 * registries.
 *
 * A figure or a table that a machine derives and a human reads lives in
 * the committed document between `<!--fact:key-->` … `<!--/fact-->`
 * markers (`@jarenjs/md`'s `bake`). What VARIES between derivations is
 * the source — committed benchmark measurements, a bundle baseline, the
 * pen documents themselves — and that belongs to a registry. What must
 * NOT vary is the marker grammar, and this file is why.
 *
 * The repository learned that the hard way, with three spellings for one
 * idea. The worst of them was not a directive at all: an unpaired
 * `<!--bundle:linq-schema-->` anchor read by a bespoke regex, in a
 * namespace the directive scanner never saw — so it had no pairing
 * check, no orphan report, no line-start diagnostic and no bake, and the
 * figures behind it went stale in silence. The other two were real
 * directives in two namespaces, which is better and still not right:
 * `scanSourceDirectives` pairs within ONE namespace, so
 *
 *  - a marker in a namespace no runner scans (a typo'd `<!--facts:…-->`)
 *    is inert and invisible to every gate, where a typo'd KEY is caught
 *    at once, and
 *  - two namespaces interleaved in one paragraph pair cleanly in each
 *    scan taken alone and yield two overlapping bodies that corrupt each
 *    other on the second bake.
 *
 * One namespace closes both. Registries stay separate because their
 * SOURCES are: two derivations over two different inputs is right, and
 * one script doing both is not.
 *
 * A registry is `{ name, docs(root), facts(text) }` — the documents it
 * reads and may write, and the derivations it answers, keyed by marker.
 * `docs` is a function so a registry can enumerate a directory rather
 * than carry a list: the pen index IS the directory listing, and a
 * hard-coded list is how a new document comes to be unreachable.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bake, scanSourceDirectives } from '@jarenjs/md';

/** The one namespace. Every derived span in every committed document. */
export const NS = 'fact';

/**
 * @typedef {object} Registry
 * @property {string} name - what it derives from, for a collision message
 * @property {(root: string) => string[]} docs - repo-relative paths
 * @property {(text: Map<string, string>) => Record<string, () => string>} facts
 */

/**
 * @typedef {object} DeriveReport
 * @property {number} code - 0 green, 1 failed
 * @property {string[]} unanswered - markers no registry could answer
 * @property {string[]} drift - baked text the sources no longer agree with
 * @property {string[]} unused - derivations no document carries
 * @property {string[]} seen - the derivations that resolved
 * @property {number} passes - bake passes needed to settle
 * @property {string[]} rewritten - documents written (write mode only)
 * @property {number} documents - documents walked
 */

/** How many bake passes a settled derivation may need. See below. */
const MAX_PASSES = 4;

/**
 * Merge every registry's derivations into one table, refusing a key two
 * registries both claim. Two answers to one question is the failure this
 * whole layer exists to prevent, and it is cheapest to catch here.
 * @param {Registry[]} registries @param {Map<string, string>} text
 */
function mergeFacts(registries, text) {
  /** @type {Record<string, () => string>} */
  const facts = {};
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const registry of registries) {
    for (const [key, derive] of Object.entries(registry.facts(text))) {
      const claimed = owner.get(key);
      if (claimed !== undefined) {
        throw new Error(`two registries derive '${key}': ${claimed} and ${registry.name}`);
      }
      owner.set(key, registry.name);
      facts[key] = derive;
    }
  }
  return facts;
}

/**
 * Bake (or check) every `fact:` marker in every registry's documents.
 *
 * Three failure modes, and they are not the same failure. Text whose
 * source has MOVED is the gate's daily work: `--check` reports it, the
 * write mode fixes it. A marker no registry ANSWERS — or one whose
 * derivation throws because the file it reads was never regenerated — is
 * not repairable by rewriting, so it fails both modes and fails BEFORE
 * anything is written, or the run would report success over a block
 * still carrying last month's value. A marker the renderer will never
 * see (one that starts a line inside a paragraph, opening an HTML block
 * that swallows the rest of it) bakes correctly and then disappears from
 * every rendered page, so `bake` reports it and it counts as unanswered
 * too.
 *
 * The bake runs to a fixed point rather than once, because a derivation
 * may read something the bake itself changes: the pen index states every
 * document's line count, and the binder is one of those documents. Digits
 * do not change how many lines a table has, so the second pass settles
 * and the third confirms; a run that has not settled by the fourth is a
 * derivation that is not a function of its inputs, and it raises rather
 * than writing.
 *
 * @param {{ root: string, registries: Registry[], check?: boolean }} options
 * @returns {DeriveReport}
 */
export function runDerivation(options) {
  const { root, registries } = options;
  const check = options.check ?? false;
  /** @type {string[]} */
  const unanswered = [];
  const seen = new Set();

  const docs = [...new Set(registries.flatMap((registry) => registry.docs(root)))];
  /** @type {Map<string, string>} */
  const sources = new Map(docs.map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]));

  let current = sources;
  let passes = 0;
  for (; passes < MAX_PASSES; passes++) {
    const facts = mergeFacts(registries, current);
    seen.clear();
    /** @type {Map<string, string>} */
    const next = new Map();
    let changed = false;
    for (const [rel, text] of current) {
      const result = bake(text, {
        ns: NS,
        resolve: (key) => {
          if (facts[key] === undefined) {
            if (passes === 0) {
              unanswered.push(`${rel}: nothing derives '${key}'`);
            }
            return undefined;
          }
          const value = facts[key]();
          // counted only once the derivation ANSWERED: one whose source
          // is missing throws, and counting it here would let the
          // success line report a coverage the run did not have
          seen.add(key);
          return value;
        },
      });
      if (passes === 0) {
        for (const message of result.diagnostics) unanswered.push(`${rel}: ${message}`);
      }
      next.set(rel, result.text);
      if (result.changed) changed = true;
    }
    current = next;
    if (!changed) break;
  }
  if (passes === MAX_PASSES) {
    throw new Error(`the documents did not settle in ${MAX_PASSES} bake passes — a derivation `
      + 'is reading something its own output changes');
  }

  // The two scans of one file correspond position for position: `bake`
  // only ever splices bodies, so text that moved is the same directive.
  /** @type {string[]} */
  const drift = [];
  for (const [rel, source] of sources) {
    const was = scanSourceDirectives(source, { ns: NS }).directives;
    const now = scanSourceDirectives(/** @type {string} */ (current.get(rel)), { ns: NS }).directives;
    for (const [i, directive] of was.entries()) {
      if (now[i]?.body === directive.body) continue;
      drift.push(`${rel}: ${directive.key} — the source no longer agrees with the baked text`);
    }
  }

  const unused = Object.keys(mergeFacts(registries, current)).filter((key) => !seen.has(key));

  /** @type {string[]} */
  const rewritten = [];
  if (unanswered.length === 0 && !check) {
    for (const [rel, text] of current) {
      if (text === sources.get(rel)) continue;
      writeFileSync(join(root, rel), text);
      rewritten.push(rel);
    }
  }
  const failed = unanswered.length > 0 || (check && (drift.length > 0 || unused.length > 0));
  return {
    code: failed ? 1 : 0,
    unanswered,
    drift,
    unused,
    seen: [...seen],
    passes: passes + 1,
    rewritten,
    documents: docs.length,
  };
}

/**
 * The CLI both modes share, so a caller is one line and the two modes
 * cannot drift apart in their reporting.
 * @param {{ root: string, registries: Registry[], argv: string[] }} options
 */
export function main({ root, registries, argv }) {
  const check = argv.includes('--check');
  const report = runDerivation({ root, registries, check });

  if (report.unanswered.length > 0) {
    console.error(`markers nothing can answer (${report.unanswered.length}):`
      + `\n\n${report.unanswered.join('\n')}\n`);
    console.error('nothing was rewritten: repair the source each derivation reads, '
      + 'or remove the marker.');
  }
  else if (check) {
    const stale = [...report.drift, ...(report.unused.length > 0
      ? [`derivations no document carries: ${report.unused.join(', ')}`] : [])];
    if (stale.length > 0) {
      console.error(`derived text is stale (${stale.length}):\n\n${stale.join('\n')}\n`);
      console.error('run `npm run docs:derive` to rewrite it from the sources.');
    }
    else {
      console.log(`derived text current (${report.seen.length} derivations across `
        + `${report.documents} documents).`);
    }
  }
  else {
    console.log(`derived text: ${report.seen.length} derivations, `
      + `${report.rewritten.length} document(s) rewritten (${report.passes} pass`
      + `${report.passes === 1 ? '' : 'es'}).`);
    if (report.unused.length > 0) console.warn(`WARNING: ${report.unused.join(', ')}`);
  }
  return report.code;
}
