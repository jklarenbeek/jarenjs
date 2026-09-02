/** Hand-authored declarations for @jarenjs/db/node (strategy 1). */
import type { Driver } from '@jarenjs/db';

export interface NodeOpenOptions {
  /** The busy timeout in milliseconds. */
  timeout?: number;
  readOnly?: boolean;
  /** How long work waits for an open transaction (`JD0012` after). */
  queueTimeout?: number;
}

/** The `node:sqlite` binding; the builtin loads lazily inside open(). */
export declare function nodeDriver(): Driver;
/** Adapt an already-constructed DatabaseSync-shaped database. `backup`
 * is the online-backup primitive triple (`copy`, `rename`, `remove`);
 * the connection declares the capability exactly when it is given. */
export declare function adaptNodeDatabase(db: unknown, options?: {
  queueTimeout?: number;
  backup?: { copy: Function; rename: Function; remove: Function };
}): unknown;
/** Construct and adapt from a loaded `node:sqlite`-shaped module. */
export declare function fromNodeModule(mod: unknown, path: string, options?: NodeOpenOptions): unknown;
