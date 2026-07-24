//@ts-check
/**
 * Hash-route parsing: `#/benchmarks?suite=validate` →
 * `{ page: 'benchmarks', params: { suite: 'validate' } }`. Pure, so the
 * hash subscription (and tests) share it.
 */

const PAGES = new Set(['home', 'playground', 'benchmarks', 'charts', 'docs', 'examples', 'calculator', 'studio']);

/**
 * @param {string} hash - `location.hash` (with or without `#`).
 * @returns {{ page: string, params: Record<string, string> }}
 */
export function parseHash(hash) {
  const raw = (hash ?? '').replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const page = pathPart.replace(/\/+$/, '') || 'home';
  /** @type {Record<string, string>} */
  const params = {};
  if (queryPart !== undefined && queryPart !== '') {
    for (const [key, value] of new URLSearchParams(queryPart)) params[key] = value;
  }
  return { page: PAGES.has(page) ? page : 'home', params };
}
