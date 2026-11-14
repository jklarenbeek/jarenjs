//@ts-check
/**
 * Hash-route parsing: `#/benchmarks?suite=validate` →
 * `{ page: 'benchmarks', params: { suite: 'validate' } }`. Pure, so the
 * hash subscription (and tests) share it.
 */

// 'scratch', 'examples' and 'playground' stay ONLY as redirect sources
// (→ #/play), and 'studio' as one (→ #/project) — wired in createSiteApp;
// the live surfaces are 'play' and 'project'.
const PAGES = new Set(['home', 'playground', 'benchmarks', 'charts', 'collection', 'docs', 'examples', 'calculator', 'studio', 'project', 'play', 'scratch', 'flow', 'data']);

/**
 * @param {string} hash - `location.hash` (with or without `#`).
 * @returns {{ page: string, params: Record<string, string> }}
 */
export function parseHash(hash) {
  const raw = (hash ?? '').replace(/^#\/?/, '');
  // the query is everything after the FIRST '?': a later one is part of a value
  const split = raw.indexOf('?');
  const pathPart = split < 0 ? raw : raw.slice(0, split);
  const queryPart = split < 0 ? undefined : raw.slice(split + 1);
  const page = pathPart.replace(/\/+$/, '') || 'home';
  /** @type {Record<string, string>} */
  const params = {};
  if (queryPart !== undefined && queryPart !== '') {
    for (const [key, value] of new URLSearchParams(queryPart)) params[key] = value;
  }
  return { page: PAGES.has(page) ? page : 'home', params };
}

/**
 * The hash of a parsed route without one of its params — how a link
 * param that applies once (`?lang=`) leaves the address bar, so a reload
 * keeps what the reader chose since.
 * @param {{ page: string, params: Record<string, string> }} route
 * @param {string} name - the param to drop
 * @returns {string}
 */
export function hashWithout(route, name) {
  const query = new URLSearchParams(Object.entries(route.params).filter(([key]) => key !== name)).toString();
  return `#/${route.page === 'home' ? '' : route.page}${query === '' ? '' : `?${query}`}`;
}
