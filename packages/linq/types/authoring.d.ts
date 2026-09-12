import type { Expr } from './index.js';

/** A captured immutable JSON document; replacement preserves subclasses. */
export class DocumentBuilder<T extends object = Record<string, unknown>> {
  constructor(document: T);
  readonly schema: Readonly<T>;
  toJSON(): Readonly<T>;
  with(patch: Partial<T>): this;
}
/** Snapshot and freeze a JSON value; invalid JSON retains LinqBuildError codes. */
export function snapshot<T>(value: T): Readonly<T>;
/** Reject options outside the named closed boundary, then snapshot. */
export function optionsOf<T extends object>(value: T, keys: readonly string[], what: string): Readonly<T>;
/** Capture a query; undeclared external names retain JL0104 errors. */
export function captureQuery<T, E extends string>(what: string, externals: readonly E[],
  rule: (value: Expr<T>, externals: Record<E, unknown>) => unknown,
  options?: { advice?: (name: string) => string; fold?: boolean; noun?: string }): unknown;
