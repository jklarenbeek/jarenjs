/** Hand-authored declarations for @jarenjs/db/bun (strategy 1). */
import type { Driver } from '@jarenjs/db';

/** The `bun:sqlite` binding; the builtin loads lazily inside open(). */
export declare function bunDriver(): Driver;
/** Adapt an already-constructed bun Database-shaped database. */
export declare function adaptBunDatabase(db: unknown): unknown;
/** Construct and adapt from a loaded `bun:sqlite`-shaped module. */
export declare function fromBunModule(mod: unknown, path: string, options?: unknown): unknown;
