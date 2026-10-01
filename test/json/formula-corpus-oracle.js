//@ts-check
/**
 * @file The trusted runner of `formula-corpus.json`: a plant nursery's saved
 * columns and rules as statically reviewed JavaScript, and the helpers they
 * call. The formula translator never runs these; the corpus test does, to
 * produce the outputs each translation must agree with. Every body sits
 * between `// body:<id>` and `// end:<id>`, character for character the
 * fixture's `body` (a test compares them).
 */

/** Return it (or nothing) to leave a record as it is. */
export const LEAVE = Symbol('leave');

/** A value with the note that explains it. @param {any} value @param {any} text */
export function note(value, text) {
  return { noted: true, value, text: String(text ?? '') };
}

/** Whether a rule result is a noted value. @param {any} result */
export const isNoted = (result) => Boolean(result && typeof result === 'object' && result.noted === true);

/** A number from a number, or from a text holding one (a comma or a point before the decimals). @param {any} value */
function numberIn(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

const EURO = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

/** Cents as euro text, a dash for no amount. @param {any} cents */
export function euro(cents) {
  const n = numberIn(cents);
  return n == null ? '–' : EURO.format(n / 100);
}

/** To the nearest 5. @param {any} x */
export function nearest5(x) {
  const n = numberIn(x);
  return n == null ? null : Math.round(n / 5) * 5;
}

/** Up to a multiple of 5. @param {any} x */
export function upTo5(x) {
  const n = numberIn(x);
  return n == null ? null : Math.ceil(n / 5) * 5;
}

/** Raised by a percentage. @param {any} x @param {any} percent */
export function percentUp(x, percent) {
  const n = numberIn(x);
  const p = numberIn(percent);
  return n == null || p == null ? null : n * (1 + p / 100);
}

const MASS = { g: 1, gr: 1, gram: 1, grams: 1, kg: 1000, kilo: 1000, kilos: 1000 };
const VOLUME = { ml: 1, l: 1000, litre: 1000, liter: 1000 };

/** Grams in a size text ("75 g", "0,5 kg"); a bare number is grams. @param {any} text @param {Record<string, number>} units */
function measure(text, units) {
  if (text == null || text === '') return null;
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const m = /^\s*(\d+(?:,\d+)?)\s*([a-z]*)\.?\s*$/i.exec(String(text));
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (!m[2]) return n;
  const factor = units[m[2].toLowerCase()];
  return factor === undefined ? null : n * factor;
}

/** Grams of a weight; a volume is none. @param {any} text */
export const weightOf = (text) => measure(text, MASS);
/** Grams of a weight or a volume, 1 ml counted as 1 gram. @param {any} text */
export const massOf = (text) => measure(text, { ...MASS, ...VOLUME });

/** Text without its surrounding blanks; nothing for none. @param {any} value */
export function clean(value) {
  if (value === null || value === undefined) return null;
  const text = `${value}`.trim();
  return text || null;
}

/** A capital at the start of every word. @param {any} value */
export function capitalize(value) {
  const text = clean(value);
  return text === null ? null : text.replace(/(^|\s)(\p{L})/gu, (_all, space, letter) => space + letter.toUpperCase());
}

/** The character each entity of an imported list stands for. */
const ENTITY_CHARS = new Map([['&amp;', '&'], ['&egrave;', 'è'], ['&eacute;', 'é'], ['&euml;', 'ë'], ['&iuml;', 'ï'], ['&ouml;', 'ö']]);

/** An imported list repaired: a piece an import cut at an entity's ';' glued back on, entities spelled out, repeats dropped. @param {any} values */
export function tidyList(values) {
  if (!Array.isArray(values)) return [];
  const glued = values.map((v) => `${v ?? ''}`).reduce((/** @type {string[]} */ pieces, piece) => {
    const previous = pieces.at(-1);
    if (previous !== undefined && /&\w+$/.test(previous)) pieces[pieces.length - 1] = `${previous};${piece}`;
    else pieces.push(piece.trim());
    return pieces;
  }, []);
  return distinct(glued.map((text) => {
    let spelled = text;
    for (const [spelling, char] of ENTITY_CHARS) spelled = spelled.replaceAll(spelling, char);
    return spelled.trim();
  }));
}

/** The entries in first-seen order, blanks left out, one per spelling apart from letter case. @param {any} values */
export function distinct(values) {
  const kept = new Map();
  for (const value of [values].flat()) {
    const entry = typeof value === 'string' ? value.trim() : value;
    if (entry === null || entry === undefined || entry === '') continue;
    const fold = typeof entry === 'string' ? entry.toLowerCase() : JSON.stringify(entry);
    if (!kept.has(fold)) kept.set(fold, entry);
  }
  return [...kept.values()];
}

/** A web address part: marks removed, lower case, the words joined by dashes. @param {any} value */
export function toSlug(value) {
  const text = clean(value);
  if (text === null) return null;
  const words = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z0-9]/).filter(Boolean);
  return words.length ? words.join('-') : null;
}

