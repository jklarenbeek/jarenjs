//@ts-check
/** File identity and fail-closed evidence checks for the portable instrument. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Hash exact bytes, without normalizing whitespace or line endings.
 * @param {string | Uint8Array} bytes */
export function adoptionHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** Read an artifact relative to this module, never a private checkout path.
 * @param {string} name @returns {any} */
export function readAdoption(name) {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
}

/** Verify frozen artifacts and all finite budgets before admitting measurements.
 * @param {any} manifest */
export function verifyFreeze(manifest) {
  for (const [path, expected] of Object.entries(manifest.artifacts)) {
    if (adoptionHash(readFileSync(new URL(`../../${path}`, import.meta.url))) !== expected)
      throw new Error(`frozen artifact changed: ${path}`);
  }
  const { freezeHash, ...payload } = manifest;
  if (adoptionHash(JSON.stringify(payload)) !== freezeHash) throw new Error('manifest freeze changed');
  for (const consumer of manifest.consumers) {
    for (const [stage, limits] of Object.entries(consumer.budgets)) {
      for (const [metric, value] of Object.entries(limits)) {
        if (!Number.isFinite(value) || value < 0) throw new Error(`non-finite budget: ${stage}.${metric}`);
      }
    }
  }
}

/** Missing measurements never pass, including on a host that ran other legs.
 * @param {Record<string, number>} limits @param {Record<string, number | null>} measured */
export function assessBudget(limits, measured) {
  return Object.entries(limits).map(([metric, limit]) => {
    const value = measured[metric];
    return { metric, limit, value: value ?? null,
      status: value == null ? 'pending' : !Number.isFinite(value) || value < 0 || value > limit ? 'fail' : 'pass' };
  });
}

/** Retirement requires every separately named evidence class, without vacuous truth.
 * @param {any} evidence */
export function replacementReady(evidence) {
  return ['library', 'portableConsumer', 'liveHost', 'manualOperator']
    .every((key) => evidence[key] === 'pass');
}
