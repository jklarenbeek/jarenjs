//@ts-check
/**
 * The live tiers' replay store: one JSON file per remembered reply,
 * under a gitignored directory, behind the `cache` seam both wire
 * clients take. A live run spends two kinds of request — `/embeddings`
 * over a corpus that does not change between runs, and
 * `/chat/completions` over prompts that mostly do not — and buys both
 * again on every run unless something remembers them. This remembers
 * them, and is also the audit trail: every file holds the key it
 * answers (the whole canonical request) beside the value.
 *
 * The file name is the sha256 of the key — a fixed-width id for a key
 * that is a whole conversation long — and the key is kept inside the
 * file, so nothing is ever looked up by a hash alone. `--fresh` on an
 * instrument is an adapter that answers nothing while still remembering
 * what it buys. Delete the directory to start over.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the live tiers remember, relative to the repository root. Gitignored. */
export const REPLAY_CACHE_DIR = 'benchmark/cache/replay';

/**
 * @param {string} dir - the directory; created on the first `set`
 * @param {{ fresh?: boolean }} [options] - `fresh` ignores what is
 *   remembered while still remembering what is bought
 * @returns {import('@jarenjs/ai/client').ReplayCache & { size: () => number, dir: string }}
 */
export function createFileReplayCache(dir, options = {}) {
  const fresh = options.fresh === true;
  /** @param {string} key */
  const fileOf = (key) => join(dir, `${createHash('sha256').update(key, 'utf8').digest('hex')}.json`);
  return {
    dir,
    get(key) {
      if (fresh) return undefined;
      const path = fileOf(key);
      if (!existsSync(path)) return undefined;
      const entry = JSON.parse(readFileSync(path, 'utf8'));
      // a file whose recorded key is not this key would be a hash
      // collision; it is a miss, never someone else's answer
      return entry.key === key ? entry.value : undefined;
    },
    set(key, value) {
      mkdirSync(dir, { recursive: true });
      const path = fileOf(key);
      // written whole, then renamed: a run interrupted mid-write leaves
      // no half file for the next run to read
      writeFileSync(`${path}.tmp`, JSON.stringify({ key, value }));
      renameSync(`${path}.tmp`, path);
    },
    size() {
      return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).length : 0;
    },
  };
}