/** The host helpers a translation calls through $call, by name. */
export const hostHelpers = { clean, capitalize, tidyList, distinct, toSlug };

/** The saved computed columns: one value per record. */
export const columns = {
  "price-gap": (record) => {
// body:price-gap
if (record.web?.listCents == null || record.till?.listCents == null) return null;
const gap = record.till.listCents - record.web.listCents;
return new Intl.NumberFormat('nl-NL', {
  style: 'currency',
  currency: 'EUR',
}).format(gap / 100);
// end:price-gap
  },
  "margin": (record) => {
// body:margin
// Margin per piece: the price without tax, less the cost.
// The vendor's cost is taken to exclude tax; the till knows the rate.
const ask = record.listCents;
const cost = record.vendor?.costCents;
const tax = record.till?.tax;
// a cost of 0 stands for: not known
if (ask == null || !cost || tax?.rate == null) return null;

const net = tax.inclusive ? ask / (1 + tax.rate / 100) : ask;
const left = (net - cost) / 100;
return left.toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
// end:margin
  },
  "margin-share": (record) => {
// body:margin-share
// Gross margin as a share of the price without tax.
const ask = record.listCents;
const cost = record.vendor?.costCents;
const tax = record.till?.tax;
// a cost of 0 stands for: not known
if (ask == null || !cost || tax?.rate == null) return null;

const net = tax.inclusive ? ask / (1 + tax.rate / 100) : ask;
if (net <= 0) return null;
const share = (net - cost) / net * 100;
return share.toLocaleString('nl-NL', { maximumFractionDigits: 1 }) + '%';
// end:margin-share
  },
  "price-per-100": (record) => {
// body:price-per-100
// Looks for an amount like "250 gm", "2 kg" or "50 cl"
// in the size text, the pack text or the name.
const texts = [record.sizeText, record.packText, record.caption];
const amountPattern = /(\d+(?:[.,]\d+)?)\s*(kgs?|gm|g|cl|litre|ml|l)\b/i;
const hit = texts.map((piece) => String(piece ?? '').match(amountPattern)).find(Boolean);
if (!hit || record.listCents == null) return null;

const unit = hit[2].toLowerCase();
let measured = Number(hit[1].replace(',', '.'));
if (['kg', 'kgs', 'litre', 'l'].includes(unit)) measured *= 1000;
if (!measured) return null;

const per100 = record.listCents / 100 / measured * 100;
const measure = ['litre', 'cl', 'ml', 'l'].includes(unit) ? 'ml' : 'g';
return per100.toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' }) + ' per 100 ' + measure;
// end:price-per-100
  },
  "restock": (record) => {
// body:restock
// Compares the till stock with its reorder level.
// A pack size rounds the advice up to whole packs.
const onHand = record.till?.onHand;
const level = record.till?.reorderAt;
if (onHand == null) return null;
if (!level) return onHand <= 0 ? 'Sold out' : null;
if (onHand > level) return 'No';

const short = level - onHand;
const pack = record.vendor?.packSize;
const order = pack ? Math.ceil(short / pack) * pack : short;
return 'Yes, ' + order + ' pieces';
// end:restock
  },
  "stock-value": (record) => {
// body:stock-value
// Stock times cost. A stock below zero counts as none.
const CEILING = 4000; // more is mostly a bulk or open-ended setting at the till
const onHand = record.till?.onHand;
const cost = record.vendor?.costCents;
if (onHand == null || !cost) return null;
if (onHand > CEILING) return 'check the stock';
// a cost above the price is mostly per crate or per kilo: the value would be off
const tax = record.till?.tax;
const netPrice = record.listCents != null && tax?.rate != null
  ? (tax.inclusive ? record.listCents / (1 + tax.rate / 100) : record.listCents) : null;
if (netPrice != null && cost > netPrice) return 'check the cost';

const worth = Math.max(0, onHand) * cost / 100;
return worth.toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
// end:stock-value
  },
  "gaps": (record) => {
// body:gaps
// Lists what the web shop still lacks.
const lacking = [];
if (!record.photo) lacking.push('photo');
if (!record.hasBlurb) lacking.push('blurb');
if (!record.shelfId) lacking.push('shelf');
if (!record.kind) lacking.push('kind');
if (!record.netGrams) lacking.push('weight');
if (!record.ean) lacking.push('ean');
return lacking.length ? lacking.join(', ') : 'complete';
// end:gaps
  },
  "sales-value": (record) => {
// body:sales-value
// Stock times the price without tax.
const CEILING = 4000; // more is mostly a bulk or open-ended setting at the till
const onHand = record.till?.onHand;
const tax = record.till?.tax;
if (onHand == null || record.listCents == null || tax?.rate == null) return null;
if (onHand > CEILING) return 'check the stock';

const netPrice = tax.inclusive ? record.listCents / (1 + tax.rate / 100) : record.listCents;
const worth = Math.max(0, onHand) * netPrice / 100;
return worth.toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
// end:sales-value
  },
  "profit-potential": (record) => {
// body:profit-potential
// What the present stock brings in when all of it sells at today's price:
// stock times (price without tax, less the cost).
const CEILING = 4000; // more is mostly a bulk or open-ended setting at the till
const onHand = record.till?.onHand;
const cost = record.vendor?.costCents;
const tax = record.till?.tax;
if (!onHand || onHand < 0 || !cost || record.listCents == null || tax?.rate == null) return null;
if (onHand > CEILING) return 'check the stock';

const netPrice = tax.inclusive ? record.listCents / (1 + tax.rate / 100) : record.listCents;
// a cost above the price is mostly a price per crate or per kilo
if (cost > netPrice) return 'check the cost';
const gain = onHand * (netPrice - cost) / 100;
return gain.toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
// end:profit-potential
  },
  "margin-flag": (record) => {
// body:margin-flag
// Set the bounds to your own policy.
const LOW = 25;   // percent
const WATCH = 40; // percent
const cost = record.vendor?.costCents;
const tax = record.till?.tax;
if (!cost || record.listCents == null || tax?.rate == null) return null;

const netPrice = tax.inclusive ? record.listCents / (1 + tax.rate / 100) : record.listCents;
const share = (netPrice - cost) / netPrice * 100;
// sorted descending, "loss?" leads, then "too low", "watch" and "fine";
// a loss is often a cost per crate or per kilo: check that first
if (share < 0) return 'loss?';
if (share < LOW) return 'too low';
if (share < WATCH) return 'watch';
return 'fine';
// end:margin-flag
  },
  "advised-price": (record) => {
// body:advised-price
// The price (with tax) that yields the target margin,
// rounded up to 10 cents.
const TARGET = 45; // percent of the price without tax
const cost = record.vendor?.costCents;
const tax = record.till?.tax;
if (!cost || tax?.rate == null) return null;

const net = cost / (1 - TARGET / 100);
const gross = tax.inclusive ? net * (1 + tax.rate / 100) : net;
const advice = Math.ceil(gross / 10) * 10;
return (advice / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
// end:advised-price
  },
  "advice-gap": (record) => {
// body:advice-gap
// Today's price less the advised one: below zero means "under the advice".
const TARGET = 45;
const cost = record.vendor?.costCents;
const tax = record.till?.tax;
if (!cost || record.listCents == null || tax?.rate == null) return null;

const net = cost / (1 - TARGET / 100);
const advice = Math.ceil((tax.inclusive ? net * (1 + tax.rate / 100) : net) / 10) * 10;
return ((record.listCents - advice) / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
// end:advice-gap
  },
  "retire-action": (record) => {
// body:retire-action
// Advice for items the till marks as retired.
if (!record.till?.retired) return null;
const onHand = record.till.onHand;
if (onHand == null) return 'Stock unknown: count first';
if (onHand < 0) return 'Stock below zero [' + onHand + ']: count first';
if (onHand > 0) {
  const cost = record.vendor?.costCents;
  const worth = cost ? ' [' + (onHand * cost / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' }) + ']' : '';
  return 'Sell off: ' + onHand + ' pieces' + worth;
}
if (record.state === 'live' && record.web) return 'Archive in the web shop';
if (record.state === 'live') return 'Archive';
return null; // archived or a draft already: nothing to do
// end:retire-action
  },
  "shop-refill": (record) => {
// body:shop-refill
// The shop is the store with a low mark; top it up to its high mark (or low mark)
// once its stock drops below the low mark, from the store that holds the most.
// When several stores have a low mark, the shop is mostly the one without an aisle.
const stores = record.till?.stores ?? [];
const marked = stores.filter((store) => store.low > 0);
const shop = marked.find((store) => !store.aisle) ?? marked[0];
if (!shop || shop.onHand == null || shop.onHand >= shop.low) return null;

const source = stores.filter((store) => store !== shop && store.onHand > 0)
  .sort((a, b) => b.onHand - a.onHand)[0];
const needed = (shop.high ?? shop.low) - shop.onHand;
if (!source) return needed + ' needed, none in stock';
const count = Math.min(needed, source.onHand);
const where = source.aisle ? ', aisle ' + source.aisle : '';
return count + ' from ' + source.place.split(' ')[0] + where;
// end:shop-refill
  },
  "label-ready": (record) => {
// body:label-ready
// What a shelf label and the till need to be filled in.
const lacking = [];
if (!record.tag?.style) lacking.push('label');
if (!record.ean) lacking.push('ean');
if (!record.packText && !/\d/.test(record.sizeText ?? '')) lacking.push('size');
if (!record.till?.shortName) lacking.push('till name');
if (record.listCents == null) lacking.push('price');
return lacking.length ? 'missing ' + lacking.join(', ') : 'yes';
// end:label-ready
  },
  "days-listed": (record) => {
// body:days-listed
// Days since the till first listed the item.
const since = record.till?.since;
if (!since) return null;
return Math.floor((Date.now() - new Date(since).getTime()) / 86400000);
// end:days-listed
  },
  "web-ready": (record) => {
// body:web-ready
// New items: what has to happen before the web shop?
const todo = [];
if (!record.photo) todo.push('photo');
if (!record.hasBlurb) todo.push('blurb');
if (!record.shelfId) todo.push('shelf');
if (record.listCents == null) todo.push('price');
if (!record.web) todo.push('list on the web');
return todo.length ? todo.join(', ') : 'yes';
// end:web-ready
  },
};

/** The saved rules: a value, a noted value, or LEAVE. */
export const rules = {
  "price-raise": (record) => {
// body:price-raise
const RAISE = 4; // 4 means 4% dearer, -8 is 8% cheaper

if (record.listCents == null) return LEAVE;
const fresh = nearest5(percentUp(record.listCents, RAISE));
return note(fresh, `${euro(record.listCents)} + ${RAISE}% → ${euro(fresh)}`);
// end:price-raise
  },
  "price-from-cost": (record) => {
// body:price-from-cost
const MARKUP = 2.2; // 2,2 means: price without tax = 2,2 × the cost

const cost = record.vendor?.costCents;
const tax = record.till?.tax;
if (!cost || tax?.rate == null) return LEAVE; // cost or tax rate unknown
const net = cost * MARKUP;
const fresh = upTo5(tax.inclusive ? net * (1 + tax.rate / 100) : net);
return note(fresh, `cost ${euro(cost)} × ${MARKUP} + ${tax.rate}% tax → ${euro(fresh)}`);
// end:price-from-cost
  },
  "price-steps": (record) => {
// body:price-steps
// weight in grams → price in cents
const STEPS = { 25: 150, 75: 290, 125: 410, 250: 760, 500: 1390 };

// The size is not in the same field everywhere: try the pack text, then the
// size text ("75gr.", "0,5kg."), then the net weight.
const size = weightOf(record.packText) ?? weightOf(record.sizeText) ?? record.netGrams;
if (!size) return LEAVE;
const price = STEPS[size];
if (price == null) return LEAVE;
return note(price, `${size} g on the price steps`);
// end:price-steps
  },
  "copy-till-price": (record) => {
// body:copy-till-price
// Copy only when the till has one valid price.
if (record.till?.listCents == null) return LEAVE;
if (record.till.priceCount > 1) return LEAVE; // conflicting prices
return record.till.listCents;
// end:copy-till-price
  },
  "net-weight": (record) => {
// body:net-weight
// For liquids, 1 ml counts as 1 gram.
const net = massOf(record.packText) ?? massOf(record.sizeText);
return net || LEAVE;
// end:net-weight
  },
  "pack-weight": (record) => {
// body:pack-weight
// tare per pack size in grams
const net = massOf(record.packText) ?? massOf(record.sizeText);
if (!net) return LEAVE;
const tare = net <= 120 ? 15 : net <= 250 ? 25 : 50;
return note(net + tare, `${net} g net + ${tare} g packing`);
// end:pack-weight
  },
  "customs-code": (record) => {
// body:customs-code
// kind → customs code (check the codes with your forwarder)
const TARIFFS = {
  Seeds: '120991',  // seeds for sowing
  Bulbs: '060110',  // bulbs, dormant
  Pots: '691200',   // ceramic pots
  Tools: '820190',  // hand tools
  Soil: '253090',   // potting soil
};
const tariff = TARIFFS[record.kind];
return tariff ? note(tariff, `kind ${record.kind}`) : LEAVE;
// end:customs-code
  },
  "caption-tidy": (record) => {
// body:caption-tidy
const caption = clean(record.caption);
if (caption == null) return LEAVE;
let tidy = caption.replace(/\s+/g, ' ');
// Only names written wholly in capitals (at least 5 letters).
const alpha = tidy.replace(/[^a-zA-Z\u00C0-\u024F]/g, '');
if (alpha.length >= 5 && alpha === alpha.toUpperCase()) tidy = capitalize(tidy.toLowerCase());
return tidy === caption ? LEAVE : tidy;
// end:caption-tidy
  },
  "aliases": (record) => {
// body:aliases
// tidyList also repairs earlier imports split at an entity, like "Cr&egrave" + "me".
const fromTill = record.till?.aliases ?? [];
const present = record.aliases ?? [];
if (fromTill.length === 0 && present.length === 0) return LEAVE;
const merged = tidyList([...present, ...fromTill]);
return merged.length === present.length && merged.every((alias, i) => alias === present[i]) ? LEAVE : merged;
// end:aliases
  },
  "labels-from-section": (record) => {
// body:labels-from-section
// '#roses' > '#red' becomes the labels 'roses' and 'red'.
const fromSection = (record.section?.trail ?? []).map((step) => step.replace(/^#/, ''));
if (fromSection.length === 0) return LEAVE;
return distinct([...(record.labels ?? []), ...fromSection]);
// end:labels-from-section
  },
  "till-text": (record) => {
// body:till-text
const caption = clean(record.caption);
if (caption == null) return LEAVE;
// "One size" is the web shop's name for an item without sizes.
const size = record.sizeText === 'One size' ? null : clean(record.sizeText);
const pack = clean(record.packText) ?? size;
return pack && !caption.toLowerCase().includes(pack.toLowerCase()) ? `${caption} ${pack}` : caption;
// end:till-text
  },
  "retire": (record) => {
// body:retire
// Archive only when every member meets every condition.
if (record.lineup.some(member => !member.retired
    || member.onHand !== 0 || member.webId)) return LEAVE;
return note('stored', 'Every member: retired at the till, no stock, not on the web');
// end:retire
  },
  "retire-online-report": (record) => {
// body:retire-online-report
// Archive these on the web, or order them again.
if (!record.lineup.some(member => member.webId)) return LEAVE; // not on the web
if (record.lineup.some(member => !member.retired)) return LEAVE;
if (record.lineup.some(member => member.onHand == null || member.onHand > 0)) return LEAVE;
return note('stored', 'Retired at the till, no stock, yet still live on the web');
// end:retire-online-report
  },
  "margin-floor-report": (record) => {
// body:margin-floor-report
const FLOOR = 25;          // report below this margin (%)
const TARGET = 40;         // the proposed price yields this margin (%)
const SHOW_LOSS = false;   // true: also costs above the price (often per crate or per kilo)

const cost = record.vendor?.costCents;
const tax = record.till?.tax;
if (!cost || record.listCents == null || tax?.rate == null) return LEAVE;
const uplift = tax.inclusive ? 1 + tax.rate / 100 : 1;
const net = record.listCents / uplift;
const share = (net - cost) / net * 100;
if (share >= FLOOR) return LEAVE;
if (share < 0 && !SHOW_LOSS) return LEAVE;
const advice = upTo5(cost / (1 - TARGET / 100) * uplift);
const why = `margin ${share.toFixed(1).replace('.', ',')}% (cost ${euro(cost)} at ${record.vendor.firm})`;
// A margin below zero is often a cost per crate or per kilo.
return note(advice, share < 0 ? `check the cost first: ${why}` : why);
// end:margin-floor-report
  },
  "step-drift-report": (record) => {
// body:step-drift-report
// the price steps of this class (grams → cents)
const STEPS = { 25: 150, 75: 290, 125: 410, 250: 760, 500: 1390 };
const size = weightOf(record.packText) ?? weightOf(record.sizeText) ?? record.netGrams;
if (!size) return LEAVE;
const due = STEPS[size];
if (due == null) return LEAVE;
if (record.listCents === due) return LEAVE;
return note(due, `${size} g should cost ${euro(due)}, listed at ${euro(record.listCents)}`);
// end:step-drift-report
  },
  "price-parity-report": (record) => {
// body:price-parity-report
const own = record.listCents;
const till = record.till?.listCents ?? null;
const web = record.web?.listCents ?? null;
if (till == null && web == null) return LEAVE;
if (own === till && own === web) return LEAVE;
return note(till ?? web, `own ${euro(own)} · till ${euro(till)} · web ${euro(web)}`);
// end:price-parity-report
  },
  "url-key-report": (record) => {
// body:url-key-report
// The web shop drops brackets and quotes without a dash: "(Mini)rake" → "minirake".
const plain = String(record.caption ?? '').replace(/[()"'´]/g, '').replace(/[åÅ]/g, 'a').replace(/[þÞ]/g, 'th').replace(/[œŒ]/g, 'oe');
const fresh = toSlug(plain);
if (fresh == null || record.urlKey == null) return LEAVE;
// The web shop adds "-1", "-2" to a repeated name; that is no drift.
if (record.urlKey.replace(/-\d+$/, '') === fresh) return LEAVE;
return fresh === record.urlKey ? LEAVE : fresh;
// end:url-key-report
  },
  "starter": (_record) => {
// body:starter
// Work out the new value for this field here.
// Return LEAVE to keep a record as it is.
return LEAVE;
// end:starter
  },
};
