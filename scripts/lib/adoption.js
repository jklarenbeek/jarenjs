//@ts-check
/** Deterministic, DOM-free synthetic application inputs shared by every host. */
import { mulberry32 } from '@jarenjs/core/random';

/**
 * Generate independently declared consumer data without reading a clock or IO.
 * Labels remain strings, including leading-zero identifiers and nullable facts.
 * @param {{ id: string, seed: number, rows: number, policy: { environment: string, protectedEvery: number, priceStep: number } }} consumer
 * @returns {Array<Record<string, any>>}
 */
export function adoptionRows(consumer) {
  const random = mulberry32(consumer.seed);
  return Array.from({ length: consumer.rows }, (_, index) => ({
    id: `${consumer.id}-${index}`,
    sku: String(index).padStart(8, '0'),
    barcode: String(index).padStart(13, '0'),
    title: ['Green tea', 'Café crème', '抹茶 緑茶', 'Grüner Tee'][index % 4],
    type: index % 5 === 0 ? 'part' : 'drink',
    category: index % 2 === 0 ? 'tea' : 'coffee',
    categorySearch: index % 2 === 0 ? 'groene thee 日本 茶' : 'koffie café',
    sourceName: consumer.policy.environment,
    tags: index % 3 === 0 ? 'organic' : 'standard',
    quantity: index % 7 === 0 ? null : Math.floor(random() * 1000),
    price: Math.floor(random() * 10000) * consumer.policy.priceStep,
    provenance: index % consumer.policy.protectedEvery === 0 ? 'manual' : null,
    revision: 1,
  }));
}

/** Stable identity shared by resident grids and bounded provider fixtures.
 * @param {number} index @returns {string} */
export function adoptionKey(index) { return `row-${index}`; }
