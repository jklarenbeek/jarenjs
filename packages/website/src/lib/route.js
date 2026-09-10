//@ts-check
/**
 * Hash-route parsing: `#/benchmarks?suite=validate` →
 * `{ page: 'benchmarks', params: { suite: 'validate' } }`. Pure, so the
 * hash subscription (and tests) share it.
 */

// 'scratch', 'examples' and 'playground' stay ONLY as redirect sources
// (→ #/play), and 'studio' as one (→ #/project) — wired in createSiteApp;
// the live surfaces are 'play' and 'project'.
const PAGES = new Set(['home', 'playground', 'benchmarks', 'charts', 'collection', 'docs', 'examples', 'calculator', 'studio', 'project', 'play', 'scratch', 'flow', 'game', 'data']);

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
