/** Hand-authored declarations for @jarenjs/db/node (strategy 1). */
import type { Driver } from '@jarenjs/db';

export interface NodeOpenOptions {
  path?: string;
  timeout?: number;
  readOnly?: boolean;
}

/** The `node:sqlite` binding; the builtin loads lazily inside open(). */
export declare function nodeDriver(): Driver;
/** Adapt an already-constructed DatabaseSync-shaped database. */
export declare function adaptNodeDatabase(db: unknown): unknown;
/** Construct and adapt from a loaded `node:sqlite`-shaped module. */
export declare function fromNodeModule(mod: unknown, path: string, options?: NodeOpenOptions): unknown;
