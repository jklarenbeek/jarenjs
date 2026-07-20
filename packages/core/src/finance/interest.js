//@ts-check
/**
 * @file Interest math (Part A-fin): simple and compound interest, nominal
 * ↔ effective rate conversion, and continuous compounding. All pure.
 */

/**
 * Simple interest accrued (not the total).
 * @param {number} principal @param {number} rate per period @param {number} time periods
 * @returns {number}
 */
export function simpleInterest(principal, rate, time) {
  return principal * rate * time;
}

/**
 * Compound amount (principal + interest) after `time` years compounded
 * `periodsPerYear` times per year.
 * @param {number} principal @param {number} annualRate @param {number} time years
 * @param {number} [periodsPerYear]
 * @returns {number}
 */
export function compoundAmount(principal, annualRate, time, periodsPerYear = 1) {
  return principal * Math.pow(1 + annualRate / periodsPerYear, periodsPerYear * time);
}

/**
 * Compound interest earned (amount − principal).
 * @param {number} principal @param {number} annualRate @param {number} time
 * @param {number} [periodsPerYear]
 * @returns {number}
 */
export function compoundInterest(principal, annualRate, time, periodsPerYear = 1) {
  return compoundAmount(principal, annualRate, time, periodsPerYear) - principal;
}

/**
 * Effective annual rate (APY/EAR) from a nominal annual rate compounded
 * `periodsPerYear` times.
 * @param {number} nominal @param {number} periodsPerYear
 * @returns {number}
 */
export function nominalToEffective(nominal, periodsPerYear) {
  return Math.pow(1 + nominal / periodsPerYear, periodsPerYear) - 1;
}

/**
 * Nominal annual rate from an effective annual rate.
 * @param {number} effective @param {number} periodsPerYear
 * @returns {number}
 */
export function effectiveToNominal(effective, periodsPerYear) {
  return periodsPerYear * (Math.pow(1 + effective, 1 / periodsPerYear) - 1);
}

/**
 * Continuously-compounded amount: `P·e^(rt)`.
 * @param {number} principal @param {number} annualRate @param {number} time
 * @returns {number}
 */
export function continuousCompound(principal, annualRate, time) {
  return principal * Math.exp(annualRate * time);
}
