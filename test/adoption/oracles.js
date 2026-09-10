//@ts-check
/** Retained implementations, exclusively in development tooling. */
import MiniSearch from 'minisearch';
import { Virtualizer } from '@tanstack/virtual-core';
import { adoptionKey } from '../../scripts/lib/adoption.js';

/** The application's explicit text decoding hook, shared by build and reload.
 * @param {any} fixture @returns {any} */
export function searchOptions(fixture) {
  return {
    fields: fixture.fields,
    searchOptions: fixture.options,
    extractField: (document, field) => {
      let value = document[field];
      for (const [entity, decoded] of Object.entries(fixture.normalization.htmlEntities))
        value = value.replaceAll(entity, decoded);
      return value;
    },
  };
}

/** Build the installed reference index; this is not a Jaren search engine.
 * @param {any} fixture @param {any[]} [documents] */
export function referenceSearch(fixture, documents = fixture.documents) {
  const index = new MiniSearch(searchOptions(fixture));
  index.addAll(documents);
  return index;
}

/** Run a DOM-free retained virtualizer with an explicit host adapter.
 * @param {any} profile @param {number} offset */
export function referenceGrid(profile, offset) {
  const virtualizer = new Virtualizer({
    count: profile.count, estimateSize: () => profile.estimateSize,
    overscan: profile.overscan, getItemKey: adoptionKey,
    getScrollElement: () => null, scrollToFn: () => {},
    observeElementRect: () => {}, observeElementOffset: () => {},
    initialRect: { width: 1024, height: profile.viewport }, initialOffset: offset,
  });
  const dispose = virtualizer._didMount();
  // Populate estimates before handing back the explicitly measured rows.
  virtualizer.getVirtualItems();
  for (const [index, size] of profile.sizes ?? []) virtualizer.resizeItem(index, size);
  return { virtualizer, dispose };
}
