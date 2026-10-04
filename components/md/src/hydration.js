//@ts-check
/** Shared plugin hydration routing for the component and DOM renderer. */
import { walkAst } from './ast.js';
import { hashContent } from './utils.js';

/**
 * @typedef {{ plugin: any, node: any, value: string, ambiguous: boolean }} HydrationEntry
 * @typedef {Map<string, HydrationEntry>} HydrationIndex
 */

/**
 * Index nodes by the published plugin-name/content-hash markers. A hash
 * collision cannot identify a node from its DOM marker, so keep that bucket
 * ambiguous instead of handing a plugin another node's value.
 * @param {any} doc
 * @param {any} tables
 * @param {HydrationIndex} [index]
 * @returns {HydrationIndex}
 */
export function indexHydratable(doc, tables, index = new Map()) {
  if (tables.hydrates.size === 0) return index;
  walkAst(doc.ast ?? doc, (node) => {
    const plugin = tables.hydrates.get(node.type);
    if (plugin === undefined || typeof node.value !== 'string') return;
    const key = `${plugin.name}:${hashContent(node.value)}`;
    const previous = index.get(key);
    const ambiguous = previous !== undefined
      && (previous.ambiguous || previous.value !== node.value || previous.plugin !== plugin);
    index.set(key, { plugin, node, value: node.value, ambiguous });
  });
  return index;
}

/**
 * Remember each element's plugin and exact value independently of its hash.
 * Ambiguity is reported once per marker and may resolve on a later render.
 * @param {any} options
 * @returns {(container: any, index: HydrationIndex) => void}
 */
export function createHydrator(options) {
  /** @type {WeakMap<any, { key: string, plugin: any, value: string, ambiguous: boolean }>} */
  const hydrated = new WeakMap();
  const onHydrateError = options.onHydrateError
    // eslint-disable-next-line no-console -- the documented default sink
    ?? ((err) => console.error('md hydrate:', err));
  return (container, index) => {
    if (index.size === 0) return;
    for (const el of container.querySelectorAll('[data-md-hydrate]')) {
      const name = el.getAttribute('data-md-hydrate');
      const hash = el.getAttribute('data-md-hash') ?? '';
      const key = `${name}:${hash}`;
      const entry = index.get(key);
      if (entry === undefined) continue;
      const previous = hydrated.get(el);
      if (previous?.key === key && previous.ambiguous === entry.ambiguous
        && (entry.ambiguous || (previous.plugin === entry.plugin && previous.value === entry.value))) continue;
      hydrated.set(el, { key, plugin: entry.plugin, value: entry.value, ambiguous: entry.ambiguous });
      if (entry.ambiguous) {
        onHydrateError(new Error(`Ambiguous hydration identity for plugin '${name}' and content hash '${hash}'`));
        continue;
      }
      try {
        const result = entry.plugin.hydrate(el, entry.node, { options, hash: hashContent });
        if (result !== undefined && result !== null && typeof result.catch === 'function') {
          result.catch(onHydrateError);
        }
      }
      catch (err) {
        onHydrateError(err);
      }
    }
  };
}
