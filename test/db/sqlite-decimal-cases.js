//@ts-check
/**
 * @file Decimals within a half-unit of a tie between two doubles, both sides
 * of it and on it, at many magnitudes and both signs, and what SQLite's own
 * text-to-double conversion reads each as: the significant digits that fit
 * its 64-bit accumulator — while it stays below (2^64 − 10) / 10, so 19 or
 * 20 of them — with the rest dropped, rounded to the nearest double. The
 * engine (`JSON.parse`) rounds every digit, so the two differ only where the
 * dropped digits decide a tie, and there SQLite's double is the engine's
 * neighbour nearer zero. Shared by the conversion pins on every SQLite host.
 */

const view = new DataView(new ArrayBuffer(8));

/** The double next to `x` (finite, or an infinity) nearer zero. @param {number} x @returns {number} */
export function towardZero(x) {
  view.setFloat64(0, Math.abs(x));
  view.setBigUint64(0, view.getBigUint64(0) - 1n);
  return Math.sign(x) * view.getFloat64(0);
}

/** `n / 10^f` as decimal text. @param {bigint} n @param {bigint} f @returns {string} */
function fixed(n, f) {
  const digits = String(n < 0n ? -n : n).padStart(Number(f) + 1, '0');
  const point = digits.length - Number(f);
  const fraction = digits.slice(point).replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${digits.slice(0, point)}${fraction === '' ? '' : `.${fraction}`}`;
}

/** The exact midpoint between the positive double `x` and the next one up, as `n / 10^f`.
 * @param {number} x @returns {{ n: bigint, f: bigint }} */
function midpointAbove(x) {
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const exponent = bits >> 52n, fraction = bits & ((1n << 52n) - 1n);
  const significand = exponent === 0n ? fraction : fraction | (1n << 52n);
  const power = (exponent === 0n ? 1n : exponent) - 1076n;
  const twice = 2n * significand + 1n;
  return power >= 0n ? { n: twice << power, f: 0n } : { n: twice * 5n ** -power, f: -power };
}

/**
 * The decimal texts: for each double, the midpoint above it, and one unit
 * of the 1st, 10th and 25th digit past that midpoint's last added and taken
 * away, each with both signs. The doubles: 2^60, 2^53, 0.1, 1.5, 1e23, the
 * least subnormal and normal doubles, the largest finite one's neighbour
 * below, and `count` more from a fixed sequence over integers, fractions and
 * bit patterns.
 * @param {number} count
 * @returns {string[]}
 */
export function nearTies(count) {
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const doubles = [2 ** 60, 2 ** 53, 0.1, 1.5, 1e23, 5e-324, 2 ** -1022, towardZero(Number.MAX_VALUE)];
  while (doubles.length < count + 8) {
    const kind = doubles.length % 3;
    if (kind === 0) doubles.push(Math.floor(next() * 2 ** 64));
    else if (kind === 1) doubles.push(next() * 10 ** Math.floor(next() * 40 - 20));
    else {
      view.setUint32(0, Math.floor(next() * 0x7fe00000));
      view.setUint32(4, Math.floor(next() * 2 ** 32));
      doubles.push(view.getFloat64(0));
    }
  }
  const texts = [];
  for (const x of doubles.filter((value) => value > 0)) {
    const { n, f } = midpointAbove(x);
    texts.push(fixed(n, f), fixed(-n, f));
    for (const places of [1n, 10n, 25n]) {
      const scale = 10n ** places;
      for (const shifted of [n * scale + 1n, n * scale - 1n]) texts.push(fixed(shifted, f + places), fixed(-shifted, f + places));
    }
  }
  return texts;
}

/**
 * Whether SQLite's JSON functions hand `text` back as a double it converted:
 * a fraction or an exponent, or an integer past the 64-bit ones (an integer
 * within them comes back as the INTEGER it names).
 * @param {string} text
 * @returns {boolean}
 */
export function convertedByJson(text) {
  if (/[.eE]/.test(text)) return true;
  const integer = BigInt(text);
  return integer < -(2n ** 63n) || integer >= 2n ** 63n;
}

/** The accumulator bound past which SQLite drops a decimal's digits: (2^64 − 10) / 10. */
const KEPT_BELOW = 1844674407370955160n;

/**
 * The decimal SQLite's conversion rounds: the significant digits of `text`
 * it keeps, as `digits` and a power of ten, and how many it dropped.
 * @param {string} text - a JSON number
 * @returns {{ kept: string, dropped: number }}
 */
export function sqliteDecimal(text) {
  const [, sign, whole, fraction = '', exponent = '0'] = /** @type {RegExpExecArray} */ (/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text));
  const digits = `${whole}${fraction}`.replace(/^0+/, '');
  let accumulator = 0n, taken = 0;
  while (taken < digits.length) {
    accumulator = accumulator * 10n + BigInt(digits.charCodeAt(taken) - 48);
    taken++;
    if (accumulator >= KEPT_BELOW) break;
  }
  const power = Number(exponent) - fraction.length + digits.length - taken;
  return { kept: `${sign}${digits.slice(0, taken) || '0'}e${power}`, dropped: digits.length - taken };
}

/**
 * What a host's conversion read each text as, against the engine and the
 * description: how many texts, how many it read as another double than the
 * engine, the texts whose reading the description misses, the differences
 * that are not the engine's neighbour nearer zero, and the texts it kept
 * every digit of yet read as another double.
 * @param {string[]} texts
 * @param {unknown[]} read - the host's double for each text
 */
export function conversionReport(texts, read) {
  const report = { cases: texts.length, differ: 0, notDescribed: /** @type {string[]} */ ([]),
    notNeighbour: /** @type {string[]} */ ([]), keptAllYetDiffer: /** @type {string[]} */ ([]) };
  texts.forEach((text, i) => {
    const engine = JSON.parse(text);
    const { kept, dropped } = sqliteDecimal(text);
    if (!Object.is(read[i], JSON.parse(kept))) report.notDescribed.push(text);
    if (Object.is(read[i], engine)) return;
    report.differ++;
    if (!Object.is(read[i], towardZero(engine))) report.notNeighbour.push(text);
    if (dropped === 0) report.keptAllYetDiffer.push(text);
  });
  return report;
}
