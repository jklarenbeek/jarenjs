//@ts-check
/**
 * `$format-number` against `Intl.NumberFormat`: the agreement figure for
 * QUERY-FORMAT §8.7 and FORMULA-FORMAT.
 *
 * The Dutch decimal format (`compileNumberLocale(nl)`) and the currency
 * picture `€ #.##0,00;€ -#.##0,00` — with the no-break space ICU puts after
 * the sign — format a seeded sample against
 * `Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' })`,
 * string for string. The sample mixes what prices look like (whole cents,
 * a third decimal ending in 5, the ties rounding decides), wide magnitudes
 * and plain integers, each sign; the edge cases ICU is known to treat
 * specially follow it. NaN and the infinities are recorded beside the
 * figure: F&O spells NaN without the prefix, ICU with it.
 *
 *   node benchmark/format-number.js           # print
 *   node benchmark/format-number.js --write   # and write format-number-result.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mulberry32 } from '@jarenjs/core/random';
import { compileJsonQuery } from '@jarenjs/json';
import { compileNumberLocale, nl } from '@jarenjs/locales';

const SEED = 20261001;
const SAMPLE = 60000;
const PICTURE = '€ #.##0,00;€ -#.##0,00';

const ours = compileJsonQuery({ '$format-number': ['$', PICTURE, 'nl'] },
  { decimalFormats: { nl: compileNumberLocale(nl).decimalFormat } });
const icu = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

const random = mulberry32(SEED);
/** One sampled value: the mixture the header names. */
function draw() {
  const kind = random();
  const sign = random() < 0.3 ? -1 : 1;
  if (kind < 0.35) return sign * Math.floor(random() * 1e8) / 100;                       // whole cents
  if (kind < 0.55) return sign * (Math.floor(random() * 1e6) * 10 + 5) / 1000;           // a third decimal of 5
  if (kind < 0.8) return sign * 10 ** (random() * 21 - 6) * (1 + random());               // 1e-6 … 1e15
  if (kind < 0.9) return sign * Math.floor(random() * 1e12);                              // integers
  return sign * 10 ** (random() * 600 - 300);                                             // the double's whole range
}

const EDGES = [0, -0, 0.5, -0.5, 0.005, 0.015, 0.125, 1.005, 1.015, 1.255, 2.675, 8.345, 1e-7, -1e-7,
  Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, 1e15 + 0.3, 1e21, -1e21, 1.5e300, Number.MAX_VALUE];

const values = [...Array.from({ length: SAMPLE }, draw), ...EDGES];
/** @type {Array<{ value: string, ours: string, intl: string }>} */
const differences = [];
for (const value of values) {
  const a = ours(value);
  const b = icu.format(value);
  if (a !== b) differences.push({ value: Object.is(value, -0) ? '-0' : String(value), ours: a, intl: b });
}
const symbols = Object.fromEntries([['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]]
  .map(([name, value]) => [name, { ours: ours(value), intl: icu.format(/** @type {number} */ (value)) }]));

const result = {
  format: 'jaren-format-number-agreement/1',
  runnerHash: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  runtime: { node: process.version, icu: process.versions.icu, unicode: process.versions.unicode, cldr: process.versions.cldr ?? null },
  seed: SEED, picture: PICTURE, locale: 'nl-NL', currency: 'EUR',
  values: values.length, sampled: SAMPLE, edges: EDGES.length,
  disagreements: differences.length,
  examples: differences.slice(0, 20),
  symbols,
};
if (process.argv.includes('--write')) writeFileSync(new URL('./format-number-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, examples: result.examples.slice(0, 8) }, null, 2));
