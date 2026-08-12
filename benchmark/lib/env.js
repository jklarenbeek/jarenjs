//#region live-model environment
// The ONE place a benchmark reads its live-model configuration from.
// Every live tier in this workspace resolves its provider, model, key
// and spend guards through `readAiEnv` — a second reader would mean two
// ideas of what "no key" means, and the first thing to rot would be the
// skip path nobody runs.
//
// This reads `process.env` and nothing else. The `.env` file is loaded
// by Node itself (`node --env-file-if-exists=.env <entry>`), so there is
// no dotenv dependency here and there must never be one: the suite ships
// zero runtime dependencies outside `@jarenjs/*`, and a benchmark that
// needed a package to start would not be reproducible from a clone.
//
// The contract every live tier obeys:
//   - a missing key is NOT a failure. `live` comes back false with a
//     stated `reason`, the caller prints its model-free tier and exits 0;
//   - the key is never printed, logged or written to a file — only the
//     NAME of the variable it came from;
//   - the spend guards are hard ceilings, not hints. A caller that would
//     exceed one stops with a named reason and keeps its partial work.

/**
 * The environment variables the live tiers read, in the order the
 * key is looked up. `OPENROUTER_AI_KEY` is the repository's name for it
 * (`.env.example`, and the website e2e suite's live AI test already
 * reads it); `OR_KEY` is accepted as an alias so a `.env` written to the
 * shorter name still works.
 */
export const AI_ENV = {
  keys: ['OPENROUTER_AI_KEY', 'OR_KEY'],
  provider: 'JAREN_AI_PROVIDER',
  baseUrl: 'JAREN_AI_BASE_URL',
  model: 'JAREN_AI_MODEL',
  modelStrong: 'JAREN_AI_MODEL_STRONG',
  maxCalls: 'JAREN_AI_MAX_CALLS',
  maxConcurrency: 'JAREN_AI_MAX_CONCURRENCY',
  trials: 'JAREN_AI_TRIALS',
};

/** Providers that run on the machine and need no key. */
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);

/** Spend-guard defaults — deliberately small; `.env` raises them. */
const GUARD_DEFAULTS = { maxCalls: 200, maxConcurrency: 4, trials: 3 };

/**
 * A positive integer from the environment, or the default. A malformed
 * value falls back rather than throwing: a typo in `.env` must not take
 * the model-free tier down with it.
 * @param {string | undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the live-model configuration from the environment.
 *
 * @param {Record<string, string | undefined>} [env] - defaults to `process.env`
 * @returns {{ live: boolean, reason: string | null, provider: string,
 *   baseUrl: string | undefined, apiKey: string, keySource: string | null,
 *   model: string, modelStrong: string, maxCalls: number,
 *   maxConcurrency: number, trials: number }}
 *   `live` is false when no call can be made; `reason` then says why, in
 *   words meant for a run log. `apiKey` is '' when absent and is never
 *   safe to print — `keySource` names the variable it came from instead.
 */
export function readAiEnv(env = process.env) {
  let apiKey = '';
  let keySource = null;
  for (const name of AI_ENV.keys) {
    const value = (env[name] ?? '').trim();
    if (value !== '') {
      apiKey = value;
      keySource = name;
      break;
    }
  }

  const provider = (env[AI_ENV.provider] ?? '').trim() || 'openrouter';
  const baseUrl = (env[AI_ENV.baseUrl] ?? '').trim();
  const model = (env[AI_ENV.model] ?? '').trim();
  const local = LOCAL_PROVIDERS.has(provider);

  let reason = null;
  if (apiKey === '' && !local) {
    reason = `no key — set ${AI_ENV.keys[0]} in .env (see .env.example)`;
  }
  else if (model === '') {
    reason = `no model — set ${AI_ENV.model} in .env (see .env.example)`;
  }

  return {
    live: reason === null,
    reason,
    provider,
    baseUrl: baseUrl === '' ? undefined : baseUrl,
    apiKey,
    keySource,
    model,
    modelStrong: (env[AI_ENV.modelStrong] ?? '').trim() || model,
    maxCalls: positiveInt(env[AI_ENV.maxCalls], GUARD_DEFAULTS.maxCalls),
    maxConcurrency: positiveInt(env[AI_ENV.maxConcurrency], GUARD_DEFAULTS.maxConcurrency),
    trials: positiveInt(env[AI_ENV.trials], GUARD_DEFAULTS.trials),
  };
}

/**
 * A one-line, key-free summary of a resolved configuration — what a run
 * log may print. The key itself never appears; only the variable that
 * supplied it, so a published number can be attributed without leaking
 * anything.
 * @param {ReturnType<typeof readAiEnv>} config
 * @returns {string}
 */
export function describeAiEnv(config) {
  const key = config.keySource === null ? 'no key' : `key from ${config.keySource}`;
  return `${config.provider} · ${config.model || '(no model)'} · ${key}`
    + ` · ${config.trials} trials/row · ceilings ${config.maxCalls} calls,`
    + ` ${config.maxConcurrency} concurrent`;
}

/**
 * Run `task` over `items` with at most `limit` in flight, preserving
 * input order in the result. The spend guard `JAREN_AI_MAX_CONCURRENCY`
 * is what this exists to honour — a fan-out that ignored it would be a
 * bill, not a benchmark.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} task
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, task) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length)))
    .fill(null)
    .map(async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        out[index] = await task(items[index], index);
      }
    });
  await Promise.all(workers);
  return out;
}

//#endregion
