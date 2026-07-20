//@ts-check
/**
 * @file Depreciation schedules (Part A-fin): straight-line,
 * declining-balance (double-declining when factor = 2) and
 * sum-of-years-digits. Each returns an array of per-period depreciation
 * amounts of length `life`.
 */

/**
 * Straight-line depreciation: equal charge each period.
 * @param {number} cost @param {number} salvage @param {number} life periods
 * @returns {number[]}
 */
export function straightLine(cost, salvage, life) {
  const per = (cost - salvage) / life;
  return Array.from({ length: life }, () => per);
}

/**
 * Declining-balance depreciation. `factor` = 2 is double-declining. Never
 * depreciates below salvage; the final periods absorb the remainder.
 * @param {number} cost @param {number} salvage @param {number} life
 * @param {number} [factor]
 * @returns {number[]}
 */
export function decliningBalance(cost, salvage, life, factor = 2) {
  const rate = factor / life;
  const out = [];
  let book = cost;
  for (let i = 0; i < life; i++) {
    let dep = book * rate;
    if (book - dep < salvage) dep = book - salvage;
    if (dep < 0) dep = 0;
    out.push(dep);
    book -= dep;
  }
  return out;
}

/**
 * Sum-of-years-digits depreciation.
 * @param {number} cost @param {number} salvage @param {number} life
 * @returns {number[]}
 */
export function sumOfYearsDigits(cost, salvage, life) {
  const syd = (life * (life + 1)) / 2;
  const base = cost - salvage;
  const out = [];
  for (let i = 0; i < life; i++) {
    const remaining = life - i;
    out.push(base * remaining / syd);
  }
  return out;
}
