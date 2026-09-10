//@ts-check
/** Offline retained transcript reader; no transport, retry engine or persistence. */
import { compileJsonQuery } from '@jarenjs/json/query';

/**
 * Read a recorded dialect transcript with explicit incomplete observations.
 * Application authority/effect decisions are separate frozen facts. This reader
 * never dispatches writes and cannot qualify a future provider implementation.
 * @param {any} dialect @param {number} [pageLimit]
 */
export function readProviderTranscript(dialect, pageLimit = dialect.pages.length) {
  const extract = compileJsonQuery(dialect.envelope);
  const pages = structuredClone(dialect.pages.slice(0, pageLimit));
  const ids = pages.flatMap((page) => [...extract.items(page)].map((row) => row.id));
  const incomplete = pages.length < dialect.pages.length || pages.some((page) => page.errors?.length);
  return { ids, pages, state: incomplete ? 'incomplete' : 'complete', publishable: !incomplete };
}
