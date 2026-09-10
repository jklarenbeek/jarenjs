//@ts-check
/** Application text declarations over the resident ranker and reusable collection. */
import { compileLexical } from '@jarenjs/core/search';
import { createLexicalProvider } from '@jarenjs/json/query';
import { createArrayRangeProvider, createCollectionCoordinator } from '@jarenjs/app';
import { createDomRenderer } from '@jarenjs/view';
import { mountProviderCollection } from '@jarenjs/collection/component';

/** Searchable bounded collection; indexes, source rows and DOM handles remain private. */
export function mountLexicalDemo(host) {
  const document = host.ownerDocument, render = createDomRenderer(host, { document });
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `item-${String(i).padStart(4, '0')}`,
    title: ['Green tea', 'Café crème', '抹茶 緑茶', 'Grüner Tee'][i % 4], sku: String(i).padStart(8, '0'),
    barcode: String(i).padStart(13, '0'), type: 'drink', category: i % 2 ? 'coffee' : 'tea',
    categorySearch: i % 2 ? 'koffie café' : 'groene thee 日本 茶', sourceName: 'Demo', tags: i % 3 ? 'standard' : 'organic' }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const index = compileLexical({ version: 1, fields: ['title', 'sku', 'barcode', 'type', 'category', 'categorySearch', 'sourceName', 'tags'] }).create();
  index.rebuild(rows, { sourceRevision: 'demo-1' });
  const lexical = createLexicalProvider(index, { row: (id) => byId.get(id) });
  let disposed = false, version = 1, collection = null;
  render(['section', {},
    ['nav', { class: 'btn-row', 'aria-label': 'Collection examples' }, ['a', { class: 'btn', href: '#/collection' }, 'Array catalog']],
    ['p', {}, 'Search by name, identifier or tag. Prefixes and small typos are included; every word must match.'],
    ['label', {}, 'Search catalog ', ['input', { type: 'search', value: 'gren tea', 'aria-label': 'Search catalog', 'data-search-input': 'true' }]],
    ['label', {}, ' Sort ', ['select', { 'aria-label': 'Search sort', 'data-search-sort': 'true' }, ['option', { value: 'relevance' }, 'Relevance'], ['option', { value: 'sku' }, 'SKU']]],
    ['label', {}, ['input', { type: 'checkbox', 'aria-label': 'Organic only', 'data-search-organic': 'true' }], ' Organic only'],
    ['p', { role: 'status', 'data-search-status': 'true' }, 'Loading search…'],
    ['div', { 'data-search-host': 'true' }],
    ['p', {}, ['a', { href: '#/docs' }, 'Search contracts and measured compatibility are available in the package documentation.']],
  ]);
  const input = host.querySelector('[data-search-input]'), sort = host.querySelector('[data-search-sort]');
  const organic = host.querySelector('[data-search-organic]'), status = host.querySelector('[data-search-status]');
  const request = () => ({ facets: ['category'], where: organic.checked ? { $eq: ['$.tags', 'organic'] } : true,
    ...(sort.value === 'sku' ? { order: { field: 'sku', direction: 'asc' } } : {}) });
  const search = () => lexical.compile(request())(input.value);
  const initial = search();
  const provider = createArrayRangeProvider(initial.hits.map((hit) => byId.get(hit.id)), { query: 'catalog-search', snapshot: 'search-1' });
  const coordinator = createCollectionCoordinator(provider, { work: 256 });
  const report = (result) => { status.textContent = result.state === 'complete'
    ? `${result.total} matches · ${result.facets.category.map((facet) => `${facet.value}: ${facet.count}`).join(' · ')}`
    : `Search unavailable: ${result.reason}`; };
  collection = mountProviderCollection(host.querySelector('[data-search-host]'), coordinator,
    { height: 440, rowSize: 44, columnCount: 3, columnSize: 200, label: 'Search results',
      renderCell: (row, column) => [row.title, row.sku, row.tags][column] });
  report(initial);
  const change = () => {
    if (disposed) return;
    const result = search(); report(result);
    provider.replace(result.state === 'complete' ? result.hits.map((hit) => byId.get(hit.id)) : [], `search-${++version}`);
  };
  input.addEventListener('input', change); sort.addEventListener('change', change); organic.addEventListener('change', change);
  return { ready: Promise.resolve(), async dispose() {
    disposed = true; input.removeEventListener('input', change); sort.removeEventListener('change', change); organic.removeEventListener('change', change);
    render.destroy(); await collection.dispose(); index.dispose(); byId.clear(); rows.length = 0;
  } };
}
