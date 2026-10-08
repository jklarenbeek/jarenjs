/** Hand-authored declarations for @jarenjs/db/bun (strategy 1). */
import type { Driver } from '@jarenjs/db';

/** The `bun:sqlite` binding; the builtin loads lazily inside open(). */
export declare function bunDriver(): Driver;
/** Adapt an already-constructed bun Database-shaped database. */
export declare function adaptBunDatabase(db: unknown): unknown;
/** Construct and adapt from a loaded `bun:sqlite`-shaped module. */
export declare function fromBunModule(mod: unknown, path: string, options?: unknown): unknown;

/** A copy of every page onto a new path through the connection's online backup
 * (a compacting `VACUUM INTO` without it), committed write-ahead log included,
 * as a rollback-journal file; page 1's header may differ. Refuses an existing
 * destination, a `file:` or `:memory:` name and an open transaction. */
export declare function snapshotDatabase(connection: unknown, target: string): Promise<{ path: string; pages: number }>;
