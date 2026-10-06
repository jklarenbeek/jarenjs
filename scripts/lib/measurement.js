//@ts-check
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Refuse a measurement whose declared repository inputs have changed.
 * @param {Record<string, string>} sources
 * @param {(file: string) => string} message
 */
export function assertMeasurementSources(sources, message) {
  for (const [file, hash] of Object.entries(sources)) {
    const bytes = readFileSync(new URL(`../../${file}`, import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(message(file));
  }
}
