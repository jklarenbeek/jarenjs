//@ts-check
/** JSON snapshots and diagnostics shared by formula, migration and review compilers. */
import { cloneJson, deepFreeze } from '@jarenjs/core/object';
import { canonicalizeJson } from '../canonical.js';
import { CodedDocPathError } from '../errors.js';

/** A formula diagnosis includes the saved identity and the document location. */
export class FormulaError extends CodedDocPathError {
  constructor(code, reason, formulaId, docPath = '', cause = undefined) {
    super('FormulaError', code, `${formulaId}: ${reason}`, docPath, cause);
    this.formulaId = formulaId;
  }
}

/** Validate before copying: no dropped undefined, host objects or non-finite numbers. */
export function snapshot(value) {
  canonicalizeJson(value);
  return deepFreeze(cloneJson(value));
}

/** Positive finite work credit, never a promise of a same-thread deadline. */
export function credit(value, fallback, name) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}
