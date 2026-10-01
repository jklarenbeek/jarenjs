//@ts-check
/**
 * @file The words a measured quantity is written with, as data beside the
 * unit registry: each alias names one registry unit. A reader of free text
 * (`'100 gram'`, `'1,5 kg'`, `'250ml'`) looks a word up here, then converts
 * through the registry, so an alias never carries a factor of its own.
 *
 * Aliases are matched case-insensitively, except a one-letter symbol,
 * which is read as written: `g`, `t` and `m` are a gram, a tonne and a
 * metre, while `G`, `T` and `M` are the SI prefixes giga, tera and mega;
 * `l` and `L` are both the litre. The list covers mass, volume, length and
 * area in English, Dutch and German spellings, the area and cubic symbols
 * with their digits (`m2`, `m²`, `m3`, `m³`); a host extends it by passing
 * a table of its own where a reader takes one. A word that names a
 * different thing in other places is left out rather than guessed: `ton`
 * is the metric tonne in Dutch and 907 kg in US English, `pound` is a
 * currency too, and `in` is a preposition before it is an inch.
 */

/**
 * Every alias, lower-cased, to its registry unit id.
 * @type {Readonly<Record<string, string>>}
 */
export const UNIT_ALIASES = Object.freeze(Object.assign(Object.create(null), {
  // mass
  mg: 'mg', milligram: 'mg', milligrams: 'mg', milligramme: 'mg', milligrammes: 'mg', milligramm: 'mg',
  g: 'g', gr: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g', gramm: 'g', grammen: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg', kilogramme: 'kg', kilogramm: 'kg',
  t: 't', tonne: 't', tonnes: 't',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb',
  // volume
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l', ltr: 'l',
  m3: 'm3', 'm³': 'm3',
  // length
  mm: 'mm', millimeter: 'mm', millimeters: 'mm', millimetre: 'mm', millimetres: 'mm',
  cm: 'cm', centimeter: 'cm', centimeters: 'cm', centimetre: 'cm', centimetres: 'cm',
  m: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm',
  km: 'km', kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km',
  inch: 'in', inches: 'in',
  ft: 'ft', foot: 'ft', feet: 'ft',
  // area
  cm2: 'cm2', 'cm²': 'cm2', m2: 'm2', 'm²': 'm2', km2: 'km2', 'km²': 'km2',
}));

/** The one-letter symbols, read as written (see above). */
const SYMBOLS = Object.freeze(Object.assign(Object.create(null),
  { g: 'g', t: 't', m: 'm', l: 'l', L: 'l' }));

/**
 * The registry unit an alias names, or undefined.
 * @param {string} word
 * @returns {string | undefined}
 * @example
 * unitOfAlias('Gram'); // 'g'
 * unitOfAlias('cm');   // 'cm'
 * unitOfAlias('G');    // undefined: giga, not a gram
 */
export function unitOfAlias(word) {
  if ([...word].length === 1) return SYMBOLS[word];
  return UNIT_ALIASES[word.toLowerCase()];
}
